const vscode = require("vscode");
const { exec, spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const daemonPort = 8291;
const daemonUrl = `http://127.0.0.1:${daemonPort}`;

class ColabSyncProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (element) {
      if (element.contextValue === "session-item" && element.quota) {
        return [
          new vscode.TreeItem(element.quota, vscode.TreeItemCollapsibleState.None)
        ];
      }
      return [];
    }

    const items = [];
    let status = null;

    try {
      status = await new Promise((resolve, reject) => {
        const req = http.get(`${daemonUrl}/v1/status`, { timeout: 1500 }, (res) => {
          let body = "";
          res.on("data", (chunk) => body += chunk);
          res.on("end", () => {
            if (res.statusCode === 200) {
              resolve(JSON.parse(body));
            } else {
              reject(new Error("status error"));
            }
          });
        });
        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("timeout"));
        });
      });
    } catch {}

    const uiBtn = new vscode.TreeItem("Open Web UI Dashboard", vscode.TreeItemCollapsibleState.None);
    uiBtn.iconPath = new vscode.ThemeIcon("dashboard");
    uiBtn.command = {
      command: "colab-sync.openDashboard",
      title: "Open Dashboard"
    };
    items.push(uiBtn);

    const divider = new vscode.TreeItem("────────────────────", vscode.TreeItemCollapsibleState.None);
    divider.label = "─".repeat(24);
    items.push(divider);

    if (status) {
      const daemonItem = new vscode.TreeItem("Daemon: Running (Port 8291)", vscode.TreeItemCollapsibleState.None);
      daemonItem.iconPath = new vscode.ThemeIcon("check-all");
      items.push(daemonItem);

      if (status.activeLink) {
        const linkItem = new vscode.TreeItem(`Workspace: Linked (${status.activeLink.name})`, vscode.TreeItemCollapsibleState.None);
        linkItem.iconPath = new vscode.ThemeIcon("link");
        items.push(linkItem);
      } else {
        const linkItem = new vscode.TreeItem("Workspace: Unlinked", vscode.TreeItemCollapsibleState.None);
        linkItem.iconPath = new vscode.ThemeIcon("bracket-error");
        items.push(linkItem);
      }

      if (status.connected) {
        const endpointName = status.endpoint || "CPU Runtime";
        const sessionItem = new vscode.TreeItem(`Session: ${endpointName}`, vscode.TreeItemCollapsibleState.Expanded);
        sessionItem.iconPath = new vscode.ThemeIcon("circle-large-filled");
        sessionItem.contextValue = "session-item";

        const ccu = status.ccuConsumption;
        if (ccu) {
          const rate = ccu.consumptionRateHourly || 0.08;
          if (ccu.paidComputeUnitsBalance > 0) {
            sessionItem.quota = `Paid Quota: ${ccu.paidComputeUnitsBalance.toFixed(1)} CU (~${(ccu.paidComputeUnitsBalance / rate).toFixed(1)}h)`;
          } else if (ccu.freeCcuQuotaInfo?.remainingTokens) {
            const tokens = parseInt(ccu.freeCcuQuotaInfo.remainingTokens, 10);
            const mins = Math.floor(((tokens / 1000) / rate * 60) / 10) * 10;
            sessionItem.quota = `Free Quota: ${Math.floor(mins / 60)}h ${mins % 60}m left`;
          }
        } else {
          sessionItem.quota = "Active Session connected";
        }
        items.push(sessionItem);
      } else {
        const noSessionItem = new vscode.TreeItem("No active Colab sessions", vscode.TreeItemCollapsibleState.None);
        noSessionItem.iconPath = new vscode.ThemeIcon("circle-slash");
        items.push(noSessionItem);
      }

      items.push(divider);

      const stopDaemonBtn = new vscode.TreeItem("Stop Daemon Server", vscode.TreeItemCollapsibleState.None);
      stopDaemonBtn.iconPath = new vscode.ThemeIcon("terminate");
      stopDaemonBtn.command = {
        command: "colab-sync.stopDaemon",
        title: "Stop Daemon Server"
      };
      items.push(stopDaemonBtn);

      const linkBtn = new vscode.TreeItem(status.activeLink ? "Change Linked Workspace..." : "Link Workspace Folder...", vscode.TreeItemCollapsibleState.None);
      linkBtn.iconPath = new vscode.ThemeIcon("link");
      linkBtn.command = {
        command: "colab-sync.linkWorkspace",
        title: "Link Workspace"
      };
      items.push(linkBtn);

      if (!status.connected) {
        const provisionBtn = new vscode.TreeItem("Provision Active Session...", vscode.TreeItemCollapsibleState.None);
        provisionBtn.iconPath = new vscode.ThemeIcon("cloud-upload");
        provisionBtn.command = {
          command: "colab-sync.provisionSession",
          title: "Provision Active Session"
        };
        items.push(provisionBtn);
      } else {
        const syncBtn = new vscode.TreeItem("Force Bidirectional Sync", vscode.TreeItemCollapsibleState.None);
        syncBtn.iconPath = new vscode.ThemeIcon("sync");
        syncBtn.command = {
          command: "colab-sync.forceSync",
          title: "Force Sync"
        };
        items.push(syncBtn);

        const termBtn = new vscode.TreeItem("Open Interactive Terminal", vscode.TreeItemCollapsibleState.None);
        termBtn.iconPath = new vscode.ThemeIcon("terminal");
        termBtn.command = {
          command: "colab-sync.openTerminal",
          title: "Open Colab Terminal"
        };
        items.push(termBtn);

        const disconnectBtn = new vscode.TreeItem("Terminate Session", vscode.TreeItemCollapsibleState.None);
        disconnectBtn.iconPath = new vscode.ThemeIcon("trash");
        disconnectBtn.command = {
          command: "colab-sync.teardownSession",
          title: "Terminate Session"
        };
        items.push(disconnectBtn);
      }

    } else {
      const daemonItem = new vscode.TreeItem("Daemon: Stopped", vscode.TreeItemCollapsibleState.None);
      daemonItem.iconPath = new vscode.ThemeIcon("stop-circle");
      items.push(daemonItem);

      items.push(divider);

      const startDaemonBtn = new vscode.TreeItem("Start Daemon Server", vscode.TreeItemCollapsibleState.None);
      startDaemonBtn.iconPath = new vscode.ThemeIcon("play");
      startDaemonBtn.command = {
        command: "colab-sync.startDaemon",
        title: "Start Daemon Server"
      };
      items.push(startDaemonBtn);
    }

    return items;
  }
}

function getWebviewContent(status) {
  const isRunning = !!status;
  const isConnected = status && status.connected;
  const endpoint = status ? status.endpoint || "CPU Runtime" : "Offline";
  const activeLink = status && status.activeLink ? status.activeLink.name : "Unlinked";
  const activeLinkPath = status && status.activeLink ? status.activeLink.path : "None";

  let usageLeftText = "N/A";
  let rateText = "N/A";

  if (status && status.ccuConsumption) {
    const ccu = status.ccuConsumption;
    const rate = ccu.consumptionRateHourly || 0.08;
    rateText = `${rate.toFixed(3)} CU/hour`;
    
    if (ccu.paidComputeUnitsBalance > 0) {
      const balance = ccu.paidComputeUnitsBalance;
      const hoursLeft = (balance / rate).toFixed(2);
      usageLeftText = `${balance.toFixed(2)} CU (~${hoursLeft}h left)`;
    } else if (ccu.freeCcuQuotaInfo?.remainingTokens) {
      const tokens = parseInt(ccu.freeCcuQuotaInfo.remainingTokens, 10);
      const hoursLeft = ((tokens / 1000) / rate).toFixed(2);
      usageLeftText = `${tokens} Tokens (~${hoursLeft}h left)`;
    }
  }

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Colab Sync Control Center</title>
      <style>
        @property --angle {
          syntax: '<angle>';
          initial-value: 0deg;
          inherits: false;
        }

        :root {
          --bg-color: #000000;
          --panel-bg: #131314;
          --border-color: rgba(255, 255, 255, 0.05);
          --text-color: #e3e3e3;
          --label-color: #8e918f;
          --btn-bg: #1e1f20;
          --btn-hover: #2a2b2d;
          --btn-primary: #a8c7fa;
          --btn-primary-text: #062e6f;
          --btn-danger: #ffb4ab;
          --btn-danger-text: #690005;
          --border-radius: 16px;
          --btn-radius: 20px;
          --card-padding: 20px;
        }

        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: var(--bg-color);
          color: var(--text-color);
          margin: 0;
          padding: 24px;
          min-height: 100vh;
          box-sizing: border-box;
          overflow-y: auto;
          position: relative;
        }

        /* 1. minimal (gemini) auras */
        .glow-bg {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 1;
          pointer-events: none;
          overflow: hidden;
          background: #000000;
          display: none;
        }
        .blob {
          position: absolute;
          border-radius: 50%;
          filter: blur(80px);
          opacity: 0.3;
          mix-blend-mode: screen;
        }
        .blob-blue {
          width: 300px;
          height: 300px;
          background: radial-gradient(circle, rgba(66, 133, 244, 0.8) 0%, rgba(66, 133, 244, 0) 70%);
          bottom: -50px;
          left: 20%;
          animation: floatBlue 15s ease-in-out infinite alternate;
        }
        .blob-purple {
          width: 250px;
          height: 250px;
          background: radial-gradient(circle, rgba(168, 85, 247, 0.8) 0%, rgba(168, 85, 247, 0) 70%);
          bottom: -80px;
          right: 25%;
          animation: floatPurple 12s ease-in-out infinite alternate;
        }
        @keyframes floatBlue {
          0% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(60px, -40px) scale(1.2); }
          100% { transform: translate(-20px, 20px) scale(0.95); }
        }
        @keyframes floatPurple {
          0% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(-50px, -60px) scale(0.9); }
          100% { transform: translate(40px, 30px) scale(1.2); }
        }

        /* 2. space tech stars */
        .stars-bg {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 1;
          pointer-events: none;
          overflow: hidden;
          display: none;
        }
        .star {
          position: absolute;
          background: #ffffff;
          border-radius: 50%;
          opacity: 0.8;
          animation: twinkle 4s infinite ease-in-out;
        }
        @keyframes twinkle {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1.2); }
        }

        /* 3. cyberpunk scanlines */
        .cyberpunk-bg {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 1;
          pointer-events: none;
          overflow: hidden;
          background: #0d0c1d;
          display: none;
        }

        .content {
          position: relative;
          z-index: 2;
          max-width: 600px;
          margin: 0 auto;
        }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 24px;
        }
        
        .header-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .badge {
          display: inline-flex;
          align-items: center;
          font-size: 11px;
          font-weight: 500;
          padding: 4px 12px;
          border-radius: 20px;
          background: rgba(255, 179, 0, 0.1);
          color: #ffb300;
          border: 1px solid rgba(255, 179, 0, 0.25);
          transition: all 0.2s;
        }
        
        .badge.active {
          background: rgba(56, 139, 253, 0.1);
          color: #58a6ff;
          border: 1px solid rgba(56, 139, 253, 0.25);
        }

        .settings-btn {
          cursor: pointer;
          background: none;
          border: none;
          color: var(--label-color);
          padding: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
        }
        .settings-btn:hover {
          color: var(--text-color);
        }

        .settings-panel {
          background: var(--panel-bg);
          border: 1px solid var(--border-color);
          border-radius: var(--border-radius);
          padding: 16px;
          margin-bottom: 20px;
          display: none;
        }

        .outer-wrapper {
          border-radius: var(--border-radius);
          padding: var(--card-padding);
          background: var(--panel-bg);
          border: 1px solid var(--border-color);
          box-sizing: border-box;
        }

        .panel {
          background: var(--panel-bg);
          border: 1px solid var(--border-color);
          border-radius: var(--border-radius);
          padding: 12px;
          margin-bottom: 20px;
          box-sizing: border-box;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          table-layout: fixed;
        }
        td {
          padding: 12px 14px;
          border-bottom: 1px solid var(--border-color);
          word-wrap: break-word;
          overflow-wrap: break-word;
        }
        tr:last-child td {
          border-bottom: none;
        }
        .label {
          color: var(--label-color);
          width: 180px;
        }
        .value {
          color: var(--text-color);
          font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace;
        }

        .section-title {
          font-size: 11px;
          font-weight: 500;
          color: var(--label-color);
          margin-top: 20px;
          margin-bottom: 10px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }
        .button-group {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 10px;
        }
        
        .btn {
          background: var(--btn-bg);
          border: 1px solid rgba(255, 255, 255, 0.06);
          color: var(--text-color);
          padding: 8px 18px;
          font-size: 13px;
          font-weight: 500;
          border-radius: var(--btn-radius);
          cursor: pointer;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          position: relative;
        }
        .btn:hover {
          background: var(--btn-hover);
          border-color: rgba(255, 255, 255, 0.12);
        }
        .btn-primary {
          background: var(--btn-primary);
          border-color: var(--btn-primary);
          color: var(--btn-primary-text);
        }
        .btn-primary:hover {
          filter: brightness(1.1);
        }
        .btn-danger {
          background: var(--btn-danger);
          border-color: var(--btn-danger);
          color: var(--btn-danger-text);
        }
        .btn-danger:hover {
          filter: brightness(1.1);
        }
        
        .spinner {
          display: none;
          width: 12px;
          height: 12px;
          border: 2px solid rgba(255,255,255,0.2);
          border-top-color: currentColor;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin-right: 8px;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        
        .btn.loading .spinner {
          display: inline-block;
        }
        .btn.loading {
          pointer-events: none;
          opacity: 0.8;
        }

        select {
          background: #1e1f20;
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: #e3e3e3;
          padding: 8px 36px 8px 16px;
          font-size: 13px;
          border-radius: 20px;
          margin-right: 10px;
          outline: none;
          cursor: pointer;
          appearance: none;
          background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%2724%27%20height%3D%2724%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%238e918f%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpolyline%20points%3D%276%209%2012%2015%2018%209%27%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E");
          background-repeat: no-repeat;
          background-position: right 12px center;
          background-size: 14px;
        }
        select:hover {
          background-color: #2a2b2d;
          border-color: rgba(255, 255, 255, 0.15);
        }

        /* theme specifics */
        body.theme-cyberpunk {
          --bg-color: #0d0c1d;
          --panel-bg: #0d0c1d;
          --border-color: transparent;
          --text-color: #00f0ff;
          --label-color: #00f0ff;
          --btn-bg: transparent;
          --btn-hover: rgba(255, 0, 255, 0.1);
          --btn-primary: #00f0ff;
          --btn-primary-text: #0d0c1d;
          --btn-danger: transparent;
          --btn-danger-text: #ff00ff;
          --border-radius: 12px;
          --btn-radius: 8px;
          --card-padding: 2px;
        }
        
        body.theme-cyberpunk .outer-wrapper {
          background-image: linear-gradient(var(--angle), #00f0ff, #ff00ff);
          padding: 2px;
          animation: rotateAngle 4s linear infinite;
        }
        body.theme-cyberpunk .inner-wrapper {
          background: #0d0c1d;
          border-radius: 10px;
          padding: 20px;
        }

        body.theme-cyberpunk .panel {
          background-image: linear-gradient(var(--angle), #00f0ff, #ff00ff);
          padding: 2px;
          animation: rotateAngle 4s linear infinite;
        }
        body.theme-cyberpunk .panel-inner {
          background: #0d0c1d;
          border-radius: 10px;
          padding: 12px;
        }

        @keyframes rotateAngle {
          0% { --angle: 0deg; }
          100% { --angle: 360deg; }
        }

        body.theme-cyberpunk .btn {
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
        }
        body.theme-cyberpunk .btn-primary {
          background: #00f0ff;
          border: 1px solid #00f0ff;
          color: #0d0c1d;
          box-shadow: 0 0 8px rgba(0, 240, 255, 0.4);
        }
        body.theme-cyberpunk .btn-danger {
          border: 1px solid #ff00ff;
          color: #ff00ff;
          box-shadow: 0 0 8px rgba(255, 0, 255, 0.4);
        }
        body.theme-cyberpunk select {
          background-color: #0d0c1d;
          border: 1px solid #00f0ff;
          color: #00f0ff;
          border-radius: 8px;
        }

        body.theme-cyberpunk .badge {
          background: rgba(255, 179, 0, 0.1);
          color: #ffb300;
          border: 1px solid #ffb300;
          box-shadow: 0 0 8px rgba(255, 179, 0, 0.3);
        }
        body.theme-cyberpunk .badge.active {
          background: rgba(0, 240, 255, 0.1);
          color: #00f0ff;
          border: 1px solid #00f0ff;
          box-shadow: 0 0 8px rgba(0, 240, 255, 0.3);
        }

        body.theme-space {
          --bg-color: #060913;
          --panel-bg: rgba(22, 27, 42, 0.65);
          --border-color: rgba(255, 255, 255, 0.1);
          --text-color: #e3e3e3;
          --label-color: #8fa0b5;
          --btn-bg: #1a2238;
          --btn-hover: #263554;
          --btn-primary: #38bdf8;
          --btn-primary-text: #0f172a;
          --btn-danger: #f87171;
          --btn-danger-text: #450a0a;
          --border-radius: 12px;
          --btn-radius: 8px;
        }
      </style>
    </head>
    <body>
      <!-- backgrounds -->
      <div id="geminiBg" class="glow-bg">
        <div class="blob blob-blue"></div>
        <div class="blob blob-purple"></div>
      </div>

      <div id="spaceBg" class="stars-bg"></div>

      <div id="cyberpunkBg" class="cyberpunk-bg"></div>

      <div class="content">
        <div class="outer-wrapper">
          <div class="inner-wrapper">
            <div class="header">
              <h1 class="title">colabd connection</h1>
              <div class="header-actions">
                <span class="badge ${isRunning ? "active" : ""}">offline</span>
                <button class="settings-btn" onclick="toggleSettings()">⚙</button>
              </div>
            </div>

            <div id="settingsPanel" class="settings-panel">
              <div class="section-title" style="margin-top: 0;">UI Customization</div>
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span>Select Theme</span>
                <select id="themeSelect" onchange="changeTheme(this.value)">
                  <option value="minimal">Minimal (Gemini)</option>
                  <option value="space">Deep Space Tech</option>
                  <option value="cyberpunk">Neo-Retro Cyberpunk</option>
                </select>
              </div>
            </div>

            <div class="panel">
              <div class="panel-inner">
                <table>
                  <tbody>
                    <tr>
                      <td class="label">daemon endpoint</td>
                      <td class="value">localhost:${daemonPort}</td>
                    </tr>
                    <tr>
                      <td class="label">workspace status</td>
                      <td class="value">${activeLink} (${activeLinkPath})</td>
                    </tr>
                    <tr>
                      <td class="label">active session</td>
                      <td class="value">${endpoint}</td>
                    </tr>
                    <tr>
                      <td class="label">consumption rate</td>
                      <td class="value">${rateText}</td>
                    </tr>
                    <tr>
                      <td class="label">quota remaining</td>
                      <td class="value">${usageLeftText}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="section-title">server control</div>
            <div class="button-group" style="margin-bottom: 20px;">
              ${isRunning ? 
                `<button class="btn btn-danger" onclick="triggerCommand(this, 'stopDaemon')"><div class="spinner"></div>Stop Server</button>` : 
                `<button class="btn btn-primary" onclick="triggerCommand(this, 'startDaemon')"><div class="spinner"></div>Start Server</button>`
              }
              <button class="btn" onclick="triggerCommand(this, 'linkWorkspace')" ${!isRunning ? "disabled" : ""}><div class="spinner"></div>Link Folder...</button>
            </div>

            ${isRunning ? `
              <div class="section-title">session allocation</div>
              <div class="button-group" style="margin-bottom: 20px;">
                ${isConnected ? 
                  `<button class="btn btn-danger" onclick="triggerCommand(this, 'teardownSession')"><div class="spinner"></div>Terminate Session</button>` :
                  `
                    <select id="hardwareSelect">
                      <option value="Standard CPU">Standard CPU (Free/Paid Standard)</option>
                      <option value="T4 GPU">T4 GPU (Free/Paid Standard)</option>
                      <option value="L4 GPU">L4 GPU (Paid Premium)</option>
                      <option value="A100 GPU">A100 GPU (Paid Premium)</option>
                      <option value="TPU">TPU (Paid Premium)</option>
                    </select>
                    <button class="btn btn-primary" onclick="provision(this)"><div class="spinner"></div>Claim Session</button>
                  `
                }
              </div>
            ` : ""}

            ${isConnected ? `
              <div class="section-title">development tools</div>
              <div class="button-group">
                <button class="btn btn-primary" onclick="triggerCommand(this, 'forceSync')"><div class="spinner"></div>Sync Now</button>
                <button class="btn" onclick="triggerCommand(this, 'openTerminal')"><div class="spinner"></div>Open Terminal</button>
              </div>
            ` : ""}
          </div>
        </div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();
        
        function triggerCommand(btn, cmd) {
          btn.classList.add("loading");
          vscode.postMessage({ command: cmd });
          setTimeout(() => {
            btn.classList.remove("loading");
          }, 4000);
        }

        function provision(btn) {
          btn.classList.add("loading");
          const hardware = document.getElementById("hardwareSelect").value;
          vscode.postMessage({ command: 'provisionSession', hardware: hardware });
          setTimeout(() => {
            btn.classList.remove("loading");
          }, 8000);
        }

        function toggleSettings() {
          const p = document.getElementById("settingsPanel");
          p.style.display = p.style.display === "block" ? "none" : "block";
        }

        function changeTheme(theme) {
          document.body.className = "theme-" + theme;
          
          document.getElementById("geminiBg").style.display = theme === "minimal" ? "block" : "none";
          document.getElementById("spaceBg").style.display = theme === "space" ? "block" : "none";
          document.getElementById("cyberpunkBg").style.display = theme === "cyberpunk" ? "block" : "none";
          
          vscode.setState({ theme: theme });
        }

        // Starfield generator
        function generateStars() {
          const container = document.getElementById("spaceBg");
          container.innerHTML = "";
          for(let i=0; i<60; i++) {
            const star = document.createElement("div");
            star.className = "star";
            star.style.width = Math.random() * 3 + "px";
            star.style.height = star.style.width;
            star.style.left = Math.random() * 100 + "%";
            star.style.top = Math.random() * 100 + "%";
            star.style.animationDelay = Math.random() * 4 + "s";
            container.appendChild(star);
          }
        }

        // Initialize state
        const state = vscode.getState() || { theme: "minimal" };
        changeTheme(state.theme);
        document.getElementById("themeSelect").value = state.theme;
        generateStars();
      </script>
    </body>
    </html>
  `;
}

function activate(context) {
  const provider = new ColabSyncProvider();
  vscode.window.registerTreeDataProvider("colabSyncControl", provider);

  let activeWebview = null;

  async function updateWebview() {
    if (!activeWebview) return;
    let status = null;
    try {
      status = await new Promise((resolve, reject) => {
        const req = http.get(`${daemonUrl}/v1/status`, { timeout: 1500 }, (res) => {
          let body = "";
          res.on("data", (chunk) => body += chunk);
          res.on("end", () => {
            if (res.statusCode === 200) resolve(JSON.parse(body));
            else resolve(null);
          });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => {
          req.destroy();
          resolve(null);
        });
      });
    } catch {}
    activeWebview.webview.html = getWebviewContent(status);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.openDashboard", () => {
      if (activeWebview) {
        activeWebview.reveal(vscode.ViewColumn.One);
        return;
      }

      activeWebview = vscode.window.createWebviewPanel(
        "colabSyncDashboard",
        "Colab Sync Control Center",
        vscode.ViewColumn.One,
        { enableScripts: true }
      );

      activeWebview.onDidDispose(() => {
        activeWebview = null;
      }, null, context.subscriptions);

      activeWebview.webview.onDidReceiveMessage(async (message) => {
        if (message.command === "startDaemon") {
          vscode.commands.executeCommand("colab-sync.startDaemon");
        } else if (message.command === "stopDaemon") {
          vscode.commands.executeCommand("colab-sync.stopDaemon");
        } else if (message.command === "linkWorkspace") {
          vscode.commands.executeCommand("colab-sync.linkWorkspace");
        } else if (message.command === "teardownSession") {
          vscode.commands.executeCommand("colab-sync.teardownSession");
        } else if (message.command === "forceSync") {
          vscode.commands.executeCommand("colab-sync.forceSync");
        } else if (message.command === "openTerminal") {
          vscode.commands.executeCommand("colab-sync.openTerminal");
        } else if (message.command === "provisionSession") {
          vscode.commands.executeCommand("colab-sync.provisionSessionFromWebview", message.hardware);
        }
      }, null, context.subscriptions);

      updateWebview();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.provisionSessionFromWebview", async (hardware) => {
      let accelerator = "";
      let variant = "DEFAULT";

      if (hardware.startsWith("T4")) {
        variant = "GPU";
        accelerator = "T4";
      } else if (hardware.startsWith("L4")) {
        variant = "GPU";
        accelerator = "L4";
      } else if (hardware.startsWith("A100")) {
        variant = "GPU";
        accelerator = "A100";
      } else if (hardware.startsWith("TPU")) {
        variant = "TPU";
        accelerator = "TPU";
      }

      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Provisioning ${hardware} runtime on Colab...`,
        cancellable: false
      }, async () => {
        try {
          const res = await fetch(`${daemonUrl}/v1/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provision: true, variant, accelerator })
          });
          const data = await res.json();
          if (data.connected) {
            const ep = data.endpoint || "Standard CPU";
            vscode.window.showInformationMessage("Successfully connected to remote session.");
          } else {
            vscode.window.showErrorMessage(`Provisioning failed: ${data.message || "Unknown error"}`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Network error calling daemon: ${err.message}`);
        }
        provider.refresh();
        updateWebview();
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.refreshView", () => {
      provider.refresh();
      updateWebview();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.startDaemon", () => {
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Starting colabd daemon...",
        cancellable: false
      }, async () => {
        return new Promise((resolve) => {
          const workspaceFolders = vscode.workspace.workspaceFolders;
          const workspacePath = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : "/home/crimson/Projects/notebook/colab-gpu-test";
          const child = spawn("node", [
            "/home/crimson/Projects/notebook/colab-sync/src/colabd.js",
            "--workspace",
            workspacePath
          ], {
            stdio: "ignore",
            detached: true,
            env: { ...process.env }
          });
          child.unref();
          setTimeout(() => {
            provider.refresh();
            updateWebview();
            resolve();
          }, 1500);
        });
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.stopDaemon", () => {
      exec("lsof -t -i tcp:8291 -s tcp:listen", (err, stdout) => {
        if (stdout) {
          const pids = stdout.trim().split("\n");
          for (const pid of pids) {
            try {
              process.kill(parseInt(pid, 10), "SIGKILL");
            } catch {}
          }
        }
        setTimeout(() => {
          provider.refresh();
          updateWebview();
        }, 1000);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.linkWorkspace", async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const rootPath = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : null;

      const options = [
        { label: "Link Current Workspace Root", description: rootPath },
        { label: "Link a Subfolder of the Current Workspace...", description: "List and pick a subfolder" },
        { label: "Choose another folder on your system...", description: "Opens directory dialog" }
      ];

      const choice = await vscode.window.showQuickPick(options, { placeHolder: "Select directory to link" });
      if (!choice) return;

      let targetFolder = "";

      if (choice.label === "Link Current Workspace Root") {
        if (!rootPath) {
          vscode.window.showErrorMessage("No open workspace root found.");
          return;
        }
        targetFolder = rootPath;
      } else if (choice.label === "Link a Subfolder of the Current Workspace...") {
        if (!rootPath) {
          vscode.window.showErrorMessage("No open workspace root found.");
          return;
        }
        try {
          const subdirs = fs.readdirSync(rootPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith("."))
            .map(dirent => path.join(rootPath, dirent.name));

          if (subdirs.length === 0) {
            vscode.window.showInformationMessage("No subdirectories found in workspace root.");
            return;
          }

          const pickedSub = await vscode.window.showQuickPick(subdirs, { placeHolder: "Select a subfolder" });
          if (!pickedSub) return;
          targetFolder = pickedSub;
        } catch (err) {
          vscode.window.showErrorMessage(`Failed reading directories: ${err.message}`);
          return;
        }
      } else if (choice.label === "Choose another folder on your system...") {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Select Folder to Link"
        });
        if (!uris || uris.length === 0) return;
        targetFolder = uris[0].fsPath;
      }

      const defaultName = path.basename(targetFolder);
      const linkName = await vscode.window.showInputBox({
        prompt: "Enter a link name for this workspace configuration",
        value: defaultName
      });

      if (!linkName) return;

      exec(`node /home/crimson/Projects/notebook/colab-sync/src/colabd.js link "${targetFolder}" --name "${linkName}"`, (err) => {
        if (err) {
          vscode.window.showErrorMessage(`Linking failed: ${err.message}`);
        } else {
          vscode.window.showInformationMessage("Workspace successfully linked.");
        }
        provider.refresh();
        updateWebview();
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.provisionSession", async () => {
      const selection = await vscode.window.showQuickPick(
        [
          "Standard CPU (Free/Paid Standard)",
          "T4 GPU (Free/Paid Standard)",
          "L4 GPU (Paid Premium)",
          "A100 GPU (Paid Premium)",
          "TPU (Paid Premium)"
        ],
        { placeHolder: "Select accelerator hardware type to provision" }
      );
      if (!selection) return;

      let accelerator = "";
      let variant = "DEFAULT";

      if (selection.startsWith("T4")) {
        variant = "GPU";
        accelerator = "T4";
      } else if (selection.startsWith("L4")) {
        variant = "GPU";
        accelerator = "L4";
      } else if (selection.startsWith("A100")) {
        variant = "GPU";
        accelerator = "A100";
      } else if (selection.startsWith("TPU")) {
        variant = "TPU";
        accelerator = "TPU";
      }

      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Provisioning ${selection} runtime on Colab...`,
        cancellable: false
      }, async () => {
        try {
          const res = await fetch(`${daemonUrl}/v1/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provision: true, variant, accelerator })
          });
          const data = await res.json();
          if (data.connected) {
            const ep = data.endpoint || "Standard CPU";
            vscode.window.showInformationMessage("Successfully connected to remote session.");
          } else {
            vscode.window.showErrorMessage(`Provisioning failed: ${data.message || "Unknown error"}`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Network error calling daemon: ${err.message}`);
        }
        provider.refresh();
        updateWebview();
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.forceSync", () => {
      vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Running bidirectional file synchronization...",
        cancellable: false
      }, async () => {
        try {
          const res = await fetch(`${daemonUrl}/v1/sync?direction=both`, { method: "POST" });
          const data = await res.json();
          vscode.window.showInformationMessage(`Sync complete! Changes tracked: ${JSON.stringify(data.summary || data)}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Sync failed: ${err.message}`);
        }
        provider.refresh();
        updateWebview();
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.teardownSession", () => {
      vscode.window.showWarningMessage("Are you sure you want to terminate the Colab session?", "Yes", "No")
        .then(async (answer) => {
          if (answer === "Yes") {
            try {
              const req = http.request({
                hostname: "127.0.0.1",
                port: daemonPort,
                path: "/v1/status",
                method: "DELETE"
              }, (res) => {
                res.on("data", () => {});
                res.on("end", () => {
                  vscode.window.showInformationMessage("Colab session terminated.");
                  provider.refresh();
                  updateWebview();
                });
              });
              req.on("error", (e) => {
                vscode.window.showErrorMessage(`Failed to terminate session: ${e.message}`);
              });
              req.end();
            } catch (err) {
              vscode.window.showErrorMessage(`Failed to terminate session: ${err.message}`);
            }
          }
        });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.openTerminal", () => {
      const term = vscode.window.createTerminal({
        name: "Colab Shell",
        shellPath: "node",
        shellArgs: ["/home/crimson/Projects/notebook/colab-sync/colab-term.js"]
      });
      term.show();
    })
  );

  const interval = setInterval(() => {
    provider.refresh();
    updateWebview();
  }, 10000);

  context.subscriptions.push({
    dispose: () => clearInterval(interval)
  });
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
