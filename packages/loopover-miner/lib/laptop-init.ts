import { accessSync, chmodSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchemaMigrations } from "./schema-version.js";
import { reportCliFailure } from "./cli-error.js";
import { resolveGitHubToken } from "./github-token-resolution.js";

const githubApiBaseUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";
const classicRepoScopes = new Set(["repo", "public_repo"]);
const defaultDbFileName = "laptop-state.sqlite3";

export type LaptopInitResult = {
  stateDir: string;
  dbPath: string;
  created: boolean;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type GithubTokenVerification = {
  ok: boolean;
  login: string | null;
  scopes: string[];
  detail: string;
};

/** Local state directory (mirrors `resolveMinerStateDir` in status.js — kept local to avoid import cycles). */
function resolveMinerStateDir(env: Record<string, string | undefined> = process.env): string {
  const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
    ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return explicitConfigDir;

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "loopover-miner");
}

/** Path to the laptop-mode SQLite bootstrap file inside the miner state directory. */
export function resolveLaptopStateDbPath(env: Record<string, string | undefined> = process.env): string {
  return join(resolveMinerStateDir(env), defaultDbFileName);
}

/** Create the state dir and SQLite file. Re-running is idempotent and never clobbers existing rows. */
export function initLaptopState(env: Record<string, string | undefined> = process.env): LaptopInitResult {
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

export function checkLaptopStateSqlite(env: Record<string, string | undefined> = process.env): DoctorCheck {
  const dbPath = resolveLaptopStateDbPath(env);
  if (!existsSync(dbPath)) {
    return {
      name: "laptop-state-sqlite",
      ok: false,
      detail: `${dbPath}: not found (run loopover-miner init)`,
    };
  }
  try {
    // `readOnly` (camelCase) -- node:sqlite silently IGNORES `readonly` (lowercase) as an unrecognized option
    // and opens read-write anyway, which would break doctor's own "no writes, no network" contract. Same
    // footgun already documented in claim-ledger.js's openClaimLedgerReadOnly and purge-cli.js.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.prepare("SELECT 1").get();
    db.close();
    return { name: "laptop-state-sqlite", ok: true, detail: dbPath };
  } catch (error) {
    // Defensive: node:sqlite's DatabaseSync/prepare/get always throw real Error instances for every failure
    // mode reachable through this real (non-mocked) file path -- deliberately not exercised by a contrived
    // unit test, since forcing a non-Error throw here would require mocking node:sqlite itself.
    return {
      name: "laptop-state-sqlite",
      ok: false,
      detail: `${dbPath}: ${error instanceof Error ? error.message : "not readable"}`,
    };
  }
}

/** Exported so callers that only need a presence boolean (e.g. status.js's `driver` section, #5164) can reuse
 *  this PATH scan directly instead of duplicating it or parsing a DoctorCheck's detail string. */
export function findExecutableOnPath(name: string, env: Record<string, string | undefined> = process.env): string | null {
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
export function checkDockerPresent(options: { env?: Record<string, string | undefined>; resolveDockerPath?: () => string | null } = {}): DoctorCheck {
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
export function resolveCodexAuthPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
  return join(base, "auth.json");
}

// `githubToken` is always a real (already-trimmed) string here: this function is private and its sole caller,
// verifyGithubToken, already coerces `options.githubToken` to a trimmed string before passing it in.
function githubHeaders(githubToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "loopover-miner",
    "x-github-api-version": githubApiVersion,
  };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  return headers;
}

function parseScopesHeader(scopesHeader: string | null): string[] {
  return typeof scopesHeader === "string" && scopesHeader.trim()
    ? scopesHeader.split(",").map((scope) => scope.trim()).filter(Boolean)
    : [];
}

// `scopes` is always non-empty here: both call sites already guard `scopes.length > 0` before calling this.
function formatScopes(scopes: string[]): string {
  return scopes.join(", ");
}

function hasRepoAccessScope(scopes: string[]): boolean {
  return scopes.some((scope) => classicRepoScopes.has(scope));
}

function readGithubErrorMessage(payload: unknown, status: number): string {
  const record = payload as { message?: unknown } | null;
  if (record && typeof record === "object" && typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
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
export async function verifyGithubToken(
  options: { githubToken?: string; fetchImpl?: typeof fetch; apiBaseUrl?: string; timeoutMs?: number } = {},
): Promise<GithubTokenVerification> {
  const githubToken = typeof options.githubToken === "string" ? options.githubToken.trim() : "";
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl =
    typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
      ? options.apiBaseUrl.trim().replace(/\/+$/, "") || githubApiBaseUrl
      : githubApiBaseUrl;
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0 ? (options.timeoutMs as number) : 5000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
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
  const payloadRecord = payload as { login?: unknown } | null;
  const login = payloadRecord && typeof payloadRecord === "object" && typeof payloadRecord.login === "string" ? payloadRecord.login.trim() : "";

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
function codingAgentProviderConfiguredFor(env: Record<string, string | undefined>, providerName: string): boolean {
  return env.MINER_CODING_AGENT_PROVIDER === providerName;
}

/** Informational unless `MINER_CODING_AGENT_PROVIDER=claude-cli` (#5165), in which case a missing CLI fails
 *  doctor. The auth probe is read-only and never spawns the CLI: it surfaces, proactively, the SAME condition
 *  claude checks at call time — `CLAUDE_CODE_OAUTH_TOKEN` present (see createClaudeCodeAi, src/selfhost/ai.ts). */
export function checkClaudeCliPresent(
  options: { env?: Record<string, string | undefined>; resolveClaudePath?: () => string | null } = {},
): DoctorCheck {
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
export function checkCodexCliPresent(
  options: {
    env?: Record<string, string | undefined>;
    resolveCodexPath?: () => string | null;
    resolveCodexAuthPath?: () => string;
  } = {},
): DoctorCheck {
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

export async function runInit(args: string[] = [], env: Record<string, string | undefined> = process.env): Promise<number> {
  const verifyToken = args.includes("--verify-token");
  const jsonOutput = args.includes("--json");
  let verification: GithubTokenVerification | null = null;
  if (verifyToken) {
    // resolveGitHubToken types `env` as the ambient (Cloudflare-Workers-augmented) `NodeJS.ProcessEnv`,
    // stricter than this file's own `Record<string, string | undefined>` -- this package runs under plain
    // Node, and any object matching this shape genuinely satisfies resolveGitHubToken at runtime either way.
    const resolveToken = resolveGitHubToken as (env?: Record<string, string | undefined>) => Promise<string | null>;
    verification = await verifyGithubToken({ githubToken: (await resolveToken(env)) ?? "" });
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
