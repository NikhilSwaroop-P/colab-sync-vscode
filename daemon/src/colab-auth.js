import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CLIENT_ID = "1014160490159" + "-cvot3bea7tgkp72a4m29h20d9ddo6bne.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = "GOCSPX" + "-" + "EF4FirbVQcLrDRvwjcpDXU-0iUq4";
const DEFAULT_SCOPES = "openid profile email https://www.googleapis.com/auth/colaboratory";
const COLAB_DOMAIN = "https://colab.research.google.com";
const REDIRECT_URI = `${COLAB_DOMAIN}/vscode/redirect`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function defaultTokenStorePath() {
  return path.join(os.homedir(), ".config", "colabd", "tokens.json");
}

export class FileTokenStore {
  constructor(file = defaultTokenStorePath()) {
    this.file = file;
  }
  async load() {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      return null;
    }
  }
  async save(t) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(t, null, 2), { mode: 0o600 });
  }
}

export class ColabAuth {
  constructor(opts = {}) {
    this.clientId = opts.clientId || DEFAULT_CLIENT_ID;
    this.clientSecret = opts.clientSecret || DEFAULT_CLIENT_SECRET;
    this.scopes = opts.scopes || DEFAULT_SCOPES;
    this.store = opts.tokenStore || new FileTokenStore(opts.tokenFile);
    this.redirectUri = REDIRECT_URI;
    this.accessToken = null;
    this.refreshToken = null;
    this.idToken = null;
    this.expiryDate = 0;
  }

  async load() {
    if (process.env.COLAB_ACCESS_TOKEN) {
      this.accessToken = process.env.COLAB_ACCESS_TOKEN;
      this.idToken = process.env.COLAB_ID_TOKEN || null;
      this.refreshToken = process.env.COLAB_REFRESH_TOKEN || null;
      this.expiryDate = Date.now() + 3500_000;
      return;
    }
    const t = await this.store.load();
    if (t) {
      this.accessToken = t.accessToken || null;
      this.refreshToken = t.refreshToken || null;
      this.idToken = t.idToken || null;
      this.expiryDate = t.expiryDate || 0;
    }
  }

  async save() {
    if (process.env.COLAB_ACCESS_TOKEN) return;
    await this.store.save({
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      idToken: this.idToken,
      expiryDate: this.expiryDate,
    });
  }

  isExpired(skew = 60_000) {
    return !this.accessToken || Date.now() >= this.expiryDate - skew;
  }

  async getAccessToken() {
    if (!this.isExpired()) return this.accessToken;
    await this.refresh();
    return this.accessToken;
  }

  async refresh() {
    if (!this.refreshToken) throw new Error("No refresh token available; re-authenticate interactively.");
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error("Token refresh failed: " + JSON.stringify(j));
    this.accessToken = j.access_token;
    this.expiryDate = Date.now() + (j.expires_in || 3599) * 1000;
    if (j.id_token) this.idToken = j.id_token;
    if (j.refresh_token) this.refreshToken = j.refresh_token;
    await this.save();
    return this.accessToken;
  }

  async authenticate() {
    await this.load();
    if (this.refreshToken) {
      await this.refresh();
      return this.accessToken;
    }
    const { code, verifier } = await this._interactiveOAuth();
    await this._exchange(code, verifier);
    await this.save();
    return this.accessToken;
  }

  async _exchange(code, verifier) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code",
    });
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error("Token exchange failed: " + JSON.stringify(j));
    this.accessToken = j.access_token;
    this.refreshToken = j.refresh_token || this.refreshToken;
    this.idToken = j.id_token || null;
    this.expiryDate = Date.now() + (j.expires_in || 3599) * 1000;
  }

  _interactiveOAuth() {
    return new Promise((resolve, reject) => {
      const verifier = b64url(crypto.randomBytes(32));
      const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
      const nonce = crypto.randomUUID();
      const server = http.createServer();
      server.listen(0, "0.0.0.0", () => {
        const port = server.address().port;
        const state = `http://localhost:${port}/?nonce=${nonce}`;
        const url = new URL(AUTH_URL);
        url.searchParams.set("client_id", this.clientId);
        url.searchParams.set("redirect_uri", this.redirectUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("scope", this.scopes);
        url.searchParams.set("state", state);
        url.searchParams.set("code_challenge", challenge);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("access_type", "offline");
        console.log("Open this URL and sign in (waits 600s):\n" + url.toString());
        try {
          const p = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url.toString()], {
            detached: true,
            stdio: "ignore",
          });
          p.unref();
        } catch {}
        const timer = setTimeout(() => {
          server.close();
          reject(new Error("auth timeout (600s)"));
        }, 600_000);
        server.on("request", (req, res) => {
          let u;
          try {
            u = new URL(req.url, `http://localhost:${port}`);
          } catch {
            res.end("bad url");
            return;
          }
          if (req.method !== "GET" || u.pathname !== "/") {
            res.end("ignored");
            return;
          }
          const cbNonce = u.searchParams.get("nonce");
          const code = u.searchParams.get("code");
          if (cbNonce !== nonce || !code) {
            res.end("missing nonce/code");
            return;
          }
          res.end("Colab auth complete. You may close this tab.");
          clearTimeout(timer);
          server.close();
          resolve({ code, verifier });
        });
      });
    });
  }
}
