import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export class GitTracker {
  constructor(rootPath) {
    this.rootPath = rootPath;
    this.gitDir = path.join(rootPath, ".colab", "git");
    this.env = {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.rootPath,
      GIT_AUTHOR_NAME: "colabd sync",
      GIT_AUTHOR_EMAIL: "colabd@local",
      GIT_COMMITTER_NAME: "colabd sync",
      GIT_COMMITTER_EMAIL: "colabd@local"
    };
  }

  async _git(args) {
    if (!this.onProgress) {
      const { stdout } = await execFileAsync("git", args, { env: this.env, cwd: this.rootPath });
      return stdout;
    }
    const { spawn } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { env: this.env, cwd: this.rootPath });
      let out = "";
      let err = "";
      let buffer = "";
      
      const handleData = (chunk) => {
        const text = chunk.toString();
        buffer += text.replace(ANSI_RE, "");
        const lines = buffer.split(/[\r\n]+/);
        while (lines.length > 1) {
          const line = lines.shift().trim();
          if (line) this.onProgress("local git: " + line);
        }
        buffer = lines[0];
      };

      child.stdout.on("data", (c) => { out += c.toString(); handleData(c); });
      child.stderr.on("data", (c) => { err += c.toString(); handleData(c); });

      child.on("close", (code) => {
        if (buffer.trim()) this.onProgress("local git: " + buffer.trim());
        if (code === 0) resolve(out);
        else {
          const e = new Error(`Command failed: git ${args.join(" ")}\n${err}`);
          e.stdout = out;
          e.stderr = err;
          reject(e);
        }
      });
    });
  }

  async init() {
    await fs.mkdir(this.gitDir, { recursive: true });
    const initEnv = { ...this.env };
    delete initEnv.GIT_WORK_TREE;
    try {
      await execFileAsync("git", ["rev-parse", "--git-dir"], { env: initEnv });
    } catch {
      await execFileAsync("git", ["init", "--bare"], { env: initEnv });
      const gitignorePath = path.join(this.rootPath, ".gitignore");
      try {
        let content = await fs.readFile(gitignorePath, "utf8");
        if (!content.includes(".colab/")) {
          content = content.trim() + "\n.colab/\n.colabignore\n";
          await fs.writeFile(gitignorePath, content, "utf8");
        }
      } catch {
        await fs.writeFile(gitignorePath, ".colab/\n.colabignore\n", "utf8");
      }
    }
    try {
      await this._git(["config", "core.excludesfile", ".colabignore"]);
    } catch {}
  }

  async commit(message = "sync") {
    await this._git(["add", "-A", "--ignore-errors"]);

    try {
      const { stdout: stageOut } = await this._git(["ls-files", "--stage"]);
      const lines = stageOut.trim().split("\n");
      let gitmodules = "";
      for (const line of lines) {
        if (!line.startsWith("160000")) continue;
        const parts = line.split("\t");
        if (parts.length < 2) continue;
        const relPath = parts[1];
        try {
          const subGitDir = path.join(this.rootPath, relPath, ".git");
          const subWorkTree = path.join(this.rootPath, relPath);
          const { stdout: subStatus } = await execFileAsync("git", ["--git-dir=" + subGitDir, "--work-tree=" + subWorkTree, "status", "--porcelain"]);
          const hasChanges = subStatus.trim().length > 0;
          
          const { stdout: urlOut } = await execFileAsync("git", ["--git-dir=" + subGitDir, "config", "--get", "remote.origin.url"]);
          let url = urlOut.trim();
          
          if (hasChanges && url) {
            const newUrl = await this._autoForkAndPush(relPath, url);
            if (newUrl) {
              url = newUrl;
              await this._git(["add", relPath]);
            }
          }
          
          if (url) {
            gitmodules += `[submodule "${relPath}"]\n\tpath = ${relPath}\n\turl = ${url}\n`;
          }
        } catch (e) {
          console.error("Auto-fork error:", e);
        }
      }
      if (gitmodules) {
        await fs.writeFile(path.join(this.rootPath, ".gitmodules"), gitmodules);
        await this._git(["add", ".gitmodules"]);
      }
    } catch {}

    try {
      const status = await this._git(["status", "--porcelain"]);
      if (status.trim().length > 0) {
        await this._git(["commit", "-m", message]);
      }
    } catch (e) {
      if (e.stdout && e.stdout.includes("nothing to commit")) return;
      throw e;
    }
  }

  async log(limit = 10) {
    try {
      const out = await this._git(["log", `--max-count=${limit}`, "--oneline"]);
      return out.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async stash() {
    try {
      await this._git(["stash", "--include-untracked"]);
    } catch {}
  }

  async diff(p) {
    try {
      return await this._git(["diff", "HEAD", "--", p]);
    } catch {
      return "";
    }
  }

  async addRemote(owner, repo, pat) {
    const url = `https://x-access-token:${pat}@github.com/${owner}/${repo}.git`;
    try {
      await this._git(["remote", "add", "origin", url]);
    } catch {
      await this._git(["remote", "set-url", "origin", url]);
    }
  }

  async fetch(remote = "origin", branch = null) {
    if (branch) {
      await this._git(["fetch", remote, branch, "--no-tags"]);
    } else {
      await this._git(["fetch", remote, "--no-tags"]);
    }
  }

  async pullRebase(remote = "origin", branch = "main") {
    try {
      await this._git(["pull", "--rebase", remote, branch]);
    } catch (e) {
      await this._git(["rebase", "--abort"]).catch(() => {});
      await this._git(["pull", "--no-rebase", "--no-edit", remote, branch]);
    }
    try {
      await this._git(["submodule", "update", "--init", "--recursive"]);
    } catch (e) {}
  }

  async push(remote = "origin", branch = "main") {
    try {
      await this._git(["push", remote, `HEAD:refs/heads/${branch}`, "--force-with-lease"]);
    } catch (e) {
      if (e.stderr && e.stderr.includes("stale info")) {
        await this._git(["push", remote, `HEAD:refs/heads/${branch}`, "--force"]);
      } else {
        throw e;
      }
    }
  }

  async aheadBehind(remote = "origin", branch = "main") {
    try {
      const out = await this._git(["rev-list", "--left-right", "--count", `${remote}/${branch}...HEAD`]);
      const [behind, ahead] = out.trim().split(/\s+/).map(Number);
      return { ahead: ahead || 0, behind: behind || 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  async _autoForkAndPush(relPath, originalUrl) {
    const { getGitConfig } = await import("./config.js");
    const cfg = await getGitConfig();
    if (!cfg.configured || !cfg.token) return null;
    
    const match = originalUrl.match(/github\.com[/:]([^/]+)\/([^.]+)(?:\.git)?/);
    if (!match) return null;
    const origOwner = match[1];
    const origRepo = match[2];
    
    let targetUrl = originalUrl;
    let targetOwner = origOwner;
    
    if (origOwner !== cfg.owner) {
      const res = await fetch(`https://api.github.com/repos/${origOwner}/${origRepo}/forks`, {
        method: "POST",
        headers: {
          "Authorization": `token ${cfg.token}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "colabd-sync"
        }
      });
      if (!res.ok && res.status !== 202) return null;
      targetOwner = cfg.owner;
      targetUrl = `https://github.com/${cfg.owner}/${origRepo}.git`;
    }
    
    const subGitDir = path.join(this.rootPath, relPath, ".git");
    const subWorkTree = path.join(this.rootPath, relPath);
    const subEnv = { ...process.env, GIT_DIR: subGitDir, GIT_WORK_TREE: subWorkTree };
    const authUrl = `https://x-access-token:${cfg.token}@github.com/${targetOwner}/${origRepo}.git`;
    
    try {
      await execFileAsync("git", ["remote", "add", "colabd-fork", authUrl], { env: subEnv });
    } catch {
      await execFileAsync("git", ["remote", "set-url", "colabd-fork", authUrl], { env: subEnv });
    }
    
    await execFileAsync("git", ["add", "-A"], { env: subEnv });
    try {
      await execFileAsync("git", ["commit", "-m", "colabd auto-fork commit"], { env: subEnv });
    } catch {}
    
    try {
      let currentBranch = "main";
      try {
        const { stdout: branchOut } = await execFileAsync("git", ["branch", "--show-current"], { env: subEnv });
        if (branchOut.trim()) currentBranch = branchOut.trim();
      } catch {}
      await execFileAsync("git", ["push", "colabd-fork", `HEAD:refs/heads/${currentBranch}`, "--force"], { env: subEnv });
    } catch (e) {
      return null;
    }
    
    return targetUrl;
  }
}
