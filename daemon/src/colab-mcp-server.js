import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const COLABD_PORT = 8291;
const COLABD_URL = `http://127.0.0.1:${COLABD_PORT}`;
let currentPwd = "/content";

async function ensureColabd() {
  try {
    const res = await fetch(`${COLABD_URL}/v1/status`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return;
  } catch {}

  const colabdDir = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn("node", [path.join(colabdDir, "colabd.js"), "--workspace", "/home/crimson/Projects/notebook/colab-gpu-test"], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env }
  });
  child.unref();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(`${COLABD_URL}/v1/status`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {}
  }
  throw new Error("colabd failed to start within 30s");
}

async function colabdFetch(path, opts = {}) {
  const url = `${COLABD_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    signal: opts.timeout ? AbortSignal.timeout(opts.timeout * 1000) : undefined
  });
  return res;
}

const server = new McpServer({
  name: "colabd",
  version: "1.0.0"
});

server.tool(
  "colab_execute",
  "Execute a shell command on the connected Colab GPU runtime. Use for python, pip, nvidia-smi, model training, etc.",
  {
    command: z.string().describe("Shell command to execute"),
    timeout: z.number().optional().default(120).describe("Max wait seconds"),
    workdir: z.string().optional().describe("Change directory before execution")
  },
  async ({ command, timeout, workdir }) => {
    await ensureColabd();
    const finalCmd = workdir ? `cd ${workdir} && ${command}` : command;
    const res = await colabdFetch("/v1/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: finalCmd }),
      timeout: timeout ?? 120
    });
    const data = await res.json();
    if (data.output) {
      const pwdMatch = data.output.match(/__PWD_(.*)__/);
      if (pwdMatch) currentPwd = pwdMatch[1].trim();
    }
    const clean = data.output ? data.output.replace(/__PWD_.*__\r?\n?/g, "").trim() : "";
    return {
      content: [{ type: "text", text: clean || "(no output)" }],
      isError: !!data.error
    };
  }
);

server.tool(
  "colab_interrupt",
  "Interrupt the currently running command on Colab (like Ctrl+C). Use when a command is hung or taking too long.",
  {},
  async () => {
    await ensureColabd();
    await colabdFetch("/v1/exec/interrupt", { method: "POST" });
    return { content: [{ type: "text", text: "Interrupted" }] };
  }
);

server.tool(
  "colab_status",
  "Get runtime status: connection state, GPU type, endpoint, CCU quota (paid/free minutes remaining). Call before executing commands to verify connectivity.",
  {},
  async () => {
    await ensureColabd();
    const res = await colabdFetch("/v1/status");
    const data = await res.json();
    const ccu = data.ccuConsumption;
    let quotaText = "";
    if (ccu) {
      const rate = ccu.consumptionRateHourly || 0.08;
      if (ccu.paidComputeUnitsBalance > 0) {
        quotaText = `Compute Units: ${ccu.paidComputeUnitsBalance.toFixed(1)} (~${(ccu.paidComputeUnitsBalance / rate).toFixed(1)}h)`;
      } else if (ccu.freeCcuQuotaInfo?.remainingTokens) {
        const tokens = parseInt(ccu.freeCcuQuotaInfo.remainingTokens, 10);
        const mins = Math.floor(((tokens / 1000) / rate * 60) / 10) * 10;
        quotaText = `Free GPU: ${Math.floor(mins / 60)}h ${mins % 60}m left`;
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ ...data, quotaSummary: quotaText }, null, 2) }]
    };
  }
);

server.tool(
  "colab_provision",
  "Provision a new Colab runtime. Defaults to GPU T4. Use when disconnected.",
  {
    variant: z.enum(["DEFAULT", "GPU", "TPU"]).optional().default("GPU").describe("Machine variant"),
    accelerator: z.string().optional().default("T4").describe("Accelerator model name")
  },
  async ({ variant, accelerator }) => {
    await ensureColabd();
    const res = await colabdFetch("/v1/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provision: true, variant: variant || "GPU", accelerator: accelerator || "T4" })
    });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "colab_unassign",
  "Terminate the Colab runtime session. Frees GPU/TPU quota. Like 'teardown' in colab-term shell.",
  {},
  async () => {
    await ensureColabd();
    const res = await colabdFetch("/v1/status", { method: "DELETE" });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "colab_sync",
  "Bidirectional file sync. Use push after local edits, pull after remote commands generate files.",
  {
    direction: z.enum(["both", "push", "pull"]).optional().default("both").describe("Sync direction")
  },
  async ({ direction }) => {
    await ensureColabd();
    const res = await colabdFetch(`/v1/sync?direction=${direction || "both"}`, { method: "POST" });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "colab_grep",
  "Search file contents on Colab by regex. Avoids syncing everything to find files.",
  {
    pattern: z.string().describe("Regex search pattern"),
    maxResults: z.number().optional().default(50).describe("Max results to return")
  },
  async ({ pattern, maxResults }) => {
    await ensureColabd();
    const res = await colabdFetch("/v1/grep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern, maxResults })
    });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "colab_terminal_url",
  "Returns the WebSocket URL for an interactive Colab terminal. Connect with a WS client for real-time shell access.",
  {},
  async () => {
    return { content: [{ type: "text", text: "ws://127.0.0.1:8291/v1/term" }] };
  }
);

server.tool(
  "colab_sync_config",
  "Configure auto-sync behavior, e.g., pause or resume auto-sync",
  {
    pauseAutoSync: z.boolean().describe("True to pause auto-sync, false to resume")
  },
  async ({ pauseAutoSync }) => {
    await ensureColabd();
    const res = await colabdFetch("/v1/config/auto-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pauseAutoSync })
    });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
