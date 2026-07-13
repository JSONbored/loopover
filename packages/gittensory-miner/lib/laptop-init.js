import { accessSync, chmodSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchemaMigrations } from "./schema-version.js";
import { reportCliFailure } from "./cli-error.js";

const githubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const classicRepoScopes = new Set(["repo", "public_repo"]);
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
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations (none yet).
  applySchemaMigrations(db, []);
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

/** Exported so callers that only need a presence boolean (e.g. status.js's `driver` section, #5164) can reuse
 *  this PATH scan directly instead of duplicating it or parsing a DoctorCheck's detail string. */
export function findExecutableOnPath(name, env = process.env) {
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
// Worker AI module. Exported so `doctor`'s provider-credential check (status.js, #5170) resolves the SAME
// path this file's own codex auth probe uses, instead of duplicating the location logic.
export function resolveCodexAuthPath(env = process.env) {
  const base = env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
  return join(base, "auth.json");
}

function githubHeaders(githubToken) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "loopover-miner",
    "x-github-api-version": githubApiVersion,
  };
  const token = typeof githubToken === "string" ? githubToken.trim() : "";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function parseScopesHeader(scopesHeader) {
  return typeof scopesHeader === "string" && scopesHeader.trim()
    ? scopesHeader.split(",").map((scope) => scope.trim()).filter(Boolean)
    : [];
}

function formatScopes(scopes) {
  return scopes.length > 0 ? scopes.join(", ") : "none reported";
}

function hasRepoAccessScope(scopes) {
  return scopes.some((scope) => classicRepoScopes.has(scope));
}

function readGithubErrorMessage(payload, status) {
  if (payload && typeof payload === "object" && typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }
  return `GitHub returned HTTP ${status}`;
}

/**
 * Validate a GitHub token with one authenticated API call.
 *
 * The classic OAuth scope header is advisory when GitHub reports it: if GitHub returns `repo` or
 * `public_repo`, we treat the token as sufficiently scoped for miner setup. If GitHub omits the classic
 * scope header altogether, the token is still considered valid and the response is reported as "scopes not
 * reported" — that keeps fine-grained tokens usable while still surfacing the scopes GitHub did return.
 */
export async function verifyGithubToken(options = {}) {
  const githubToken = typeof options.githubToken === "string" ? options.githubToken.trim() : "";
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl =
    typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
      ? options.apiBaseUrl.trim().replace(/\/+$/, "") || githubApiBaseUrl
      : githubApiBaseUrl;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(`${apiBaseUrl}/user`, {
      method: "GET",
      headers: githubHeaders(githubToken),
      signal: controller.signal,
    });
  } catch (error) {
    const detail = controller.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : "request failed";
    return {
      ok: false,
      login: null,
      scopes: [],
      detail: `GITHUB_TOKEN verification failed: ${detail}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => null);
  const scopesHeader = response.headers.get("x-oauth-scopes");
  const scopesHeaderPresent = response.headers.has("x-oauth-scopes");
  const scopes = parseScopesHeader(scopesHeader);
  const login = payload && typeof payload === "object" && typeof payload.login === "string" ? payload.login.trim() : "";

  if (!response.ok) {
    return {
      ok: false,
      login: null,
      scopes,
      detail: `GITHUB_TOKEN verification failed: ${readGithubErrorMessage(payload, response.status)}`,
    };
  }

  if (scopesHeaderPresent && scopes.length === 0) {
    return {
      ok: false,
      login: login || null,
      scopes,
      detail: "GITHUB_TOKEN is valid, but GitHub returned an empty x-oauth-scopes header; reissue it with repo access for miner setup.",
    };
  }

  if (scopes.length > 0 && !hasRepoAccessScope(scopes)) {
    return {
      ok: false,
      login: login || null,
      scopes,
      detail: `GITHUB_TOKEN is valid, but GitHub reported only ${formatScopes(scopes)}; reissue it with repo access for miner setup.`,
    };
  }

  return {
    ok: true,
    login: login || null,
    scopes,
    detail:
      scopes.length > 0
        ? `validated GitHub token for ${login || "unknown user"}; scopes: ${formatScopes(scopes)}`
        : `validated GitHub token for ${login || "unknown user"}; GitHub did not report classic OAuth scopes`,
  };
}

/** A coding-agent CLI is only needed once a driver provider is configured (#4289) — gated by
 *  `MINER_CODING_AGENT_PROVIDER` (#5165). When that provider is NOT the CLI being checked, absence is
 *  advisory (`ok: true`), mirroring checkDockerPresent's optional tone. When it IS configured and the CLI is
 *  missing, `ok: false` — every attempt will fail without it. The auth probe (once found) stays advisory
 *  either way, since an unauthenticated-but-installed CLI is a separate, already-visible warning. */
function codingAgentProviderConfiguredFor(env, providerName) {
  return env.MINER_CODING_AGENT_PROVIDER === providerName;
}

/** Informational unless `MINER_CODING_AGENT_PROVIDER=claude-cli` (#5165), in which case a missing CLI fails
 *  doctor. The auth probe is read-only and never spawns the CLI: it surfaces, proactively, the SAME condition
 *  claude checks at call time — `CLAUDE_CODE_OAUTH_TOKEN` present (see createClaudeCodeAi, src/selfhost/ai.ts). */
export function checkClaudeCliPresent(options = {}) {
  const env = options.env ?? process.env;
  const claudePath = (options.resolveClaudePath ?? (() => findExecutableOnPath("claude", env)))();
  if (!claudePath) {
    const configured = codingAgentProviderConfiguredFor(env, "claude-cli");
    return {
      name: "claude-cli-present",
      ok: !configured,
      detail: configured
        ? "not installed — MINER_CODING_AGENT_PROVIDER is set to claude-cli, every attempt will fail without it"
        : "not installed (optional until a coding-agent driver is configured)",
    };
  }
  const authed = typeof env.CLAUDE_CODE_OAUTH_TOKEN === "string" && env.CLAUDE_CODE_OAUTH_TOKEN.length > 0;
  return {
    name: "claude-cli-present",
    ok: true,
    detail: authed ? `found at ${claudePath} (authenticated)` : `found at ${claudePath} (not authenticated: set CLAUDE_CODE_OAUTH_TOKEN)`,
  };
}

/** Informational unless `MINER_CODING_AGENT_PROVIDER=codex-cli` (#5165), in which case a missing CLI fails
 *  doctor — mirrors {@link checkClaudeCliPresent}. The auth probe checks the same read-only condition
 *  assertCodexAuthConfigured uses at call time: codex's `auth.json` is readable. */
export function checkCodexCliPresent(options = {}) {
  const env = options.env ?? process.env;
  const codexPath = (options.resolveCodexPath ?? (() => findExecutableOnPath("codex", env)))();
  if (!codexPath) {
    const configured = codingAgentProviderConfiguredFor(env, "codex-cli");
    return {
      name: "codex-cli-present",
      ok: !configured,
      detail: configured
        ? "not installed — MINER_CODING_AGENT_PROVIDER is set to codex-cli, every attempt will fail without it"
        : "not installed (optional until a coding-agent driver is configured)",
    };
  }
  const authPath = (options.resolveCodexAuthPath ?? (() => resolveCodexAuthPath(env)))();
  let authed = false;
  try {
    accessSync(authPath, constants.R_OK);
    authed = true;
  } catch {
    // auth.json missing or unreadable — codex would fail for lack of credentials at call time.
  }
  if (authed) {
    return { name: "codex-cli-present", ok: true, detail: `found at ${codexPath} (authenticated)` };
  }
  // codex-cli IS the configured driver but auth.json is missing/expired: a more specific, actionable remediation
  // than the generic advisory below, mirroring ORB's codexAuthReadinessProbe/assertCodexAuthConfigured wording
  // (#5166). `ok` stays true either way (unchanged by this issue, see #5165) since the CLI itself IS present --
  // only the CLI-absent case is a hard doctor failure.
  const detail = codingAgentProviderConfiguredFor(env, "codex-cli")
    ? `found at ${codexPath} but auth.json is missing or expired — run \`codex auth\` to authenticate before attempts run`
    : `found at ${codexPath} (not authenticated: run \`codex auth\`)`;
  return { name: "codex-cli-present", ok: true, detail };
}

export async function runInit(args = [], env = process.env) {
  const verifyToken = args.includes("--verify-token");
  const jsonOutput = args.includes("--json");
  let verification = null;
  if (verifyToken) {
    verification = await verifyGithubToken({ githubToken: env.GITHUB_TOKEN ?? "" });
    if (!verification.ok) {
      return reportCliFailure(jsonOutput, verification.detail, 1);
    }
  }

  const result = initLaptopState(env);
  if (jsonOutput) {
    console.log(
      JSON.stringify(
        verification ? { ...result, tokenVerification: verification } : result,
        null,
        2,
      ),
    );
  } else {
    console.log(`initialized ${result.stateDir}`);
    console.log(`sqlite: ${result.dbPath}${result.created ? "" : " (already existed)"}`);
    if (verification) {
      console.log(`token: ${verification.detail}`);
    }
  }
  return 0;
}
