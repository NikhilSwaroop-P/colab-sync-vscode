import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const GLOBAL_DIR = path.join(os.homedir(), ".config", "colabd");
const GLOBAL_CONFIG_PATH = path.join(GLOBAL_DIR, "config.json");
const GLOBAL_LINKS_PATH = path.join(GLOBAL_DIR, "links.json");

const GLOBAL_DEFAULTS = {
  port: 8291,
  syncIntervalMs: 30000,
  provision: false
};

export async function loadGlobalConfig(cliOpts = {}) {
  let config = { ...GLOBAL_DEFAULTS };
  try {
    const raw = await fs.readFile(GLOBAL_CONFIG_PATH, "utf8");
    config = { ...config, ...JSON.parse(raw) };
  } catch {
    await fs.mkdir(GLOBAL_DIR, { recursive: true });
    await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(GLOBAL_DEFAULTS, null, 2), "utf8");
  }
  if (cliOpts.port) config.port = Number(cliOpts.port);
  if (cliOpts.provision !== undefined) config.provision = cliOpts.provision === "true" || cliOpts.provision === true;
  return config;
}

export async function loadGlobalLinks() {
  try {
    const raw = await fs.readFile(GLOBAL_LINKS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function saveGlobalLinks(links) {
  await fs.mkdir(GLOBAL_DIR, { recursive: true });
  await fs.writeFile(GLOBAL_LINKS_PATH, JSON.stringify(links, null, 2), "utf8");
}

export async function loadLocalLinkConfig(rootPath) {
  const localConfigPath = path.join(rootPath, ".colab", "config.json");
  try {
    const raw = await fs.readFile(localConfigPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveLocalLinkConfig(rootPath, cfg) {
  const localDir = path.join(rootPath, ".colab");
  await fs.mkdir(localDir, { recursive: true });
  const localConfigPath = path.join(localDir, "config.json");
  await fs.writeFile(localConfigPath, JSON.stringify(cfg, null, 2), "utf8");
}

export async function addLink(rootPath, name = "default") {
  const absPath = path.resolve(rootPath);
  const localConfig = {
    name,
    linkedAt: new Date().toISOString(),
    endpoint: null,
    lastSyncAt: null
  };
  await saveLocalLinkConfig(absPath, localConfig);

  const colabignorePath = path.join(absPath, ".colabignore");
  try {
    await fs.access(colabignorePath);
  } catch {
    const defaultIgnore = "# Excludes\nnode_modules/\n.venv/\n__pycache__/\n*.tmp\n";
    await fs.writeFile(colabignorePath, defaultIgnore, "utf8");
  }

  const gitignorePath = path.join(absPath, ".gitignore");
  try {
    const content = await fs.readFile(gitignorePath, "utf8");
    if (!content.includes(".colab")) {
      await fs.writeFile(gitignorePath, content + (content.endsWith("\n") ? "" : "\n") + ".colab\n", "utf8");
    }
  } catch {
    await fs.writeFile(gitignorePath, ".colab\n", "utf8");
  }

  const links = [{ path: absPath, name, linkedAt: localConfig.linkedAt }];
  await saveGlobalLinks(links);
}

export async function removeLink(rootPath) {
  const absPath = path.resolve(rootPath);
  const links = await loadGlobalLinks();
  const filtered = links.filter(l => l.path !== absPath);
  await saveGlobalLinks(filtered);
  const localConfigPath = path.join(absPath, ".colab", "config.json");
  await fs.rm(localConfigPath, { force: true });
}
export async function loadConfig(cliOpts = {}) {
  const config = await loadGlobalConfig(cliOpts);
  const links = await loadGlobalLinks();
  let targetLink = links[0];
  if (cliOpts.workspace) {
    const absWorkspace = path.resolve(cliOpts.workspace);
    targetLink = links.find(l => l.path === absWorkspace);
    if (!targetLink) {
      targetLink = { path: absWorkspace, name: "default" };
    }
  }
  if (targetLink) {
    config.workspacePath = targetLink.path;
    config.linkName = targetLink.name;
  }
  return config;
}

export async function getGitConfig() {
  try {
    const raw = await fs.readFile(GLOBAL_CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    return {
      owner: cfg.githubOwner || null,
      repo: cfg.githubRepo || null,
      token: cfg.githubToken || null,
      configured: !!(cfg.githubOwner && cfg.githubRepo && cfg.githubToken)
    };
  } catch {
    return { owner: null, repo: null, token: null, configured: false };
  }
}

export async function saveGitConfig(owner, repo, token) {
  await fs.mkdir(GLOBAL_DIR, { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(GLOBAL_CONFIG_PATH, "utf8")); } catch {}
  cfg.githubOwner = owner;
  cfg.githubRepo = repo;
  cfg.githubToken = token;
  await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}
