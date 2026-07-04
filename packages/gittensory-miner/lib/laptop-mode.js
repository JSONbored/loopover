import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initRunStateStore, resolveRunStateDbPath } from "./run-state.js";

const dockerProbeTimeoutMs = 1500;

function errorDetail(error) {
  return error instanceof Error && error.message ? error.message : "unknown_error";
}

export function resolveLaptopModeStateDbPath(env = process.env) {
  return resolveRunStateDbPath(env);
}

export function resolveLaptopModeConfigDir(env = process.env) {
  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    ? env.GITTENSORY_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return explicitConfigDir;

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "gittensory-miner");
}

/**
 * Bootstrap the miner's zero-infra laptop mode by ensuring the local config dir and the real
 * SQLite-backed run-state store exist. We intentionally open the store on EVERY run, not only when
 * the DB file is missing, so an existing empty file is repaired by the same idempotent schema init
 * path instead of being reported as "ready" while still unusable. (#2329)
 */
export function initLaptopMode(input = {}) {
  const env = input.env ?? process.env;
  const stateDbPath = resolveLaptopModeStateDbPath(env);
  const configDir = resolveLaptopModeConfigDir(env);
  const configDirExisted = existsSync(configDir);
  const stateDbExisted = existsSync(stateDbPath);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const store = (input.initStore ?? initRunStateStore)(stateDbPath);
  try {
    return {
      configDir,
      configDirExisted,
      stateDbPath,
      stateDbExisted,
    };
  } finally {
    store.close();
  }
}

function nearestExistingAncestor(path) {
  let candidate = dirname(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}

function inspectWritablePath(path, input = {}) {
  const existingMode = input.existingMode ?? constants.W_OK;
  const exists = existsSync(path);
  if (!exists) {
    const ancestor = nearestExistingAncestor(path);
    if (!ancestor) {
      return { path, exists: false, writable: false, error: "missing_parent_directory" };
    }
    try {
      accessSync(ancestor, constants.W_OK | constants.X_OK);
      return { path, exists: false, writable: true, error: null };
    } catch (error) {
      return { path, exists: false, writable: false, error: errorDetail(error) };
    }
  }
  try {
    accessSync(path, existingMode);
    return { path, exists: true, writable: true, error: null };
  } catch (error) {
    return { path, exists: true, writable: false, error: errorDetail(error) };
  }
}

function inspectRunStateDb(stateDbPath) {
  const base = inspectWritablePath(stateDbPath);
  if (!base.exists) {
    return {
      ...base,
      sqliteReady: false,
      schemaReady: false,
      schemaError: null,
    };
  }

  try {
    const db = new DatabaseSync(stateDbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'miner_run_state'")
        .get();
      return {
        ...base,
        sqliteReady: true,
        schemaReady: row?.name === "miner_run_state",
        schemaError: row?.name === "miner_run_state" ? null : "missing miner_run_state table",
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ...base,
      sqliteReady: false,
      schemaReady: false,
      schemaError: errorDetail(error),
    };
  }
}

function probeDocker(spawn = spawnSync) {
  let result;
  try {
    result = spawn("docker", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: dockerProbeTimeoutMs,
    });
  } catch (error) {
    return { available: false, detail: errorDetail(error) };
  }

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      return {
        available: false,
        detail: `docker --version timed out after ${dockerProbeTimeoutMs}ms`,
      };
    }
    return {
      available: false,
      detail: result.error.code === "ENOENT" ? "docker not found on PATH" : errorDetail(result.error),
    };
  }
  if (result.status === 0) {
    const detail = (result.stdout || result.stderr || "docker available").trim();
    return { available: true, detail };
  }

  const detail = [result.stderr, result.stdout]
    .map((value) => value?.trim())
    .find(Boolean) ?? `docker exited ${result.status ?? "unknown"}`;
  return { available: false, detail };
}

export function inspectLaptopMode(input = {}) {
  const env = input.env ?? process.env;
  return {
    nodeVersion: process.version,
    configDir: inspectWritablePath(resolveLaptopModeConfigDir(env), {
      existingMode: constants.W_OK | constants.X_OK,
    }),
    stateDb: inspectRunStateDb(resolveLaptopModeStateDbPath(env)),
    docker: probeDocker(input.spawnSyncFn),
  };
}

function formatPathStatus(check) {
  const parts = [];
  parts.push(check.exists ? "present" : "missing");
  if (check.exists) parts.push(check.writable ? "writable" : "not writable");
  return parts.join(", ");
}

export function formatLaptopDoctor(report) {
  const stateStatus = [
    formatPathStatus(report.stateDb),
    report.stateDb.sqliteReady ? "sqlite ok" : "sqlite unavailable",
    report.stateDb.schemaReady ? "miner_run_state ready" : "miner_run_state missing",
  ].join(", ");

  const lines = [
    "Gittensory miner doctor",
    `- Node: ${report.nodeVersion}`,
    `- Config dir: ${report.configDir.path} (${formatPathStatus(report.configDir)})${report.configDir.error ? ` - ${report.configDir.error}` : ""}`,
    `- State DB: ${report.stateDb.path} (${stateStatus})${report.stateDb.error ? ` - ${report.stateDb.error}` : report.stateDb.schemaError ? ` - ${report.stateDb.schemaError}` : ""}`,
    `- Docker: ${report.docker.available ? report.docker.detail : `unavailable (${report.docker.detail}; informational only)`}`,
  ];
  return lines.join("\n");
}
