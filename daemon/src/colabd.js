import path from "node:path";
import { ColabAuth } from "./colab-auth.js";
import { ColabRuntime } from "./colab-runtime.js";
import { LocalFS } from "./local-fs.js";
import { ColabContentsBackend } from "./contents-backend.js";
import { BaselineStore } from "./baseline.js";
import { SyncEngine } from "./sync-engine.js";
import { GitTracker } from "./git-tracker.js";
import { loadColabignore, compileIgnoreRules } from "./colabignore.js";
import {
  loadConfig,
  loadGlobalLinks,
  addLink,
  removeLink
} from "./config.js";
import { createServer } from "./http-server.js";

class LinksRegistry {
  constructor(rt) {
    this.rt = rt;
    this.links = new Map();
  }

  async reload() {
    const list = await loadGlobalLinks();
    const newLinks = new Map();
    for (const item of list) {
      const rootPath = item.path;
      const localFS = new LocalFS(rootPath);
      const remoteBackend = new ColabContentsBackend(this.rt, `content/workspaces/${item.name}`);
      const baselineStore = new BaselineStore(this.rt.endpoint || "offline", rootPath);
      const gitTracker = new GitTracker(rootPath);
      await gitTracker.init();

      const ignorePatterns = await loadColabignore(rootPath);
      const ignoreRules = compileIgnoreRules(ignorePatterns);

      const syncEngine = new SyncEngine({
        localFS,
        remoteBackend,
        baselineStore,
        ignoreRules
      });

      newLinks.set(item.name, {
        name: item.name,
        path: rootPath,
        localFS,
        remoteBackend,
        baselineStore,
        gitTracker,
        syncEngine,
        ignoreRules
      });
    }
    this.links = newLinks;
  }

  getLink(name) {
    if (!name) {
      return null;
    }
    return this.links.get(name) || null;
  }

  async listLinks() {
    return Array.from(this.links.values()).map(ctx => ({
      name: ctx.name,
      path: ctx.path
    }));
  }
}

function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      opts.port = args[i + 1];
      i++;
    } else if (args[i] === "--workspace" && args[i + 1]) {
      opts.workspace = args[i + 1];
      i++;
    } else if (args[i] === "--provision" && args[i + 1]) {
      opts.provision = args[i + 1];
      i++;
    }
  }
  return opts;
}

async function runCli() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "link") {
    const targetPath = args[1] || process.cwd();
    let name = "default";
    const nameIndex = args.indexOf("--name");
    if (nameIndex !== -1 && args[nameIndex + 1]) {
      name = args[nameIndex + 1];
    }
    await addLink(targetPath, name);
    const tracker = new GitTracker(targetPath);
    await tracker.init();
    console.log(`Linked folder ${targetPath} as '${name}'`);
    process.exit(0);
  }

  if (command === "unlink") {
    const targetPath = args[1] || process.cwd();
    await removeLink(targetPath);
    console.log(`Unlinked folder ${targetPath}`);
    process.exit(0);
  }

  if (command === "list-links") {
    const links = await loadGlobalLinks();
    console.log(JSON.stringify(links, null, 2));
    process.exit(0);
  }
}

async function main() {
  await runCli();

  const cliOpts = parseArgs(process.argv.slice(2));
  let config;
  try {
    config = await loadConfig(cliOpts);
  } catch (err) {
    console.error("Config error:", err.message);
    process.exit(1);
  }

  const auth = new ColabAuth();
  await auth.load();

  const rt = new ColabRuntime({ auth });
  let connected = false;

  try {
    await rt.connect({ provision: config.provision });
    rt.startKeepAlive();
    connected = true;
    console.log(`Connected to Colab runtime endpoint: ${rt.endpoint}`);
  } catch (err) {
    console.warn("Could not connect to Colab runtime on startup:", err.message);
  }

  const registry = new LinksRegistry(rt);
  await registry.reload();

  const server = createServer(config, rt, registry);

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Error: Port ${config.port} is already in use. Suggest using --port override.`);
      process.exit(1);
    } else {
      console.error("Server error:", err);
    }
  });

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`colabd running on http://127.0.0.1:${config.port}`);
  });

  let syncTimer = null;
  const watchers = [];

  const startWatchers = () => {
    for (const w of watchers) {
      if (w && typeof w.close === "function") w.close();
    }
    watchers.length = 0;

    for (const ctx of registry.links.values()) {
      let debounceTimer;
      const w = ctx.localFS.watch((event, filename) => {
        if (filename) {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            if (config.pauseAutoSync) return;
            if (rt.baseUrl) {
              try {
                await ctx.syncEngine.sync();
                await ctx.gitTracker.commit(`sync ${new Date().toISOString()}`);
              } catch (e) {
                console.error(`Sync error on link ${ctx.name}:`, e.message);
              }
            }
          }, 500);
        }
      });
      watchers.push(w);
    }
  };

  startWatchers();

  const triggerPeriodicSync = async () => {
    if (config.pauseAutoSync) return;
    if (rt.baseUrl) {
      for (const ctx of registry.links.values()) {
        try {
          await ctx.syncEngine.sync();
          await ctx.gitTracker.commit(`sync ${new Date().toISOString()}`);
        } catch (e) {
          console.error(`Periodic sync error on link ${ctx.name}:`, e.message);
        }
      }
    }
  };

  if (config.syncIntervalMs > 0) {
    syncTimer = setInterval(triggerPeriodicSync, config.syncIntervalMs);
  }

  const oldRegistryReload = registry.reload.bind(registry);
  registry.reload = async () => {
    await oldRegistryReload();
    startWatchers();
  };

  const shutdown = async () => {
    console.log("\nShutting down...");
    if (syncTimer) clearInterval(syncTimer);
    for (const w of watchers) {
      if (w && typeof w.close === "function") w.close();
    }
    rt.stopKeepAlive();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(err => {
  console.error("Fatal colabd daemon error:", err);
  process.exit(1);
});
