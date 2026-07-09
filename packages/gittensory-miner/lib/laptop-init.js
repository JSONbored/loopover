import { accessSync, chmodSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
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

function findExecutableOnPath(name, env = process.env) {
  const pathValue = typeof env.PATH === "string" ? env.PATH : "";
  for (const pathEntry of pathValue.split(delimiter)) {
    if (!pathEntry) continue;
    const candidate = join(pathEntry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning: PATH often contains missing or unreadable entries.
    }
  }
  return null;
}

/** Informational only — Docker is never required for laptop mode. */
export function checkDockerPresent(options = {}) {
  const resolveDockerPath = options.resolveDockerPath
    ?? (() => findExecutableOnPath("docker", options.env));
  const dockerPath = resolveDockerPath();
  return {
    name: "docker-present",
    ok: true,
    detail: dockerPath ? `found at ${dockerPath}` : "not installed (optional for laptop mode)",
  };
}

// Codex stores credentials at `$CODEX_HOME/auth.json`, else `$HOME/.codex/auth.json` — mirrors
// resolveCodexAuthPath in src/selfhost/ai.ts, kept local so the offline miner package never imports the
// Worker AI module.
function resolveCodexAuthPath(env = process.env) {
  const base = env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
  return join(base, "auth.json");
}

/** Informational only — a coding-agent CLI is only needed once a driver provider is configured (#4289), so a
 *  missing or unauthenticated CLI is advisory (`ok: true`), mirroring checkDockerPresent's optional tone. The
 *  auth probe is read-only and never spawns the CLI: it surfaces, proactively, the SAME condition claude
 *  checks at call time — `CLAUDE_CODE_OAUTH_TOKEN` present (see createClaudeCodeAi, src/selfhost/ai.ts). */
export function checkClaudeCliPresent(options = {}) {
  const env = options.env ?? process.env;
  const claudePath = (options.resolveClaudePath ?? (() => findExecutableOnPath("claude", env)))();
  if (!claudePath) {
    return { name: "claude-cli-present", ok: true, detail: "not installed (optional until a coding-agent driver is configured)" };
  }
  const authed = typeof env.CLAUDE_CODE_OAUTH_TOKEN === "string" && env.CLAUDE_CODE_OAUTH_TOKEN.length > 0;
  return {
    name: "claude-cli-present",
    ok: true,
    detail: authed ? `found at ${claudePath} (authenticated)` : `found at ${claudePath} (not authenticated: set CLAUDE_CODE_OAUTH_TOKEN)`,
  };
}

/** Informational only — mirrors {@link checkClaudeCliPresent} for the codex CLI. The auth probe checks the
 *  same read-only condition assertCodexAuthConfigured uses at call time: codex's `auth.json` is readable. */
export function checkCodexCliPresent(options = {}) {
  const env = options.env ?? process.env;
  const codexPath = (options.resolveCodexPath ?? (() => findExecutableOnPath("codex", env)))();
  if (!codexPath) {
    return { name: "codex-cli-present", ok: true, detail: "not installed (optional until a coding-agent driver is configured)" };
  }
  const authPath = (options.resolveCodexAuthPath ?? (() => resolveCodexAuthPath(env)))();
  let authed = false;
  try {
    accessSync(authPath, constants.R_OK);
    authed = true;
  } catch {
    // auth.json missing or unreadable — codex would fail for lack of credentials at call time.
  }
  return {
    name: "codex-cli-present",
    ok: true,
    detail: authed ? `found at ${codexPath} (authenticated)` : `found at ${codexPath} (not authenticated: run \`codex auth\`)`,
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
