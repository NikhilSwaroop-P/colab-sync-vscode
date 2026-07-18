import crypto from "node:crypto";

const GAPI_DOMAIN = "https://colab.pa.googleapis.com";
const COLAB_DOMAIN = "https://colab.research.google.com";

function parseGoogleJson(text) {
  let s = text.trim();
  if (s.startsWith(")]}'")) s = s.slice(4).trim();
  return JSON.parse(s);
}

function nbh(serverId) {
  return serverId.replace(/-/g, "_") + ".".repeat(44 - serverId.length);
}

export class ColabRuntime {
  constructor({ auth, gapiDomain = GAPI_DOMAIN, colabDomain = COLAB_DOMAIN } = {}) {
    this.auth = auth;
    this.gapiDomain = gapiDomain;
    this.colabDomain = colabDomain;
    this.baseUrl = null;
    this.proxyToken = null;
    this.endpoint = null;
    this.assignment = null;
    this.onError = null;
    this._keepAliveTimer = null;
  }

  _runtimeHeaders(extra = {}) {
    return { ...extra, "X-Colab-Runtime-Proxy-Token": this.proxyToken };
  }

  async _bearer() {
    return this.auth.getAccessToken();
  }

  async listAssignments() {
    const r = await fetch(`${this.gapiDomain}/v1/assignments`, {
      headers: { Authorization: `Bearer ${await this._bearer()}` },
    });
    if (!r.ok) throw new Error(`listAssignments status ${r.status}`);
    return parseGoogleJson(await r.text());
  }

  _pickActive(resp) {
    const list = resp?.assignments || [];
    for (const a of list) {
      const info = a.runtimeProxyInfo;
      if (info && info.url && info.token) {
        return { baseUrl: info.url, token: info.token, assignment: a };
      }
    }
    return null;
  }

  async reuseAssignment() {
    const resp = await this.listAssignments();
    const active = this._pickActive(resp);
    if (active) {
      this.baseUrl = active.baseUrl;
      this.proxyToken = active.token;
      this.assignment = active.assignment;
      this.endpoint = active.assignment?.endpoint || null;
      return true;
    }
    return false;
  }

  async claim({ variant = "DEFAULT", accelerator = null, shape = 0, version = null } = {}) {
    const serverId = crypto.randomUUID();
    const url = new URL("/tun/m/assign", this.colabDomain);
    url.searchParams.set("nbh", nbh(serverId));
    url.searchParams.set("authuser", "0");
    if (variant !== "DEFAULT") url.searchParams.set("variant", variant);
    if (accelerator) url.searchParams.set("accelerator", accelerator);
    if (shape) url.searchParams.set("shape", String(shape));
    if (version) url.searchParams.set("runtime_version_label", version);
    const headers = {
      Authorization: `Bearer ${await this._bearer()}`,
      "X-Colab-Tunnel": "Google",
      "X-Colab-Client-Agent": "vscode",
      "X-Colab-VS-Code-App-Name": "Visual Studio Code",
      "X-Colab-VS-Code-Extension-Version": "0.8.1",
    };
    const g = await fetch(url, { headers, redirect: "manual" });
    const gtext = await g.text();
    if (g.status !== 200) {
      throw new Error(`GET /assign status ${g.status}: ${gtext.slice(0, 200)}`);
    }
    const gj = parseGoogleJson(gtext);
    if ("token" in gj && !("endpoint" in gj || "url" in gj)) {
      gj.xsrfToken = gj.token;
    }
    let endpoint, token, baseUrl;
    if ("xsrfToken" in gj) {
      const p = await fetch(url, {
        method: "POST",
        headers: { ...headers, "X-Goog-Colab-Token": gj.xsrfToken },
        redirect: "manual",
      });
      const ptext = await p.text();
      if (p.status !== 200) {
        throw new Error(`POST /assign status ${p.status}: ${ptext.slice(0, 200)}`);
      }
      const pj = parseGoogleJson(ptext);
      endpoint = pj.endpoint;
      token = pj.runtimeProxyInfo?.token ?? pj.token;
      baseUrl = pj.runtimeProxyInfo?.url;
    } else {
      endpoint = gj.endpoint ?? gj.url;
      token = gj.runtimeProxyInfo?.token ?? gj.token;
      baseUrl = gj.runtimeProxyInfo?.url;
    }
    if (!token) {
      throw new Error("No token: " + JSON.stringify({ endpoint, token, gj }));
    }
    if (!baseUrl) {
      if (!endpoint) {
        throw new Error("No endpoint: " + JSON.stringify({ endpoint, gj }));
      }
      baseUrl = endpoint.startsWith("http") ? endpoint : `https://${endpoint}`;
    }
    this.baseUrl = baseUrl;
    this.proxyToken = token;
    this.endpoint = endpoint;
    this.assignment = gj;
    return this.baseUrl;
  }

  async connect({ provision = false, provisionOpts = {} } = {}) {
    if (await this.reuseAssignment()) return { baseUrl: this.baseUrl, reused: true };
    if (provision) {
      await this.claim(provisionOpts);
      return { baseUrl: this.baseUrl, reused: false };
    }
    throw new Error(
      "No active Colab runtime to reuse. Pass {provision:true} to claim a new one (requires a Colab web session; bare OAuth may 401 on colab.research.google.com)."
    );
  }

  async getUserInfo() {
    const r = await fetch(`${this.gapiDomain}/v1/user-info?get_ccu_consumption_info=true`, {
      headers: { Authorization: `Bearer ${await this._bearer()}` },
    });
    if (!r.ok) throw new Error(`getUserInfo status ${r.status}`);
    return r.json();
  }

  async keepAlive() {
    if (!this.endpoint) throw new Error("not connected");
    const url = new URL(`/tun/m/${this.endpoint}/keep-alive/`, this.colabDomain);
    url.searchParams.set("authuser", "0");
    return fetch(url, {
      headers: {
        Authorization: `Bearer ${await this._bearer()}`,
        "X-Colab-Tunnel": "Google",
      },
    });
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this._kaRunning = true;
    const loop = async () => {
      while (this._kaRunning) {
        try {
          const r = await this.keepAlive();
          this._lastKeepAliveStatus = r.status;
        } catch (e) {
          if (this._kaRunning && this.onError) this.onError(e);
        }
        if (!this._kaRunning) break;
        await new Promise((res) => setTimeout(res, 2000));
      }
    };
    loop();
  }

  stopKeepAlive() {
    this._kaRunning = false;
  }

  async getContent(path = "", { content = 1 } = {}) {
    const u = new URL(`/api/contents/${path}`, this.baseUrl);
    u.searchParams.set("content", String(content));
    const r = await fetch(u, { headers: this._runtimeHeaders() });
    if (!r.ok) {
      throw new Error(`getContent ${path} status ${r.status}: ${await r.text().catch(() => "")}`);
    }
    return r.json();
  }

  async putContent(path, { type = "file", format = "text", content = "", mimetype = null } = {}) {
    const u = new URL(`/api/contents/${path}`, this.baseUrl);
    const body = { type, format, content };
    if (mimetype) body.mimetype = mimetype;
    const r = await fetch(u, {
      method: "PUT",
      headers: { ...this._runtimeHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      throw new Error(`putContent ${path} status ${r.status}: ${await r.text().catch(() => "")}`);
    }
    return r.json();
  }

  async deleteContent(path) {
    const u = new URL(`/api/contents/${path}`, this.baseUrl);
    const r = await fetch(u, { method: "DELETE", headers: this._runtimeHeaders() });
    if (!r.ok) {
      throw new Error(`deleteContent ${path} status ${r.status}: ${await r.text().catch(() => "")}`);
    }
    return r.status;
  }

  async renameContent(path, newPath) {
    const u = new URL(`/api/contents/${path}`, this.baseUrl);
    const r = await fetch(u, {
      method: "PATCH",
      headers: { ...this._runtimeHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ path: newPath }),
    });
    if (!r.ok) {
      throw new Error(`renameContent ${path} status ${r.status}: ${await r.text().catch(() => "")}`);
    }
    return r.json();
  }

  mkdir(path) {
    return this.putContent(path, { type: "directory" });
  }

  async unassign(endpoint = this.endpoint) {
    if (!endpoint) throw new Error("not connected / no endpoint to unassign");
    this.stopKeepAlive();
    const unassignUrl = new URL(`/tun/m/unassign/${endpoint}`, this.colabDomain);
    unassignUrl.searchParams.set("authuser", "0");
    const headers = {
      Authorization: `Bearer ${await this._bearer()}`,
      "X-Colab-Client-Agent": "vscode",
      "X-Colab-VS-Code-App-Name": "Visual Studio Code",
      "X-Colab-VS-Code-Extension-Version": "0.8.1",
    };
    const tokenRes = await fetch(unassignUrl, {
      headers: { ...headers, "Accept": "application/json" },
      redirect: "manual",
    });
    const tokenText = await tokenRes.text();
    if (tokenRes.status !== 200) {
      throw new Error(`GET /unassign/${endpoint} status ${tokenRes.status}: ${tokenText}`);
    }
    const tokenJson = parseGoogleJson(tokenText);
    const postRes = await fetch(unassignUrl, {
      method: "POST",
      headers: {
        ...headers,
        "X-Goog-Colab-Token": tokenJson.token,
      },
      redirect: "manual",
    });
    if (postRes.status !== 200 && postRes.status !== 204) {
      throw new Error(`POST /unassign/${endpoint} status ${postRes.status}: ${await postRes.text()}`);
    }
    this.baseUrl = null;
    this.proxyToken = null;
    this.assignment = null;
    this.endpoint = null;
    return postRes.status;
  }

  async getResources() {
    if (!this.baseUrl || !this.proxyToken) return null;
    try {
      const url = new URL("api/colab/resources", this.baseUrl);
      const r = await fetch(url, { headers: this._runtimeHeaders() });
      if (!r.ok) return null;
      return parseGoogleJson(await r.text());
    } catch (err) {
      console.error("fetch resources error:", err);
      return null;
    }
  }

  openTerminal() {
    const wsUrl = new URL("/colab/tty", this.baseUrl.replace("https:", "wss:"));
    return new WebSocket(wsUrl, { headers: this._runtimeHeaders() });
  }
}
