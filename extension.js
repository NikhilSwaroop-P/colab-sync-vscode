const vscode = require("vscode");
const { exec, spawn } = require("child_process");
const http = require("http");

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

    const divider = new vscode.TreeItem("────────────────────", vscode.TreeItemCollapsibleState.None);
    divider.label = "─".repeat(24);

    if (status) {
      const daemonItem = new vscode.TreeItem("Daemon: Running (Port 8291)", vscode.TreeItemCollapsibleState.None);
      daemonItem.iconPath = new vscode.ThemeIcon("check-all");
      daemonItem.contextValue = "daemon-running";
      items.push(daemonItem);

      if (status.activeLink) {
        const linkItem = new vscode.TreeItem(`Workspace: Linked (${status.activeLink.name})`, vscode.TreeItemCollapsibleState.None);
        linkItem.iconPath = new vscode.ThemeIcon("link");
        linkItem.contextValue = "link-linked";
        items.push(linkItem);
      } else {
        const linkItem = new vscode.TreeItem("Workspace: Unlinked", vscode.TreeItemCollapsibleState.None);
        linkItem.iconPath = new vscode.ThemeIcon("bracket-error");
        linkItem.contextValue = "link-unlinked";
        items.push(linkItem);
      }

      if (status.connected && status.endpoint) {
        const sessionItem = new vscode.TreeItem(`Session: ${status.endpoint}`, vscode.TreeItemCollapsibleState.Expanded);
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
            sessionItem.quota = `Free GPU Quota: ${Math.floor(mins / 60)}h ${mins % 60}m left`;
          }
        }
        items.push(sessionItem);
      } else {
        const noSessionItem = new vscode.TreeItem("No active GPU sessions", vscode.TreeItemCollapsibleState.None);
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

      const linkBtn = new vscode.TreeItem(status.activeLink ? "Change Linked Workspace..." : "Link Current Workspace...", vscode.TreeItemCollapsibleState.None);
      linkBtn.iconPath = new vscode.ThemeIcon("link");
      linkBtn.command = {
        command: "colab-sync.linkWorkspace",
        title: "Link Workspace"
      };
      items.push(linkBtn);

      if (!status.connected) {
        const provisionBtn = new vscode.TreeItem("Provision GPU Session...", vscode.TreeItemCollapsibleState.None);
        provisionBtn.iconPath = new vscode.ThemeIcon("cloud-upload");
        provisionBtn.command = {
          command: "colab-sync.provisionSession",
          title: "Provision GPU Session"
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

        const disconnectBtn = new vscode.TreeItem("Terminate GPU Session", vscode.TreeItemCollapsibleState.None);
        disconnectBtn.iconPath = new vscode.ThemeIcon("trash");
        disconnectBtn.command = {
          command: "colab-sync.teardownSession",
          title: "Terminate GPU Session"
        };
        items.push(disconnectBtn);
      }

    } else {
      const daemonItem = new vscode.TreeItem("Daemon: Stopped", vscode.TreeItemCollapsibleState.None);
      daemonItem.iconPath = new vscode.ThemeIcon("stop-circle");
      daemonItem.contextValue = "daemon-stopped";
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

function activate(context) {
  const provider = new ColabSyncProvider();
  vscode.window.registerTreeDataProvider("colabSyncControl", provider);

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.refreshView", () => {
      provider.refresh();
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
        }, 1000);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.linkWorkspace", async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage("No open workspace folders to link.");
        return;
      }
      const folderPath = workspaceFolders[0].uri.fsPath;
      const folderName = workspaceFolders[0].name;

      const linkName = await vscode.window.showInputBox({
        prompt: "Enter a link name for this workspace",
        value: folderName
      });

      if (!linkName) return;

      exec(`node /home/crimson/Projects/notebook/colab-sync/src/colabd.js link "${folderPath}" --name "${linkName}"`, (err) => {
        if (err) {
          vscode.window.showErrorMessage(`Linking failed: ${err.message}`);
        } else {
          vscode.window.showInformationMessage(`Workspace linked as '${linkName}'`);
        }
        provider.refresh();
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.provisionSession", async () => {
      const selection = await vscode.window.showQuickPick(
        ["T4 GPU (Free/Paid)", "L4 GPU (Paid Premium)", "A100 GPU (Paid Premium)", "TPU (Paid Premium)"],
        { placeHolder: "Select accelerator hardware type to provision" }
      );
      if (!selection) return;

      let accelerator = "T4";
      let variant = "GPU";
      if (selection.startsWith("L4")) {
        accelerator = "L4";
      } else if (selection.startsWith("A100")) {
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
            vscode.window.showInformationMessage(`Successfully connected to remote ${data.endpoint}`);
          } else {
            vscode.window.showErrorMessage(`Provisioning failed: ${data.message || "Unknown error"}`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Network error calling daemon: ${err.message}`);
        }
        provider.refresh();
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
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("colab-sync.teardownSession", () => {
      vscode.window.showWarningMessage("Are you sure you want to terminate the Colab GPU session?", "Yes", "No")
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
                  vscode.window.showInformationMessage("Colab GPU session terminated.");
                  provider.refresh();
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
