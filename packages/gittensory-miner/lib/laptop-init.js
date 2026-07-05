import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const defaultDbFileName = "laptop-state.sqlite3";

/** Local state directory (mirrors `resolveMinerStateDir` in status.js — kept local to avoid import cycles). */
function resolveMinerStateDir(env = process.env) {
  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    ? env.GITTENSORY_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return explicitConfigDir;

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "gittensory-miner");
}

/** Path to the laptop-mode SQLite bootstrap file inside the miner state directory. */
export function resolveLaptopStateDbPath(env = process.env) {
  return join(resolveMinerStateDir(env), defaultDbFileName);
}

/** Create the state dir and SQLite file. Re-running is idempotent and never clobbers existing rows. */
export function initLaptopState(env = process.env) {
  const stateDir = resolveMinerStateDir(env);
  const dbPath = resolveLaptopStateDbPath(env);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const created = !existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS laptop_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  if (created) {
    db.prepare("INSERT INTO laptop_meta (key, value) VALUES ('initialized_at', ?)")
      .run(new Date().toISOString());
  }
  chmodSync(dbPath, 0o600);
  db.close();
  return { stateDir, dbPath, created };
}

export function checkLaptopStateSqlite(env = process.env) {
  const dbPath = resolveLaptopStateDbPath(env);
  if (!existsSync(dbPath)) {
    return {
      name: "laptop-state-sqlite",
      ok: false,
      detail: `${dbPath}: not found (run gittensory-miner init)`,
    };
  }
  try {
    const db = new DatabaseSync(dbPath, { readonly: true });
    db.prepare("SELECT 1").get();
    db.close();
    return { name: "laptop-state-sqlite", ok: true, detail: dbPath };
  } catch (error) {
    return {
      name: "laptop-state-sqlite",
      ok: false,
      detail: `${dbPath}: ${error instanceof Error ? error.message : "not readable"}`,
    };
  }
}

/** Informational only — Docker is never required for laptop mode. */
export function checkDockerPresent(options = {}) {
  const resolveDockerPath = options.resolveDockerPath ?? (() => {
    try {
      return execFileSync("which", ["docker"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
    } catch {
      return null;
    }
  });
  const dockerPath = resolveDockerPath();
  return {
    name: "docker-present",
    ok: true,
    detail: dockerPath ? `found at ${dockerPath}` : "not installed (optional for laptop mode)",
  };
}

export function runInit(args = [], env = process.env) {
  const result = initLaptopState(env);
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`initialized ${result.stateDir}`);
    console.log(`sqlite: ${result.dbPath}${result.created ? "" : " (already existed)"}`);
  }
  return 0;
}
