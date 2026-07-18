import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class LocalFS {
  constructor(root) {
    this.root = root;
  }

  _abs(p) {
    return path.join(this.root, p);
  }

  async list(p) {
    const absPath = this._abs(p);
    const entries = await fs.readdir(absPath, { withFileTypes: true });
    return Promise.all(
      entries.map(async entry => {
        const rel = p ? path.join(p, entry.name) : entry.name;
        const stat = await fs.stat(this._abs(rel));
        return {
          name: entry.name,
          path: rel,
          type: entry.isDirectory() ? "directory" : "file",
          mtime: stat.mtimeMs,
          size: stat.size
        };
      })
    );
  }

  async read(p) {
    const absPath = this._abs(p);
    const stat = await fs.stat(absPath);
    const content = await fs.readFile(absPath);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    return {
      type: "file",
      content,
      mtime: stat.mtimeMs,
      size: stat.size,
      hash
    };
  }

  async write(p, { type, content, mtime }) {
    const absPath = this._abs(p);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    if (type === "directory") {
      await fs.mkdir(absPath, { recursive: true });
      return;
    }
    await fs.writeFile(absPath, content);
    if (mtime) {
      const atime = Date.now() / 1000;
      await fs.utimes(absPath, atime, mtime / 1000);
    }
  }

  async remove(p) {
    const absPath = this._abs(p);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat) return;
    if (stat.isDirectory()) {
      await fs.rm(absPath, { recursive: true, force: true });
    } else {
      await fs.unlink(absPath);
    }
  }

  async mkdir(p) {
    await fs.mkdir(this._abs(p), { recursive: true });
  }

  async walk(dir = "", excludes = []) {
    const results = [];
    const walkInternal = async (curr) => {
      if (excludes.some(exc => curr === exc || curr.startsWith(exc + "/"))) {
        return;
      }
      const abs = this._abs(curr);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) return;
      if (stat.isDirectory()) {
        const list = await this.list(curr);
        for (const item of list) {
          await walkInternal(item.path);
        }
      } else {
        const readData = await this.read(curr);
        results.push({
          path: curr,
          type: "file",
          mtime: readData.mtime,
          size: readData.size,
          hash: readData.hash
        });
      }
    };
    await walkInternal(dir);
    return results;
  }

  watch(onChange) {
    return fsSync.watch(this.root, { recursive: true }, (event, filename) => {
      if (filename) onChange(event, filename);
    });
  }
}
