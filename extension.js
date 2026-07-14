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
        const req = http.get(`${daemonUrl}/v1/status`, { timeout: 1000 }, (res) => {
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
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #000000;
          color: #e3e3e3;
          margin: 0;
          padding: 24px;
          height: 100vh;
          box-sizing: border-box;
          overflow: hidden;
          position: relative;
        }
        
        .glow-bg {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 1;
          pointer-events: none;
          overflow: hidden;
          background: #000000;
        }

        .blob {
          position: absolute;
          border-radius: 50%;
          filter: blur(100px);
          opacity: 0.12;
          mix-blend-mode: screen;
        }

        .blob-blue {
          width: 350px;
          height: 350px;
          background: #4285f4;
          bottom: -50px;
          left: 20%;
          animation: floatBlue 25s ease-in-out infinite alternate;
        }

        .blob-purple {
          width: 300px;
          height: 300px;
          background: #a855f7;
          bottom: -80px;
          right: 25%;
          animation: floatPurple 20s ease-in-out infinite alternate;
        }

        @keyframes floatBlue {
          0% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(50px, -30px) scale(1.1); }
          100% { transform: translate(-30px, 15px) scale(0.9); }
        }

        @keyframes floatPurple {
          0% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(-40px, -50px) scale(0.9); }
          100% { transform: translate(30px, 20px) scale(1.15); }
        }

        .content {
          position: relative;
          z-index: 2;
        }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 24px;
        }
        .title {
          font-size: 18px;
          font-weight: 500;
          color: #e3e3e3;
          margin: 0;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          font-size: 11px;
          font-weight: 500;
          padding: 4px 10px;
          border-radius: 20px;
          background: ${isRunning ? "rgba(56, 139, 253, 0.1)" : "rgba(248, 81, 73, 0.1)"};
          color: ${isRunning ? "#58a6ff" : "#ff7b72"};
          border: 1px solid ${isRunning ? "rgba(56, 139, 253, 0.25)" : "rgba(248, 81, 73, 0.25)"};
        }
        .panel {
          background: #131314;
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 16px;
          padding: 20px;
          margin-bottom: 20px;
          backdrop-filter: blur(10px);
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        td {
          padding: 10px 14px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }
        tr:last-child td {
          border-bottom: none;
        }
        .label {
          color: #8e918f;
          width: 220px;
        }
        .value {
          color: #e3e3e3;
          font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace;
        }
        .section-title {
          font-size: 12px;
          font-weight: 500;
          color: #8e918f;
          margin-top: 20px;
          margin-bottom: 10px;
          text-transform: uppercase;
          letter-spacing: 0.8px;
        }
        .button-group {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .btn {
          background: #1e1f20;
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: #e3e3e3;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 500;
          border-radius: 20px;
          cursor: pointer;
          transition: background 0.2s, border-color 0.2s;
        }
        .btn:hover {
          background: #2a2b2d;
          border-color: rgba(255, 255, 255, 0.15);
        }
        .btn-primary {
          background: #a8c7fa;
          border-color: #a8c7fa;
          color: #062e6f;
        }
        .btn-primary:hover {
          background: #c2e7ff;
          border-color: #c2e7ff;
        }
        .btn-danger {
          background: #ffb4ab;
          border-color: #ffb4ab;
          color: #690005;
        }
        .btn-danger:hover {
          background: #ffdad6;
          border-color: #ffdad6;
        }
        select {
          background: #131314;
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #e3e3e3;
          padding: 8px 16px;
          font-size: 13px;
          border-radius: 20px;
          margin-right: 10px;
          outline: none;
        }
      </style>
    </head>
    <body>
      <div class="glow-bg">
        <div class="blob blob-blue"></div>
        <div class="blob blob-purple"></div>
      </div>

      <div class="content">
        <div class="header">
          <h1 class="title">colabd connection</h1>
          <span class="badge">${isRunning ? "active" : "offline"}</span>
        </div>

        <div class="panel">
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

        <div class="section-title">server control</div>
        <div class="button-group" style="margin-bottom: 20px;">
          ${isRunning ? 
            `<button class="btn btn-danger" onclick="sendCommand('stopDaemon')">Stop Server</button>` : 
            `<button class="btn btn-primary" onclick="sendCommand('startDaemon')">Start Server</button>`
          }
          <button class="btn" onclick="sendCommand('linkWorkspace')" ${!isRunning ? "disabled" : ""}>Link Folder...</button>
        </div>

        ${isRunning ? `
          <div class="section-title">session allocation</div>
          <div class="button-group" style="margin-bottom: 20px;">
            ${isConnected ? 
              `<button class="btn btn-danger" onclick="sendCommand('teardownSession')">Terminate Session</button>` :
              `
                <select id="hardwareSelect">
                  <option value="Standard CPU">Standard CPU (Free/Paid Standard)</option>
                  <option value="T4 GPU">T4 GPU (Free/Paid Standard)</option>
                  <option value="L4 GPU">L4 GPU (Paid Premium)</option>
                  <option value="A100 GPU">A100 GPU (Paid Premium)</option>
                  <option value="TPU">TPU (Paid Premium)</option>
                </select>
                <button class="btn btn-primary" onclick="provision()">Claim Session</button>
              `
            }
          </div>
        ` : ""}

        ${isConnected ? `
          <div class="section-title">development tools</div>
          <div class="button-group">
            <button class="btn btn-primary" onclick="sendCommand('forceSync')">Sync Now</button>
            <button class="btn" onclick="sendCommand('openTerminal')">Open Terminal</button>
          </div>
        ` : ""}
      </div>

      <script>
        const vscode = acquireVsCodeApi();
        function sendCommand(cmd) {
          vscode.postMessage({ command: cmd });
        }
        function provision() {
          const hardware = document.getElementById("hardwareSelect").value;
          vscode.postMessage({ command: 'provisionSession', hardware: hardware });
        }
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
        const req = http.get(`${daemonUrl}/v1/status`, { timeout: 800 }, (res) => {
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
      exec("lsof -t -i :8291", (err, stdout) => {
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
            vscode.window.showInformationMessage(`Successfully connected to remote ${ep}`);
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
