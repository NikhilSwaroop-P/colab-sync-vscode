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

    if (status) {
      const daemonItem = new vscode.TreeItem("Daemon: Running (Port 8291)", vscode.TreeItemCollapsibleState.None);
      daemonItem.iconPath = new vscode.ThemeIcon("play-circle");
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
    } else {
      const daemonItem = new vscode.TreeItem("Daemon: Stopped", vscode.TreeItemCollapsibleState.None);
      daemonItem.iconPath = new vscode.ThemeIcon("stop-circle");
      daemonItem.contextValue = "daemon-stopped";
      items.push(daemonItem);

      const linkItem = new vscode.TreeItem("Workspace: (Start daemon first)", vscode.TreeItemCollapsibleState.None);
      linkItem.iconPath = new vscode.ThemeIcon("question");
      items.push(linkItem);
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
