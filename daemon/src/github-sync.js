import crypto from "node:crypto";
import { GitTracker } from "./git-tracker.js";
import { getGitConfig, saveGitConfig } from "./config.js";

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const EXEC_TIMEOUT_MS = 120_000;

export async function execOnColab(rt, command, onProgress) {
  const wsUrl = rt.baseUrl.replace("https:", "wss:") + "/colab/tty";
  const ws = new WebSocket(wsUrl, {
    headers: { "X-Colab-Runtime-Proxy-Token": rt.proxyToken }
  });
  const execId = crypto.randomBytes(6).toString("hex");
  let output = "";
  let buffer = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("Colab exec timed out")); }, EXEC_TIMEOUT_MS);
    ws.onopen = () => { setTimeout(() => { ws.send(JSON.stringify({ data: "\r" + command + "; echo __DONE_" + execId + "__\r" })); }, 600); };
    ws.onmessage = (event) => {
      let data = event.data;
      try { const msg = JSON.parse(data); if (msg.data) data = msg.data; } catch {}
      output += data;
      const clean = output.replace(ANSI_RE, "");
      if (onProgress) {
        buffer += data.replace(ANSI_RE, "");
        const lines = buffer.split(/[\r\n]+/);
        while (lines.length > 1) {
          const line = lines.shift().trim();
          if (line && !line.includes("__DONE_") && !line.includes(command.substring(0, 10))) onProgress(line);
        }
        buffer = lines[0];
      }
      if (clean.includes("\n__DONE_" + execId + "__") || clean.includes("\r__DONE_" + execId + "__")) {
        clearTimeout(timer); ws.close();
        const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const end = lines.findIndex(l => l.includes("__DONE_" + execId + "__"));
        resolve(lines.slice(0, end !== -1 ? end : undefined).join("\n"));
      }
    };
    ws.onerror = () => { clearTimeout(timer); ws.close(); reject(new Error("TTY WebSocket error")); };
    ws.onclose = () => { clearTimeout(timer); };
  });
}

export class GitHubSync {
  constructor(rt) { this.rt = rt; }

  async getConfig() { return getGitConfig(); }

  async setConfig(owner, repo, token) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const testUrl = "https://x-access-token:" + token + "@github.com/" + owner + "/" + repo + ".git";
    try {
      await execFileAsync("git", ["ls-remote", "--exit-code", testUrl, "HEAD"], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 15000
      });
    } catch (e) {
      throw new Error("Cannot reach " + owner + "/" + repo + " on GitHub. Check owner, repo name, and PAT scopes.");
    }
    await saveGitConfig(owner, repo, token);
  }

  async _localPush(tracker, cfg, emit, branch) {
    const errors = [];
    try { await tracker.commit("colabd git-sync " + new Date().toISOString()); } catch (e) { errors.push("local commit: " + e.message); }
    emit("local: fetching from remote...");
    try { await tracker.fetch("origin", branch); } catch (e) { errors.push("local fetch: " + e.message); }
    emit("local: pulling and rebasing...");
    try { await tracker.pullRebase("origin", branch); } catch (e) { errors.push("local pull-rebase: " + e.message); }
    emit("local: pushing to remote...");
    try { await tracker.push("origin", branch); } catch (e) { errors.push("local push: " + e.message); }
    return errors;
  }

  async _remoteSync(workspaceName, direction, branch) {
    if (!this.rt.baseUrl) throw new Error("No active Colab session");
    const cfg = await getGitConfig();
    const remoteUrl = "https://x-access-token:" + cfg.token + "@github.com/" + cfg.owner + "/" + cfg.repo + ".git";
    const dir = "/content/workspaces/" + workspaceName;
    const env = 'GIT_DIR="' + dir + '/.colab/git" GIT_WORK_TREE="' + dir + '" GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME="colabd sync" GIT_AUTHOR_EMAIL="colabd@local" GIT_COMMITTER_NAME="colabd sync" GIT_COMMITTER_EMAIL="colabd@local"';
    const setup = 'mkdir -p "' + dir + '/.colab/git" && cd "' + dir + '" && ' + env + ' git init -q || true && ' + env + ' git config user.name "colabd sync" && ' + env + ' git config user.email "colabd@local" && ' + env + ' git remote add origin "' + remoteUrl + '" || ' + env + ' git remote set-url origin "' + remoteUrl + '"';
    await execOnColab(this.rt, setup, (l) => emit("remote init: " + l));
    const errors = [];
    if (direction === "push" || direction === "both") {
      const pushCmd = 'cd "' + dir + '" && ' + env + ' git add -A --ignore-errors || true && ' + env + ' git commit -m "colabd git-sync $(date -u +%Y%m%dT%H%M%SZ)" || true && (' + env + ' git pull --rebase origin ' + branch + ' || (' + env + ' git rebase --abort; ' + env + ' git pull --no-rebase --no-edit origin ' + branch + ')) || true && ' + env + ' git submodule update --init --recursive || true && (' + env + ' git push origin HEAD:refs/heads/' + branch + ' --force-with-lease || ' + env + ' git push origin HEAD:refs/heads/' + branch + ' --force)';
      try { await execOnColab(this.rt, pushCmd, (l) => emit("remote: " + l)); } catch (e) { errors.push("remote push: " + e.message); }
    }
    if (direction === "pull" || direction === "both") {
      const pullCmd = 'cd "' + dir + '" && (' + env + ' git pull --rebase origin ' + branch + ' || (' + env + ' git rebase --abort; ' + env + ' git pull --no-rebase --no-edit origin ' + branch + ')) || true && ' + env + ' git submodule update --init --recursive || true';
      try { await execOnColab(this.rt, pullCmd, (l) => emit("remote: " + l)); } catch (e) { errors.push("remote pull: " + e.message); }
    }
    return errors;
  }

  async fullSync(tracker, workspaceName, direction = "both", onProgress = null) {
    const emit = (msg) => { if (onProgress) onProgress(msg); };
    tracker.onProgress = emit;
    const cfg = await getGitConfig();
    if (!cfg.configured) throw new Error("GitHub sync not configured");
    await tracker.addRemote(cfg.owner, cfg.repo, cfg.token);
    const errors = [];
    const branch = `colab-sync-${workspaceName}`;
    if (direction === "push" || direction === "both") {
      emit("local: committing changes...");
      errors.push(...await this._localPush(tracker, cfg, emit, branch));
    }
    emit("remote: syncing to Colab...");
    errors.push(...await this._remoteSync(workspaceName, direction, branch).catch(e => [e.message]));
    if (direction === "pull" || direction === "both") {
      emit("local: pulling Colab changes...");
      try { await tracker.pullRebase("origin", branch); } catch (e) { errors.push("local pull (final): " + e.message); }
    }
    emit("done");
    return { errors };
  }

  async status(tracker) {
    const cfg = await getGitConfig();
    if (!cfg.configured) return { configured: false };
    try {
      await tracker.addRemote(cfg.owner, cfg.repo, cfg.token);
      await tracker.fetch();
      const { ahead, behind } = await tracker.aheadBehind();
      return { configured: true, owner: cfg.owner, repo: cfg.repo, localAhead: ahead, localBehind: behind };
    } catch {
      return { configured: true, owner: cfg.owner, repo: cfg.repo, localAhead: 0, localBehind: 0 };
    }
  }
}
