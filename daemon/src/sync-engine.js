import { classify } from "./merge.js";

export class SyncEngine {
  constructor({ localFS, remoteBackend, baselineStore, excludes = [], ignoreRules = null }) {
    this.localFS = localFS;
    this.remoteBackend = remoteBackend;
    this.baselineStore = baselineStore;
    this.excludes = [
      "sample_data",
      "drive",
      ".config",
      ".colab",
      ".git",
      ...excludes
    ];
    this.ignoreRules = ignoreRules;
  }

  _isExcluded(p) {
    if (this.excludes.some(exc => p === exc || p.startsWith(exc + "/"))) {
      return true;
    }
    if (this.ignoreRules && this.ignoreRules(p)) {
      return true;
    }
    return false;
  }

  async walk(backend, dir = "") {
    if (this._isExcluded(dir)) return [];
    const results = [];
    const list = await backend.list(dir);
    for (const item of list) {
      if (this._isExcluded(item.path)) continue;
      if (item.type === "directory") {
        const sub = await this.walk(backend, item.path);
        results.push(...sub);
      } else {
        const baseMeta = this.baselineStore.get(item.path);
        if (baseMeta && baseMeta.mtime === item.mtime && baseMeta.size === item.size) {
          results.push({
            path: item.path,
            type: "file",
            mtime: item.mtime,
            size: item.size,
            hash: baseMeta.hash
          });
        } else {
          try {
            const readData = await backend.read(item.path);
            results.push({
              path: item.path,
              type: "file",
              mtime: readData.mtime,
              size: readData.size,
              hash: readData.hash
            });
          } catch {
            results.push({
              path: item.path,
              type: "file",
              mtime: item.mtime,
              size: item.size,
              hash: ""
            });
          }
        }
      }
    }
    return results;
  }

  async sync(direction = "both") {
    await this.baselineStore.load();
    const localList = await this.walk(this.localFS, "");
    const remoteList = await this.walk(this.remoteBackend, "");

    const localMap = new Map(localList.map(f => [f.path, f]));
    const remoteMap = new Map(remoteList.map(f => [f.path, f]));

    const allPaths = new Set([
      ...localMap.keys(),
      ...remoteMap.keys(),
      ...this.baselineStore.getAll().keys()
    ]);

    const counts = { pushed: 0, pulled: 0, deletedRemote: 0, deletedLocal: 0, conflicts: 0, bytesTransferred: 0, elapsedMs: 0 };
    const startTime = Date.now();

    for (const p of allPaths) {
      if (this._isExcluded(p)) continue;

      const base = this.baselineStore.get(p);
      const local = localMap.get(p);
      const remote = remoteMap.get(p);

      const decision = classify(base, local, remote);

      if ((decision === "push" || decision === "conflict-local") && (direction === "both" || direction === "push")) {
        const localData = await this.localFS.read(p);
        await this.remoteBackend.write(p, {
          type: "file",
          content: localData.content,
          mtime: localData.mtime
        });
        counts.bytesTransferred += Buffer.byteLength(localData.content);
        const updatedRemote = await this.remoteBackend.read(p);
        this.baselineStore.set(p, {
          hash: localData.hash,
          mtime: updatedRemote.mtime,
          size: localData.size
        });
        if (decision === "conflict-local") {
          counts.conflicts++;
        } else {
          counts.pushed++;
        }
      } else if (decision === "pull" && (direction === "both" || direction === "pull")) {
        const remoteData = await this.remoteBackend.read(p);
        await this.localFS.write(p, {
          type: "file",
          content: remoteData.content,
          mtime: remoteData.mtime
        });
        counts.bytesTransferred += Buffer.byteLength(remoteData.content);
        const updatedLocal = await this.localFS.read(p);
        this.baselineStore.set(p, {
          hash: remoteData.hash,
          mtime: remoteData.mtime,
          size: remoteData.size
        });
        counts.pulled++;
      } else if (decision === "delete-remote" && (direction === "both" || direction === "push")) {
        await this.remoteBackend.remove(p).catch(() => {});
        this.baselineStore.remove(p);
        counts.deletedRemote++;
      } else if (decision === "delete-local" && (direction === "both" || direction === "pull")) {
        await this.localFS.remove(p).catch(() => {});
        this.baselineStore.remove(p);
        counts.deletedLocal++;
      } else if (decision === "none" && local && remote) {
        if (!base || base.hash !== local.hash) {
          this.baselineStore.set(p, {
            hash: local.hash,
            mtime: remote.mtime,
            size: local.size
          });
        }
      }
    }
    await this.baselineStore.save();
    counts.elapsedMs = Date.now() - startTime;
    return counts;
  }
}
