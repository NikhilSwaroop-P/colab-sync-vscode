import readline from "node:readline";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const port = 8291;
let isExecuting = false;
let currentPwd = "/content";
let endpoint = "T4 GPU";
let rl;

const updatePrompt = () => {
  if (rl) {
    rl.setPrompt(`\x1b[1;36mcolab-shell\x1b[0m [\x1b[38;5;220m${endpoint}\x1b[0m:\x1b[1;34m${currentPwd}\x1b[0m] \x1b[1;36m>\x1b[0m `);
  }
};

async function runCommand(cmd) {
  isExecuting = true;
  let firstChunk = true;
  return new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: port,
      path: "/v1/exec/stream",
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    }, (res) => {
      res.on("data", (chunk) => {
        let text = chunk.toString();
        if (firstChunk) {
          const trimmed = text.replace(/^[\r\n\s]+/, "");
          if (trimmed.length > 0) {
            text = trimmed;
            firstChunk = false;
          } else {
            return;
          }
        }
        const pwdMatch = text.match(/__PWD_(.*)__/);
        if (pwdMatch) {
          currentPwd = pwdMatch[1].trim();
          updatePrompt();
          text = text.replace(/__PWD_.*__\r?\n?/, "");
        }
        process.stdout.write(text);
      });
      res.on("end", () => {
        isExecuting = false;
        resolve();
      });
    });

    req.on("error", (err) => {
      console.error("\nExecution error:", err.message);
      isExecuting = false;
      resolve();
    });

    req.write(JSON.stringify({ command: cmd }));
    req.end();
  });
}

async function getQuotaText() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/status`);
    const status = await r.json();
    if (status.endpoint) {
      endpoint = status.endpoint;
    }
    const ccu = status.ccuConsumption;
    if (ccu) {
      const rate = ccu.consumptionRateHourly || 0.08;
      if (ccu.paidComputeUnitsBalance > 0) {
        const hours = (ccu.paidComputeUnitsBalance / rate).toFixed(1);
        return `Compute Units: ${ccu.paidComputeUnitsBalance.toFixed(1)} (~${hours} hours left)`;
      } else if (ccu.freeCcuQuotaInfo && ccu.freeCcuQuotaInfo.remainingTokens) {
        const tokens = parseInt(ccu.freeCcuQuotaInfo.remainingTokens, 10);
        const minutesTotal = Math.floor(((tokens / 1000) / rate * 60) / 10) * 10;
        const o = Math.floor(minutesTotal / 60);
        const s = minutesTotal % 60;
        return `Free GPU Computing: ${o}h ${s}m left`;
      } else {
        return "Compute Quota: Free Tier";
      }
    } else {
      return "Compute Quota: Offline / Uncached";
    }
  } catch {
    return "Compute Quota: Daemon unreachable";
  }
}
async function main() {
  let workspacePath = process.cwd();
  let activeLinkName = "";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/status`);
    const status = await r.json();
    if (status.endpoint) {
      endpoint = status.endpoint;
    }
    if (status.activeLink && status.activeLink.path) {
      workspacePath = status.activeLink.path;
      activeLinkName = status.activeLink.name || "";
    }
  } catch {}

  const usageText = await getQuotaText();

  const completer = (line, callback) => {
    let localPwd = null;
    const prefixes = [
      '/content/workspaces/' + (activeLinkName || path.basename(workspacePath)),
      '/content/workspaces/' + path.basename(workspacePath)
    ];
    for (const p of prefixes) {
      if (currentPwd.startsWith(p)) {
        const rel = currentPwd.substring(p.length);
        localPwd = path.join(workspacePath, rel);
        break;
      }
    }

    const commands = ["ls", "cd", "cat", "python", "python3", "pip", "git", "curl", "clear", "usage", "quota", "teardown", "help", "exit"];
    const parts = line.split(/\s+/);
    const lastPart = parts[parts.length - 1] || "";
    
    let dirToRead = localPwd;
    let prefix = lastPart;
    let dirPrefix = "";
    
    if (lastPart.includes("/")) {
      const lastSlash = lastPart.lastIndexOf("/");
      dirPrefix = lastPart.substring(0, lastSlash + 1);
      prefix = lastPart.substring(lastSlash + 1);
      dirToRead = path.join(localPwd, dirPrefix);
    }
    
    if (!localPwd) {
      const hits = commands.filter(c => c.startsWith(lastPart));
      if (!line.includes(" ") && hits.length) {
        return callback(null, [hits, lastPart]);
      }
      return callback(null, [[], line]);
    }
    
    fs.readdir(dirToRead)
      .then(async (files) => {
        const completions = [];
        if (!line.includes(" ")) {
           completions.push(...commands);
        }
        for (const f of files) {
           try {
             const stat = await fs.stat(path.join(dirToRead, f));
             completions.push(dirPrefix + f + (stat.isDirectory() ? "/" : ""));
           } catch {
             completions.push(dirPrefix + f);
           }
        }
        
        const hits = completions.filter(c => c.startsWith(lastPart));
        if (hits.length) {
          callback(null, [hits, lastPart]);
        } else {
          callback(null, [[], line]);
        }
      })
      .catch(() => {
        const hits = commands.filter(c => c.startsWith(lastPart));
        if (!line.includes(" ") && hits.length) {
          callback(null, [hits, lastPart]);
        } else {
          callback(null, [[], line]);
        }
      });
  };

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: completer,
    prompt: `\x1b[1;36mcolab-shell\x1b[0m [\x1b[38;5;220m${endpoint}\x1b[0m:\x1b[1;34m${currentPwd}\x1b[0m] \x1b[1;36m>\x1b[0m `
  });

  console.log(`\x1b[1;36m=== Colab Local-Buffered Interactive Shell ===\x1b[0m`);
  console.log(`\x1b[2m${usageText}\x1b[0m`);
  console.log("Commands are typed locally (zero lag) and streamed on Enter. Type 'help' for support.\n");

  rl.prompt();

  rl.on("line", async (line) => {
    const cmd = line.trim();
    if (!cmd) {
      rl.prompt();
      return;
    }

    if (cmd === "exit" || cmd === "quit") {
      rl.close();
      return;
    }

    if (cmd === "help" || cmd === "?") {
      console.log("\nColab Shell Commands:");
      console.log("  exit / quit             - Close and exit the interactive shell window.");
      console.log("  teardown / kill-session - Terminate the active Colab GPU/CPU runtime session.");
      console.log("  usage / quota           - Print remaining paid or free compute unit balances.");
      console.log("  clear                   - Clear the console terminal screen buffer.");
      console.log("  help / ?                - Show this help command listing.");
      console.log("  [any other command]     - Executed remotely on the connected Colab runtime instance.");
      rl.prompt();
      return;
    }

    if (cmd === "teardown" || cmd === "kill-session") {
      console.log("\nTerminating active Colab GPU session...");
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/status`, { method: "DELETE" });
        const res = await r.json();
        console.log(`Successfully unassigned: ${res.endpoint}`);
      } catch (err) {
        console.error("Failed to terminate session:", err.message);
      }
      rl.close();
      return;
    }

    if (cmd === "usage" || cmd === "quota") {
      const liveUsage = await getQuotaText();
      console.log(liveUsage);
      rl.prompt();
      return;
    }

    if (cmd === "clear") {
      process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
      rl.prompt();
      return;
    }

    rl.pause();
    await runCommand(cmd);
    rl.resume();
    rl.prompt();
  });

  const handleInterrupt = async () => {
    if (isExecuting) {
      try {
        await fetch(`http://127.0.0.1:${port}/v1/exec/interrupt`, { method: "POST" });
      } catch {}
    } else {
      console.log("^C");
      rl.prompt();
    }
  };

  rl.on("SIGINT", handleInterrupt);
  process.on("SIGINT", handleInterrupt);

  rl.on("close", () => {
    console.log("\nExited shell.");
    process.exit(0);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
