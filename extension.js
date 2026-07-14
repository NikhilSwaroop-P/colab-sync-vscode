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
    } else {
      const daemonItem = new vscode.TreeItem("Daemon: Stopped", vscode.TreeItemCollapsibleState.None);
      daemonItem.iconPath = new vscode.ThemeIcon("stop-circle");
      items.push(daemonItem);
    }

    return items;
  }
}

function getWebviewContent(status) {
  const isRunning = !!status;
  const isConnected = status && status.connected;
  const endpoint = status ? status.endpoint || "CPU Runtime" : "None";
  const activeLink = status && status.activeLink ? status.activeLink.name : "Unlinked";
  const activeLinkPath = status && status.activeLink ? status.activeLink.path : "None";

  let quotaSummary = "No active quota info";
  if (status && status.ccuConsumption) {
    const ccu = status.ccuConsumption;
    const rate = ccu.consumptionRateHourly || 0.08;
    if (ccu.paidComputeUnitsBalance > 0) {
      quotaSummary = `${ccu.paidComputeUnitsBalance.toFixed(1)} CU remaining (~${(ccu.paidComputeUnitsBalance / rate).toFixed(1)} hours)`;
    } else if (ccu.freeCcuQuotaInfo?.remainingTokens) {
      const tokens = parseInt(ccu.freeCcuQuotaInfo.remainingTokens, 10);
      const mins = Math.floor(((tokens / 1000) / rate * 60) / 10) * 10;
      quotaSummary = `Free Tier: ${Math.floor(mins / 60)}h ${mins % 60}m left`;
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
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: #0f141c;
          color: #c9d1d9;
          margin: 0;
          padding: 24px;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #21262d;
          padding-bottom: 16px;
          margin-bottom: 24px;
        }
        .title {
          font-size: 24px;
          font-weight: 600;
          color: #58a6ff;
          margin: 0;
        }
        .status-pulse {
          display: flex;
          align-items: center;
          font-size: 13px;
          font-weight: 500;
          color: ${isRunning ? "#3fb950" : "#f85149"};
        }
        .pulse-dot {
          width: 10px;
          height: 10px;
          background-color: ${isRunning ? "#3fb950" : "#f85149"};
          border-radius: 50%;
          margin-right: 8px;
          box-shadow: 0 0 8px ${isRunning ? "#3fb950" : "#f85149"};
          animation: pulse 2s infinite;
        }
        @keyframes pulse {
          0% { transform: scale(0.95); opacity: 0.5; }
          50% { transform: scale(1.1); opacity: 1; }
          100% { transform: scale(0.95); opacity: 0.5; }
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          gap: 20px;
          margin-bottom: 24px;
        }
        .card {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 12px;
          padding: 20px;
          transition: transform 0.2s, border-color 0.2s;
        }
        .card:hover {
          border-color: #58a6ff;
          transform: translateY(-2px);
        }
        .card-title {
          font-size: 16px;
          font-weight: 600;
          margin-top: 0;
          margin-bottom: 12px;
          color: #f0f6fc;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .card-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
          font-size: 14px;
        }
        .card-label {
          color: #8b949e;
        }
        .card-value {
          color: #f0f6fc;
          font-weight: 500;
        }
        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: #21262d;
          border: 1px solid #30363d;
          color: #c9d1d9;
          padding: 10px 16px;
          font-size: 14px;
          font-weight: 500;
          border-radius: 6px;
          cursor: pointer;
          transition: background 0.2s, border-color 0.2s, color 0.2s;
          text-decoration: none;
          margin-top: 12px;
          width: 100%;
          box-sizing: border-box;
        }
        .btn:hover {
          background: #30363d;
          border-color: #8b949e;
          color: #f0f6fc;
        }
        .btn-primary {
          background: #238636;
          border-color: #2ea043;
          color: #ffffff;
        }
        .btn-primary:hover {
          background: #2ea043;
          border-color: #3fb950;
          color: #ffffff;
        }
        .btn-danger {
          background: #da3637;
          border-color: #f85149;
          color: #ffffff;
        }
        .btn-danger:hover {
          background: #f85149;
          border-color: #ff7b72;
          color: #ffffff;
        }
        select {
          width: 100%;
          padding: 8px;
          background: #0f141c;
          border: 1px solid #30363d;
          color: #c9d1d9;
          border-radius: 6px;
          margin-top: 8px;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1 class="title">Colab Sync Control Center</h1>
        <div class="status-pulse">
          <div class="pulse-dot"></div>
          <span>${isRunning ? "Daemon Connected" : "Daemon Offline"}</span>
        </div>
      </div>

      <div class="grid">
        <div class="card">
          <h2 class="card-title">Daemon Server</h2>
          <div class="card-row">
            <span class="card-label">Server Port</span>
            <span class="card-value">${daemonPort}</span>
          </div>
          <div class="card-row">
            <span class="card-label">Status</span>
            <span class="card-value">${isRunning ? "Running" : "Stopped"}</span>
          </div>
          ${isRunning ? 
            `<button class="btn btn-danger" onclick="sendCommand('stopDaemon')">Stop Daemon Server</button>` : 
            `<button class="btn btn-primary" onclick="sendCommand('startDaemon')">Start Daemon Server</button>`
          }
        </div>

        <div class="card">
          <h2 class="card-title">Linked Workspace</h2>
          <div class="card-row">
            <span class="card-label">Link Name</span>
            <span class="card-value">${activeLink}</span>
          </div>
          <div class="card-row">
            <span class="card-label">Local Path</span>
            <span class="card-value" style="font-size:12px; word-break:break-all;">${activeLinkPath}</span>
          </div>
          <button class="btn" onclick="sendCommand('linkWorkspace')" ${!isRunning ? "disabled" : ""}>Change Linked Folder...</button>
        </div>

        <div class="card">
          <h2 class="card-title">Colab Session</h2>
          <div class="card-row">
            <span class="card-label">Hardware</span>
            <span class="card-value">${endpoint}</span>
          </div>
          <div class="card-row">
            <span class="card-label">Quota Info</span>
            <span class="card-value">${quotaSummary}</span>
          </div>
          ${isConnected ? 
            `<button class="btn btn-danger" onclick="sendCommand('teardownSession')">Disconnect Session</button>` :
            `
              <div>
                <select id="hardwareSelect">
                  <option value="Standard CPU">Standard CPU (Free/Paid Standard)</option>
                  <option value="T4 GPU">T4 GPU (Free/Paid Standard)</option>
                  <option value="L4 GPU">L4 GPU (Paid Premium)</option>
                  <option value="A100 GPU">A100 GPU (Paid Premium)</option>
                  <option value="TPU">TPU (Paid Premium)</option>
                </select>
                <button class="btn btn-primary" onclick="provision()">Claim Active Session</button>
              </div>
            `
          }
        </div>
      </div>

      ${isConnected ? `
        <div class="grid" style="grid-template-columns: 1fr;">
          <div class="card">
            <h2 class="card-title" style="color:#58a6ff;">Development Tools</h2>
            <div style="display:flex; gap:16px; flex-wrap:wrap;">
              <button class="btn btn-primary" style="flex:1; min-width:200px;" onclick="sendCommand('forceSync')">Run Sync Sync</button>
              <button class="btn" style="flex:1; min-width:200px;" onclick="sendCommand('openTerminal')">Launch Interactive Terminal</button>
            </div>
          </div>
        </div>
      ` : ""}

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
          vscode.window.showInformationMessage(`Workspace successfully linked as '${linkName}'`);
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
