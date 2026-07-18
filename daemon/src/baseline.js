import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
export class BaselineStore {
  constructor(endpoint, rootPath = null) {
    this.endpoint = endpoint;
    if (rootPath) {
      this.file = path.join(rootPath, ".colab", `baseline-${endpoint}.json`);
    } else {
      this.file = path.join(os.homedir(), ".config", "colabd", `baseline-${endpoint}.json`);
    }
    this.data = new Map();
  }

  async load() {
    try {
      const content = await fs.readFile(this.file, "utf8");
      const obj = JSON.parse(content);
      this.data = new Map(Object.entries(obj));
    } catch {
      this.data = new Map();
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const obj = Object.fromEntries(this.data);
    await fs.writeFile(this.file, JSON.stringify(obj, null, 2), "utf8");
  }

  get(p) {
    return this.data.get(p);
  }

  set(p, meta) {
    this.data.set(p, meta);
  }

  remove(p) {
    this.data.delete(p);
  }

  getAll() {
    return this.data;
  }
}
