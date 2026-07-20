import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { addLink, removeLink, getGitConfig, saveGitConfig } from "./config.js";
import { classify } from "./merge.js";
import { GitHubSync } from "./github-sync.js";
import { ColabContentsBackend } from "./contents-backend.js";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendWsFrame(socket, opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  socket.write(Buffer.concat([header, data]));
}

let activeExecution = false;
let activeWs = null;

export function createServer(config, rt, linksRegistry) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url, `http://localhost:${config.port}`);
    const method = req.method;
    const pathname = url.pathname;

    try {
      if (method === "GET" && (pathname === "/" || pathname === "/term")) {
        res.setHeader("Content-Type", "text/html");
        res.writeHead(200);
        return res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Colab Sync Console</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #0b0f19;
      --panel: #161f30;
      --border: #22324d;
      --text: #e2e8f0;
      --accent: #3b82f6;
      --accent-grad: linear-gradient(135deg, #3b82f6, #8b5cf6);
      --green: #10b981;
    }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: 'Outfit', sans-serif;
    }
    .grid {
      display: grid;
      grid-template-columns: 350px 1fr;
      gap: 24px;
      height: calc(100vh - 48px);
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    }
    h2 {
      margin-top: 0;
      font-weight: 600;
      font-size: 20px;
      background: var(--accent-grad);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .stat-item {
      margin-bottom: 16px;
    }
    .stat-label {
      font-size: 12px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-value {
      font-size: 15px;
      font-weight: 500;
      margin-top: 4px;
      word-break: break-all;
    }
    .btn {
      background: var(--accent-grad);
      color: white;
      border: none;
      padding: 12px;
      border-radius: 6px;
      font-family: 'Outfit', sans-serif;
      font-weight: 600;
      cursor: pointer;
      margin-top: 12px;
      transition: opacity 0.2s;
    }
    .btn:hover {
      opacity: 0.9;
    }
    .btn-danger {
      background: linear-gradient(135deg, #ef4444, #f97316);
    }
    #terminal-container {
      flex: 1;
      padding: 8px;
      background: #05070c;
      border-radius: 8px;
      border: 1px solid var(--border);
      overflow: hidden;
    }
    .indicator {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--green);
      margin-right: 8px;
    }
  </style>
</head>
<body>
  <div class="grid">
    <div class="panel">
      <h2>Colab Sync Control</h2>
      
      <div class="stat-item" style="margin-top: 16px;">
        <div class="stat-label">Connection Status</div>
        <div class="stat-value" id="status-val"><span class="indicator"></span>Connected</div>
      </div>
      
      <div class="stat-item">
        <div class="stat-label">Runtime Endpoint</div>
        <div class="stat-value" id="endpoint-val">...</div>
      </div>
      
      <div class="stat-item">
        <div class="stat-label">Active Workspaces</div>
        <div class="stat-value" id="workspace-val">...</div>
      </div>

      <div style="flex: 1;"></div>
      
      <button class="btn" onclick="triggerSync()">Sync Files Now</button>
      <button class="btn btn-danger" onclick="killSession()">Teardown Runtime</button>
    </div>
    
    <div class="panel" style="padding: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h2 style="margin: 0;">Interactive Terminal</h2>
        <div style="color: #64748b; font-size: 13px;">ws://127.0.0.1:${config.port}/v1/term</div>
      </div>
      <div id="terminal-container"></div>
    </div>
  </div>

  <script>
    async function updateStats() {
      try {
        const r = await fetch('/v1/status');
        const d = await r.json();
        document.getElementById('endpoint-val').innerText = d.endpoint || 'None';
        document.getElementById('workspace-val').innerText = d.activeLink ? d.activeLink.path : 'None';
      } catch (e) {}
    }
    setInterval(updateStats, 5000);
    updateStats();

    async function triggerSync() {
      try {
        const r = await fetch('/v1/status');
        const d = await r.json();
        if (d.activeLink) {
          await fetch('/v1/sync?link=' + d.activeLink.name, { method: 'POST' });
          alert('Sync complete!');
        }
      } catch (e) {
        alert('Sync failed: ' + e.message);
      }
    }

    async function killSession() {
      if (confirm('Teardown active GPU session?')) {
        await fetch('/v1/status', { method: 'DELETE' });
        alert('Session terminated.');
        window.location.reload();
      }
    }

    const term = new Terminal({
      theme: {
        background: '#05070c',
        foreground: '#e2e8f0',
        cursor: '#3b82f6',
        black: '#000000',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#8b5cf6',
        cyan: '#06b6d4',
        white: '#ffffff'
      },
      fontFamily: 'Fira Code, monospace',
      fontSize: 13,
      cursorBlink: true
    });

    term.open(document.getElementById('terminal-container'));
    
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsProto + '//' + window.location.host + '/v1/term');

    ws.onopen = () => {
      term.focus();
      ws.send(JSON.stringify({ resize: [term.cols, term.rows] }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.data) term.write(msg.data);
      } catch {
        term.write(e.data);
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ data }));
      }
    });

    window.addEventListener('resize', () => {
      ws.send(JSON.stringify({ resize: [term.cols, term.rows] }));
    });
  </script>
</body>
</html>`);
      }

      if (method === "GET" && pathname === "/v1/links") {
        const list = await linksRegistry.listLinks();
        res.writeHead(200);
        return res.end(JSON.stringify(list));
      }

      if (method === "POST" && pathname === "/v1/link") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        await addLink(body.path, body.name || "default");
        await linksRegistry.reload();
        res.writeHead(200);
        return res.end(JSON.stringify({ linked: true }));
      }

      if (method === "DELETE" && pathname === "/v1/link") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        await removeLink(body.path);
        await linksRegistry.reload();
        res.writeHead(200);
        return res.end(JSON.stringify({ unlinked: true }));
      }

      const linkName = url.searchParams.get("link");
      const ctx = linksRegistry.getLink(linkName);

      if (method === "GET" && pathname === "/v1/status") {
        let ccu = null;
        let resources = null;
        if (rt.baseUrl) {
          try {
            ccu = await rt.getUserInfo();
          } catch {}
          try {
            resources = await rt.getResources();
          } catch (err) {
            console.error("getResources error:", err);
          }
        }
        res.writeHead(200);
        return res.end(JSON.stringify({
          connected: rt.baseUrl !== null,
          endpoint: rt.endpoint,
          baseUrl: rt.baseUrl,
          ccuConsumption: ccu,
          resources: resources,
          activeLink: ctx ? { name: ctx.name, path: ctx.path } : null,
          lastSyncStats: ctx ? ctx.lastSyncStats : null,
          pauseAutoSync: config.pauseAutoSync === true
        }));
      }
      if (method === "POST" && pathname === "/v1/config/auto-sync") {
        config.pauseAutoSync = !config.pauseAutoSync;
        res.writeHead(200);
        return res.end(JSON.stringify({ pauseAutoSync: config.pauseAutoSync }));
      }

      if (method === "DELETE" && pathname === "/v1/status") {
        if (!rt.endpoint) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "no active session to kill" }));
        }
        const target = rt.endpoint;
        await rt.unassign(target);
        rt.baseUrl = null;
        rt.endpoint = null;
        await linksRegistry.reload();
        res.writeHead(200);
        return res.end(JSON.stringify({ unassigned: true, endpoint: target }));
      }

      if (method === "POST" && pathname === "/v1/status") {
        const bodyText = (await readBody(req)).toString("utf8");
        const body = bodyText ? JSON.parse(bodyText) : {};
        const provision = body.provision !== false;
        const opts = {
          variant: body.variant || "DEFAULT",
          accelerator: body.accelerator || null,
          shape: body.shape || 0,
          version: body.version || null
        };
        await rt.connect({ provision, provisionOpts: opts });
        if (provision && rt.endpoint) {
          rt.startKeepAlive();
        }
        await linksRegistry.reload();
        res.writeHead(200);
        return res.end(JSON.stringify({
          connected: rt.baseUrl !== null,
          endpoint: rt.endpoint,
          baseUrl: rt.baseUrl
        }));
      }

      if (method === "GET" && pathname === "/v1/fs/list") {
        if (!rt.baseUrl) {
          res.writeHead(503);
          return res.end(JSON.stringify({ error: "Runtime not connected" }));
        }
        const p = url.searchParams.get("path") || "";
        const backend = new ColabContentsBackend(rt, "content");
        try {
          const list = await backend.list(p);
          res.writeHead(200);
          return res.end(JSON.stringify(list));
        } catch (e) {
          res.writeHead(500);
          return res.end(JSON.stringify({ error: e.message }));
        }
      }

      if (method === "GET" && pathname === "/v1/fs/read") {
        if (!rt.baseUrl) {
          res.writeHead(503);
          return res.end(JSON.stringify({ error: "Runtime not connected" }));
        }
        const p = url.searchParams.get("path") || "";
        const backend = new ColabContentsBackend(rt, "content");
        try {
          const fileData = await backend.read(p);
          res.writeHead(200);
          return res.end(JSON.stringify({
            content: fileData.content.toString(fileData.format === "base64" ? "base64" : "utf8"),
            format: fileData.format || (fileData.content.includes && fileData.content.includes(0) ? "base64" : "text")
          }));
        } catch (e) {
          res.writeHead(500);
          return res.end(JSON.stringify({ error: e.message }));
        }
      }

      if (method === "POST" && pathname === "/v1/exec" && rt.baseUrl) {
        if (activeExecution) {
          res.writeHead(409);
          return res.end(JSON.stringify({ error: "A command is currently executing. You must wait for it to finish or call `colab_interrupt` to stop it. For long-running commands, run them in the background (e.g., append `&` or use `nohup`)." }));
        }
        activeExecution = true;

        const bodyText = (await readBody(req)).toString("utf8");
        const body = bodyText ? JSON.parse(bodyText) : {};
        const cmd = body.command;
        if (!cmd) {
          activeExecution = false;
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "command is required" }));
        }

        const wsUrl = rt.baseUrl.replace("https:", "wss:") + "/colab/tty";
        const ws = new WebSocket(wsUrl, {
          headers: { "X-Colab-Runtime-Proxy-Token": rt.proxyToken }
        });
        activeWs = ws;

        const execId = crypto.randomBytes(6).toString("hex");
        let output = "";
        const execPromise = new Promise((resolve) => {
          ws.onopen = () => {
            setTimeout(() => {
              ws.send(JSON.stringify({ data: `\r${cmd}; echo __PWD_$(pwd)__; echo __EXEC_DONE_$(echo ${execId})__\r` }));
            }, 600);
          };
          ws.onmessage = (event) => {
            let data = event.data;
            try {
              const msg = JSON.parse(data);
              if (msg.data) data = msg.data;
            } catch {}
            output += data;
            const clean = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
            if (clean.includes(`__EXEC_DONE_${execId}__`)) {
              ws.close();
              resolve();
            }
          };
          ws.onerror = () => {
            ws.close();
            resolve();
          };
          ws.onclose = () => {
            resolve();
          };
        });

        await execPromise;
        activeExecution = false;
        activeWs = null;

        const cleanOutput = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
        const lines = cleanOutput.split(/\r?\n/).map(l => l.trim());
        const startIndex = lines.findIndex(l => l.includes(cmd));
        const endIndex = lines.findIndex(l => l.includes(`__EXEC_DONE_${execId}__`));
        let finalLines = lines;
        if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
          finalLines = lines.slice(startIndex + 1, endIndex);
        } else if (endIndex !== -1) {
          finalLines = lines.slice(0, endIndex);
        }
        const filtered = finalLines.filter(line => {
          const l = line.trim();
          if (!l) return false;
          if (l.includes("/content#") || l.startsWith("/content#")) return false;
          if (l.startsWith("[0]") && l.includes("bash*")) return false;
          if (l.includes("__EXEC_DONE_")) return false;
          return true;
        });
        res.writeHead(200);
        return res.end(JSON.stringify({ output: filtered.join("\n") }));
      }

      if (method === "POST" && pathname === "/v1/exec/stream" && rt.baseUrl) {
        const bodyText = (await readBody(req)).toString("utf8");
        const body = bodyText ? JSON.parse(bodyText) : {};
        const cmd = body.command;
        if (!cmd) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "command is required" }));
        }
        res.setHeader("Content-Type", "text/plain");
        res.setHeader("Transfer-Encoding", "chunked");
        res.writeHead(200);
        const wsUrl = rt.baseUrl.replace("https:", "wss:") + "/colab/tty";
        const ws = new WebSocket(wsUrl, {
          headers: { "X-Colab-Runtime-Proxy-Token": rt.proxyToken }
        });
        const execId = crypto.randomBytes(6).toString("hex");
        let commandSent = false;
        ws.onopen = () => {
          ws.send(JSON.stringify({ data: "\u0003" }));
          setTimeout(() => {
            ws.send(JSON.stringify({ data: `\r${cmd}; echo __PWD_$(pwd)__; echo __EXEC_DONE_$(echo ${execId})__\r` }));
            commandSent = true;
          }, 600);
        };
        ws.onmessage = (event) => {
          if (!commandSent) return;
          let data = event.data;
          try {
            const msg = JSON.parse(data);
            if (msg.data) data = msg.data;
          } catch {}
          const cleanChunk = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
          if (cleanChunk.includes(cmd) && cleanChunk.includes(execId)) {
            return;
          }
          if (cleanChunk.includes(`__EXEC_DONE_${execId}__`)) {
            const index = data.indexOf("__EXEC_DONE_");
            if (index > 0) {
              res.write(data.slice(0, index));
            }
            ws.close();
            res.end();
          } else {
            res.write(data);
          }
        };
        ws.onerror = () => {
          ws.close();
          res.end();
        };
        ws.onclose = () => {
          res.end();
        };
        req.on("close", () => {
          ws.close();
        });
        return;
      }

      if (method === "POST" && pathname === "/v1/exec/interrupt" && rt.baseUrl) {
        const wsUrl = rt.baseUrl.replace("https:", "wss:") + "/colab/tty";
        const ws = new WebSocket(wsUrl, {
          headers: { "X-Colab-Runtime-Proxy-Token": rt.proxyToken }
        });
        ws.onopen = () => {
          ws.send(JSON.stringify({ data: "\u0003" }));
          setTimeout(() => {
            ws.close();
            res.writeHead(200);
            return res.end(JSON.stringify({ interrupted: true }));
          }, 400);
        };
        ws.onerror = () => {
          res.writeHead(500);
          return res.end(JSON.stringify({ error: "failed to connect to TTY" }));
        };
        return;
      }

      if (method === "GET" && pathname === "/v1/git-status") {
        const gitSync = new GitHubSync(rt);
        const cfg = await gitSync.getConfig();
        res.writeHead(200);
        return res.end(JSON.stringify(cfg));
      }

      if (method === "POST" && pathname === "/v1/git-setup") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const { owner, repo, token } = body;
        if (!owner || !repo || !token) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "owner, repo, and token are required" }));
        }
        const gitSync = new GitHubSync(rt);
        try {
          await gitSync.setConfig(owner, repo, token);
        } catch (e) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: e.message }));
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ configured: true, owner, repo }));
      }

            if (!ctx) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: "no link registered or found" }));
      }

      if (method === "POST" && pathname === "/v1/sync") {
        const direction = url.searchParams.get("direction") || "both";
        const result = await ctx.syncEngine.sync(direction);
        await ctx.gitTracker.commit(`sync ${new Date().toISOString()}`);
        ctx.cachedSyncLevel = { outgoing: 0, incoming: 0, conflicts: 0 };
        ctx.lastSyncLevelCheck = Date.now();
        ctx.lastSyncStats = { bytes: result.bytesTransferred, ms: result.elapsedMs };
        res.writeHead(200);
        return res.end(JSON.stringify(result));
      }

      if (method === "GET" && pathname === "/v1/sync") {
        if (!rt.baseUrl) {
          res.writeHead(200);
          return res.end(JSON.stringify({ outgoing: 0, incoming: 0, conflicts: 0 }));
        }
        const now = Date.now();
        if (ctx.cachedSyncLevel && ctx.lastSyncLevelCheck && (now - ctx.lastSyncLevelCheck < 45000)) {
          res.writeHead(200);
          return res.end(JSON.stringify(ctx.cachedSyncLevel));
        }
        await ctx.baselineStore.load();
        const localList = await ctx.syncEngine.walk(ctx.localFS, "");
        const remoteList = await ctx.syncEngine.walk(ctx.remoteBackend, "");

        const localMap = new Map(localList.map(f => [f.path, f]));
        const remoteMap = new Map(remoteList.map(f => [f.path, f]));

        const allPaths = new Set([
          ...localMap.keys(),
          ...remoteMap.keys(),
          ...ctx.baselineStore.getAll().keys()
        ]);

        const counts = { outgoing: 0, incoming: 0, conflicts: 0 };

        for (const p of allPaths) {
          if (ctx.syncEngine._isExcluded(p)) continue;

          const base = ctx.baselineStore.get(p);
          const local = localMap.get(p);
          const remote = remoteMap.get(p);

          const decision = classify(base, local, remote);

          if (decision === "push" || decision === "delete-remote") {
            counts.outgoing++;
          } else if (decision === "pull" || decision === "delete-local") {
            counts.incoming++;
          } else if (decision === "conflict-local" || decision === "conflict-remote") {
            counts.conflicts++;
          }
        }
        ctx.cachedSyncLevel = counts;
        ctx.lastSyncLevelCheck = Date.now();
        res.writeHead(200);
        return res.end(JSON.stringify(counts));
      }

      if (method === "POST" && pathname === "/v1/git-sync") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const direction = body.direction || "both";
        const gitSync = new GitHubSync(rt);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.writeHead(200);
        const send = (evt, data) => res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);
        try {
          const result = await gitSync.fullSync(ctx.gitTracker, ctx.name, direction, (msg) => send("progress", { msg }));
          send("progress", { msg: "Updating baseline in background..." });
          send("done", result);
          res.end();
          
          ctx.syncEngine.sync("both").then(() => {
            ctx.cachedSyncLevel = null;
            ctx.lastSyncLevelCheck = 0;
          }).catch(console.error);
          return;
        } catch (e) {
          send("error", { error: e.message });
        }
        return res.end();
      }

      const fsMatch = pathname.match(/^\/v1\/fs\/(.+)/);
      if (fsMatch) {
        const fsPath = decodeURIComponent(fsMatch[1]);
        if (method === "GET") {
          const contentParam = url.searchParams.get("content") !== "0";
          if (!contentParam) {
            const list = await ctx.remoteBackend.list(fsPath);
            res.writeHead(200);
            return res.end(JSON.stringify({ type: "directory", children: list }));
          }
          try {
            const fileData = await ctx.remoteBackend.read(fsPath);
            res.setHeader("Content-Type", "application/octet-stream");
            res.writeHead(200);
            return res.end(fileData.content);
          } catch (e) {
            try {
              const list = await ctx.remoteBackend.list(fsPath);
              res.writeHead(200);
              return res.end(JSON.stringify({ type: "directory", children: list }));
            } catch {
              res.writeHead(404);
              return res.end(JSON.stringify({ error: "not found" }));
            }
          }
        }

        if (method === "PUT") {
          const body = await readBody(req);
          await ctx.remoteBackend.write(fsPath, {
            type: "file",
            content: body
          });
          res.writeHead(200);
          return res.end(JSON.stringify({ written: true, size: body.length }));
        }

        if (method === "DELETE") {
          await ctx.remoteBackend.remove(fsPath);
          res.writeHead(200);
          return res.end(JSON.stringify({ deleted: true }));
        }
      }

      if (method === "POST" && pathname === "/v1/grep") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        const pattern = body.pattern;
        const maxResults = body.maxResults || 50;
        const regex = new RegExp(pattern);

        const allRemote = await ctx.syncEngine.walk(ctx.remoteBackend, "");
        const results = [];
        let truncated = false;

        for (const item of allRemote) {
          if (results.length >= maxResults) {
            truncated = true;
            break;
          }
          try {
            const fileData = await ctx.remoteBackend.read(item.path);
            const lines = fileData.content.toString("utf8").split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push({
                  path: item.path,
                  line: i + 1,
                  content: lines[i]
                });
                if (results.length >= maxResults) {
                  break;
                }
              }
            }
          } catch {}
        }

        res.writeHead(200);
        return res.end(JSON.stringify({ results, truncated }));
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      console.error("HTTP Server Error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://localhost`);
    if (url.pathname === "/v1/term" && rt.baseUrl) {
      const key = req.headers["sec-websocket-key"];
      const accept = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n"
      );

      const wsUrl = rt.baseUrl.replace("https:", "wss:") + "/colab/tty";
      const colabWs = new WebSocket(wsUrl, {
        headers: { "X-Colab-Runtime-Proxy-Token": rt.proxyToken }
      });

      socket.setTimeout(0);
      socket.setKeepAlive(true, 10000);

      colabWs.onmessage = (event) => {
        const data = event.data;
        if (typeof data === "string") {
          sendWsFrame(socket, 0x1, Buffer.from(data, "utf8"));
        } else {
          sendWsFrame(socket, 0x2, Buffer.from(data));
        }
      };

      colabWs.onclose = () => {
        socket.end();
      };

      colabWs.onerror = () => {
        sendWsFrame(socket, 0x8, Buffer.from([3, 232]));
        socket.end();
      };

      let frameBuffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
        while (frameBuffer.length >= 2) {
          const firstByte = frameBuffer[0];
          const secondByte = frameBuffer[1];
          const opcode = firstByte & 0x0F;
          const masked = (secondByte & 0x80) !== 0;
          let payloadLength = secondByte & 0x7F;
          let offset = 2;

          if (payloadLength === 126) {
            if (frameBuffer.length < 4) break;
            payloadLength = frameBuffer.readUInt16BE(2);
            offset = 4;
          } else if (payloadLength === 127) {
            if (frameBuffer.length < 10) break;
            payloadLength = Number(frameBuffer.readBigUInt64BE(2));
            offset = 10;
          }

          if (frameBuffer.length < offset + (masked ? 4 : 0) + payloadLength) break;

          const maskKey = masked ? frameBuffer.slice(offset, offset + 4) : null;
          offset += masked ? 4 : 0;

          const payload = frameBuffer.slice(offset, offset + payloadLength);
          frameBuffer = frameBuffer.slice(offset + payloadLength);

          let data = payload;
          if (masked && maskKey) {
            data = Buffer.alloc(payloadLength);
            for (let i = 0; i < payloadLength; i++) {
              data[i] = payload[i] ^ maskKey[i % 4];
            }
          }

          if (opcode === 0x8) {
            colabWs.close();
            socket.end();
            return;
          } else if (opcode === 0x9) {
            sendWsFrame(socket, 0xA, data);
          } else if (opcode === 0x1 || opcode === 0x2) {
            if (colabWs.readyState === 1) {
              colabWs.send(opcode === 0x1 ? data.toString("utf8") : data);
            }
          }
        }
      });

      socket.on("close", () => {
        colabWs.close();
      });
    } else {
      socket.destroy();
    }
  });

  return server;
}
