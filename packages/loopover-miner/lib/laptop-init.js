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
/** Local state directory (mirrors `resolveMinerStateDir` in status.js — kept local to avoid import cycles). */
function resolveMinerStateDir(env = process.env) {
    const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
        ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
        : "";
    if (explicitConfigDir)
        return explicitConfigDir;
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : join(homedir(), ".config");
    return join(configHome, "loopover-miner");
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
    }
    catch (error) {
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
export function findExecutableOnPath(name, env = process.env) {
    const pathValue = typeof env.PATH === "string" ? env.PATH : "";
    for (const pathEntry of pathValue.split(delimiter)) {
        if (!pathEntry)
            continue;
        const candidate = join(pathEntry, name);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch {
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
// `githubToken` is always a real (already-trimmed) string here: this function is private and its sole caller,
// verifyGithubToken, already coerces `options.githubToken` to a trimmed string before passing it in.
function githubHeaders(githubToken) {
    const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "loopover-miner",
        "x-github-api-version": githubApiVersion,
    };
    if (githubToken)
        headers.authorization = `Bearer ${githubToken}`;
    return headers;
}
function parseScopesHeader(scopesHeader) {
    return typeof scopesHeader === "string" && scopesHeader.trim()
        ? scopesHeader.split(",").map((scope) => scope.trim()).filter(Boolean)
        : [];
}
// `scopes` is always non-empty here: both call sites already guard `scopes.length > 0` before calling this.
function formatScopes(scopes) {
    return scopes.join(", ");
}
function hasRepoAccessScope(scopes) {
    return scopes.some((scope) => classicRepoScopes.has(scope));
}
function readGithubErrorMessage(payload, status) {
    const record = payload;
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
export async function verifyGithubToken(options = {}) {
    const githubToken = typeof options.githubToken === "string" ? options.githubToken.trim() : "";
    const fetchImpl = options.fetchImpl ?? fetch;
    const apiBaseUrl = typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
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
    }
    catch (error) {
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
    }
    finally {
        clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => null);
    const scopesHeader = response.headers.get("x-oauth-scopes");
    const scopesHeaderPresent = response.headers.has("x-oauth-scopes");
    const scopes = parseScopesHeader(scopesHeader);
    const payloadRecord = payload;
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
        detail: scopes.length > 0
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
    }
    catch {
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
        // resolveGitHubToken types `env` as the ambient (Cloudflare-Workers-augmented) `NodeJS.ProcessEnv`,
        // stricter than this file's own `Record<string, string | undefined>` -- this package runs under plain
        // Node, and any object matching this shape genuinely satisfies resolveGitHubToken at runtime either way.
        const resolveToken = resolveGitHubToken;
        verification = await verifyGithubToken({ githubToken: (await resolveToken(env)) ?? "" });
        if (!verification.ok) {
            return reportCliFailure(jsonOutput, verification.detail, 1);
        }
    }
    const result = initLaptopState(env);
    if (jsonOutput) {
        console.log(JSON.stringify(verification ? { ...result, tokenVerification: verification } : result, null, 2));
    }
    else {
        console.log(`initialized ${result.stateDir}`);
        console.log(`sqlite: ${result.dbPath}${result.created ? "" : " (already existed)"}`);
        if (verification) {
            console.log(`token: ${verification.detail}`);
        }
    }
    return 0;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGFwdG9wLWluaXQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJsYXB0b3AtaW5pdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUNsRixPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQzVDLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDM0MsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFDNUQsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDbEQsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFFbEUsTUFBTSxnQkFBZ0IsR0FBRyx3QkFBd0IsQ0FBQztBQUNsRCxNQUFNLGdCQUFnQixHQUFHLFlBQVksQ0FBQztBQUN0QyxNQUFNLGlCQUFpQixHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLGFBQWEsQ0FBQyxDQUFDLENBQUM7QUFDM0QsTUFBTSxpQkFBaUIsR0FBRyxzQkFBc0IsQ0FBQztBQXFCakQsK0dBQStHO0FBQy9HLFNBQVMsb0JBQW9CLENBQUMsTUFBMEMsT0FBTyxDQUFDLEdBQUc7SUFDakYsTUFBTSxpQkFBaUIsR0FBRyxPQUFPLEdBQUcsQ0FBQyx5QkFBeUIsS0FBSyxRQUFRO1FBQ3pFLENBQUMsQ0FBQyxHQUFHLENBQUMseUJBQXlCLENBQUMsSUFBSSxFQUFFO1FBQ3RDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDUCxJQUFJLGlCQUFpQjtRQUFFLE9BQU8saUJBQWlCLENBQUM7SUFFaEQsTUFBTSxVQUFVLEdBQUcsT0FBTyxHQUFHLENBQUMsZUFBZSxLQUFL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