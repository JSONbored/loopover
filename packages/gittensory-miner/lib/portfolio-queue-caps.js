import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizePortfolioCaps } from "./portfolio-queue-manager.js";
import { resolveMinerStateDir } from "./status.js";

const CONFIG_FILE_CANDIDATES = Object.freeze([
  ".gittensory-miner.yml",
  ".github/gittensory-miner.yml",
  ".gittensory-miner.json",
  ".github/gittensory-miner.json",
]);

function discoverConfigFile(cwd) {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const path = join(cwd, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

function readConfigCaps(stateDir) {
  const configPath = discoverConfigFile(stateDir);
  if (!configPath) return null;
  try {
    const raw = configPath.endsWith(".json") ? JSON.parse(readFileSync(configPath, "utf8")) : parseYaml(readFileSync(configPath, "utf8"));
    const portfolioQueue = raw?.portfolioQueue;
    if (!portfolioQueue || typeof portfolioQueue !== "object" || Array.isArray(portfolioQueue)) return null;
    return normalizePortfolioCaps(portfolioQueue);
  } catch {
    return null;
  }
}

function readEnvCaps(env) {
  const caps = {};
  if (typeof env.GITTENSORY_MINER_GLOBAL_WIP_CAP === "string" && env.GITTENSORY_MINER_GLOBAL_WIP_CAP.trim()) {
    caps.globalWipCap = Number(env.GITTENSORY_MINER_GLOBAL_WIP_CAP);
  }
  if (typeof env.GITTENSORY_MINER_PER_REPO_WIP_CAP === "string" && env.GITTENSORY_MINER_PER_REPO_WIP_CAP.trim()) {
    caps.perRepoWipCap = Number(env.GITTENSORY_MINER_PER_REPO_WIP_CAP);
  }
  return Object.keys(caps).length > 0 ? normalizePortfolioCaps(caps) : null;
}

/**
 * Resolve WIP caps for portfolio claiming: operator `.gittensory-miner.yml` in the state dir, then env, then CLI
 * flags (when provided), defaulting to `{ globalWipCap: 1, perRepoWipCap: 1 }`.
 * @param {{ env?: NodeJS.ProcessEnv, cliCaps?: { globalWipCap?: number, perRepoWipCap?: number } }} [options]
 */
export function resolvePortfolioQueueCaps(options = {}) {
  const env = options.env ?? process.env;
  let caps = readConfigCaps(resolveMinerStateDir(env)) ?? { globalWipCap: 1, perRepoWipCap: 1 };
  const envCaps = readEnvCaps(env);
  if (envCaps) caps = envCaps;
  const cliCaps = options.cliCaps ?? {};
  if (cliCaps.globalWipCap !== undefined || cliCaps.perRepoWipCap !== undefined) {
    caps = normalizePortfolioCaps({
      globalWipCap: cliCaps.globalWipCap ?? caps.globalWipCap,
      perRepoWipCap: cliCaps.perRepoWipCap ?? caps.perRepoWipCap,
    });
  }
  return caps;
}
