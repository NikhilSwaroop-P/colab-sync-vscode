import { classify } from "./merge.js";
import { execOnColab } from "./github-sync.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
const execFileAsync = promisify(execFile);


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

  async sync(direction = "both", onProgress = null) {
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

    const tasks = [];
    for (const p of allPaths) {
      if (this._isExcluded(p)) continue;
      const base = this.baselineStore.get(p);
      const local = localMap.get(p);
      const remote = remoteMap.get(p);
      const decision = classify(base, local, remote);
      tasks.push({ p, decision, base, local, remote });
    }

    const pushTasks = tasks.filter(t => (t.decision === "push" || t.decision === "conflict-local") && (direction === "both" || direction === "push"));
    const handledByBatch = new Set();

    if (pushTasks.length > 5 && this.remoteBackend.rt) {
      if (onProgress) onProgress({ action: "batch-push", path: `Zipping ${pushTasks.length} files...` });
      try {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "colabsync-"));
        const tarPath = path.join(tmpDir, "sync.tar.gz");
        const contentDir = path.join(tmpDir, "content");
        
        let batchBytes = 0;
        for (let i = 0; i < pushTasks.length; i++) {
          const t = pushTasks[i];
          if (!t.local || t.local.type === "directory") continue;
          
          if (onProgress) {
             const pct = Math.floor(((i + 1) / pushTasks.length) * 100);
             onProgress({ action: "batch-pack", path: `[${pct}%] ${t.p}` });
          }

          const localData = await this.localFS.read(t.p);
          const dest = path.join(contentDir, t.p);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, localData.content);
          batchBytes += Buffer.byteLength(localData.content);
        }
        
        await execFileAsync("tar", ["-czf", tarPath, "-C", contentDir, "."]);
        const tarContent = await fs.readFile(tarPath);
        
        if (onProgress) onProgress({ action: "batch-push", path: `Uploading archive (${(tarContent.length / 1024).toFixed(1)} KB)...` });
        
        const tarBase64 = tarContent.toString("base64");
        await this.remoteBackend.write(".colab-sync.tar.gz.b64", {
          type: "file",
          content: Buffer.from(tarBase64, "utf8"),
          mtime: Date.now()
        });
        
        if (onProgress) onProgress({ action: "batch-extract", path: `Extracting archive on Colab...` });
        let extCount = 0;
        const remoteTargetDir = `/${this.remoteBackend.basePath}`;
        await execOnColab(this.remoteBackend.rt, `cd ${remoteTargetDir} && base64 -d .colab-sync.tar.gz.b64 > .colab-sync.tar.gz && rm .colab-sync.tar.gz.b64 && tar -xzvf .colab-sync.tar.gz && rm .colab-sync.tar.gz`, (line) => {
           extCount++;
           const pct = Math.floor((extCount / pushTasks.length) * 100);
           const progressPct = pct > 100 ? 100 : pct;
           if (onProgress) onProgress({ action: "batch-extract", path: `[${progressPct}%] ${line}` });
        });
        
        await fs.rm(tmpDir, { recursive: true, force: true });
        
        // Update baseline and counts for batch pushed files
        for (const t of pushTasks) {
          handledByBatch.add(t.p);
          const updatedRemote = await this.remoteBackend.read(t.p).catch(() => null);
          if (updatedRemote) {
            this.baselineStore.set(t.p, { hash: updatedRemote.hash, mtime: updatedRemote.mtime, size: updatedRemote.size });
            if (updatedRemote.hash !== t.local.hash) {
              await this.localFS.write(t.p, { type: "file", content: updatedRemote.content, mtime: Date.now() });
              this.baselineStore.set(t.p, { hash: updatedRemote.hash, mtime: updatedRemote.mtime, size: updatedRemote.size });
            }
          }
          if (t.decision === "conflict-local") counts.conflicts++;
          else counts.pushed++;
        }
        counts.bytesTransferred += batchBytes;
      } catch (err) {
        if (onProgress) onProgress({ action: "error", path: "batch-push", error: err.message });
        console.error("Batch push failed:", err);
      }
    }

    let pushCount = 0;
    const totalPushes = pushTasks.length;
    let pullCount = 0;
    const pullTasks = tasks.filter(t => (t.decision === "pull") && (direction === "both" || direction === "pull"));
    const totalPulls = pullTasks.length;

    for (const t of tasks) {
      const { p, decision, base, local, remote } = t;

      try {
        if ((decision === "push" || decision === "conflict-local") && (direction === "both" || direction === "push")) {
          if (handledByBatch.has(p)) continue;
          pushCount++;
          if (onProgress) onProgress({ action: "push", path: `[${pushCount}/${totalPushes}] ${p}` });
          const localData = await this.localFS.read(p);
          await this.remoteBackend.write(p, {
            type: "file",
            content: localData.content,
            mtime: localData.mtime
          });
          counts.bytesTransferred += Buffer.byteLength(localData.content);
          const updatedRemote = await this.remoteBackend.read(p);
          if (updatedRemote.hash !== localData.hash) {
            await this.localFS.write(p, {
              type: "file",
              content: updatedRemote.content,
              mtime: Date.now()
            });
          }
          this.baselineStore.set(p, {
            hash: updatedRemote.hash,
            mtime: updatedRemote.mtime,
            size: updatedRemote.size
          });
          if (decision === "conflict-local") counts.conflicts++;
          else counts.pushed++;
        } else if (decision === "pull" && (direction === "both" || direction === "pull")) {
          pullCount++;
          if (onProgress) onProgress({ action: "pull", path: `[${pullCount}/${totalPulls}] ${p}` });
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
          if (onProgress) onProgress({ action: "delete-remote", path: p });
          await this.remoteBackend.remove(p).catch(() => {});
          this.baselineStore.remove(p);
          counts.deletedRemote++;
        } else if (decision === "delete-local" && (direction === "both" || direction === "pull")) {
          if (onProgress) onProgress({ action: "delete-local", path: p });
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
      } catch (err) {
        if (onProgress) onProgress({ action: "error", path: p, error: err.message });
        console.error(`Sync error on ${p}:`, err);
      }
    }
    await this.baselineStore.save();
    counts.elapsedMs = Date.now() - startTime;
    return counts;
  }
}
