import fs from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";

export async function loadColabignore(rootPath) {
  const filePath = path.join(rootPath, ".colabignore");
  const patterns = [];
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        patterns.push(trimmed);
      }
    }
  } catch {}
  return patterns;
}

export function compileIgnoreRules(patterns) {
  const parsedPatterns = [];
  for (const p of patterns) {
    let pat = p;
    const isDir = pat.endsWith("/");
    if (isDir) {
      pat = pat.slice(0, -1);
    }

    const hasSlash = pat.includes("/");
    if (!hasSlash) {
      if (isDir) {
        parsedPatterns.push(pat);
        parsedPatterns.push(`${pat}/**`);
        parsedPatterns.push(`**/${pat}`);
        parsedPatterns.push(`**/${pat}/**`);
      } else {
        parsedPatterns.push(pat);
        parsedPatterns.push(`**/${pat}`);
        parsedPatterns.push(`**/${pat}/**`);
      }
    } else {
      if (isDir) {
        parsedPatterns.push(pat);
        parsedPatterns.push(`${pat}/**`);
      } else {
        parsedPatterns.push(pat);
      }
    }
  }
  const DEFAULTS = [".colabignore", ".colab", ".colab/**"];
  const all = [...DEFAULTS, ...parsedPatterns];
  return picomatch(all, { dot: true });
}
