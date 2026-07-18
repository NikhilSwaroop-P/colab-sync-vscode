import crypto from "node:crypto";

export class ColabContentsBackend {
  constructor(runtime, root = "content") {
    this.rt = runtime;
    this.root = root;
    this._rootEnsured = false;
  }

  async ensureRoot() {
    if (this._rootEnsured) return;
    const parts = this.root.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      try {
        await this.rt.getContent(current, { content: 0 });
      } catch (e) {
        if (e.message && e.message.includes("404")) {
          try {
            await this.rt.putContent(current, { type: "directory" });
          } catch {}
        }
      }
    }
    this._rootEnsured = true;
  }

  _abs(p) {
    return p ? `${this.root}/${p}` : this.root;
  }

  _rel(p) {
    if (p === this.root) return "";
    const prefix = `${this.root}/`;
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
  }

  async list(path) {
    await this.ensureRoot();
    try {
      const res = await this.rt.getContent(this._abs(path), { content: 1 });
      if (res.type !== "directory") {
        throw new Error(`Path ${path} is not a directory`);
      }
      return (res.content || []).map(item => ({
        name: item.name,
        path: this._rel(item.path),
        type: item.type,
        mtime: item.last_modified ? new Date(item.last_modified).getTime() : 0,
        size: item.size || 0
      }));
    } catch (e) {
      if (e.message && e.message.includes("404")) {
        return [];
      }
      throw e;
    }
  }

  async read(path) {
    await this.ensureRoot();
    const res = await this.rt.getContent(this._abs(path), { content: 1 });
    if (res.type !== "file") {
      throw new Error(`Path ${path} is not a file`);
    }
    let data = res.content || "";
    let format = res.format || "text";
    let buffer;
    if (format === "base64") {
      buffer = Buffer.from(data, "base64");
    } else {
      buffer = Buffer.from(data, "utf8");
    }
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    return {
      type: "file",
      content: buffer,
      mtime: res.last_modified ? new Date(res.last_modified).getTime() : 0,
      size: res.size || 0,
      hash
    };
  }

  async write(path, { type, content, mtime }) {
    await this.ensureRoot();
    if (type === "directory") {
      await this.rt.putContent(this._abs(path), { type: "directory" });
      return;
    }
    const parts = path.split("/");
    if (parts.length > 1) {
      let current = "";
      for (let i = 0; i < parts.length - 1; i++) {
        current = current ? `${current}/${parts[i]}` : parts[i];
        try {
          await this.rt.getContent(this._abs(current), { content: 0 });
        } catch (e) {
          if (e.message && e.message.includes("404")) {
            try {
              await this.rt.putContent(this._abs(current), { type: "directory" });
            } catch {}
          }
        }
      }
    }
    let format = "text";
    let encoded = content.toString("utf8");
    const isBinary = content.includes(0);
    if (isBinary) {
      format = "base64";
      encoded = content.toString("base64");
    }
    await this.rt.putContent(this._abs(path), {
      type: "file",
      format,
      content: encoded
    });
  }

  async remove(path) {
    await this.ensureRoot();
    await this.rt.deleteContent(this._abs(path));
  }

  async mkdir(path) {
    await this.ensureRoot();
    await this.rt.putContent(this._abs(path), { type: "directory" });
  }
}

export class InMemoryBackend {
  constructor() {
    this.files = new Map();
    this.dirs = new Set([""]);
  }

  async list(path) {
    const prefix = path ? path + "/" : "";
    const results = [];
    for (const d of this.dirs) {
      if (d && d.startsWith(prefix) && d !== path) {
        const sub = d.slice(prefix.length);
        if (!sub.includes("/")) {
          results.push({ name: sub, path: d, type: "directory", mtime: 0, size: 0 });
        }
      }
    }
    for (const [p, f] of this.files.entries()) {
      if (p.startsWith(prefix)) {
        const sub = p.slice(prefix.length);
        if (!sub.includes("/")) {
          results.push({
            name: sub,
            path: p,
            type: "file",
            mtime: f.mtime,
            size: f.content.length
          });
        }
      }
    }
    return results;
  }

  async read(path) {
    const f = this.files.get(path);
    if (!f) throw new Error(`File not found: ${path}`);
    const hash = crypto.createHash("sha256").update(f.content).digest("hex");
    return {
      type: "file",
      content: f.content,
      mtime: f.mtime,
      size: f.content.length,
      hash
    };
  }

  async write(path, { type, content, mtime }) {
    if (type === "directory") {
      this.dirs.add(path);
      return;
    }
    const parent = path.substring(0, path.lastIndexOf("/"));
    if (parent) this.dirs.add(parent);
    this.files.set(path, { content, mtime: mtime || Date.now() });
  }

  async remove(path) {
    if (this.files.has(path)) {
      this.files.delete(path);
      return;
    }
    if (this.dirs.has(path)) {
      this.dirs.delete(path);
      const prefix = path + "/";
      for (const d of this.dirs) {
        if (d.startsWith(prefix)) this.dirs.delete(d);
      }
      for (const p of this.files.keys()) {
        if (p.startsWith(prefix)) this.files.delete(p);
      }
    }
  }

  async mkdir(path) {
    this.dirs.add(path);
  }
}
