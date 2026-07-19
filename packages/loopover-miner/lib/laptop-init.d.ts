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
/** Path to the laptop-mode SQLite bootstrap file inside the miner state directory. */
export declare function resolveLaptopStateDbPath(env?: Record<string, string | undefined>): string;
/** Create the state dir and SQLite file. Re-running is idempotent and never clobbers existing rows. */
export declare function initLaptopState(env?: Record<string, string | undefined>): LaptopInitResult;
export declare function checkLaptopStateSqlite(env?: Record<string, string | undefined>): DoctorCheck;
/** Exported so callers that only need a presence boolean (e.g. status.js's `driver` section, #5164) can reuse
 *  this PATH scan directly instead of duplicating it or parsing a DoctorCheck's detail string. */
export declare function findExecutableOnPath(name: string, env?: Record<string, string | undefined>): string | null;
/** Informational only — Docker is never required for laptop mode. */
export declare function checkDockerPresent(options?: {
    env?: Record<string, string | undefined>;
    resolveDockerPath?: () => string | null;
}): DoctorCheck;
export declare function resolveCodexAuthPath(env?: Record<string, string | undefined>): string;
/**
 * Validate a GitHub token with one authenticated API call.
 *
 * The classic OAuth scope header is advisory when GitHub reports it: if GitHub returns `repo` or
 * `public_repo`, we treat the token as sufficiently scoped for miner setup. If GitHub omits the classic
 * scope header altogether, the token is still considered valid and the response is reported as "scopes not
 * reported" — that keeps fine-grained tokens usable while still surfacing the scopes GitHub did return.
 */
export declare function verifyGithubToken(options?: {
    githubToken?: string;
    fetchImpl?: typeof fetch;
    apiBaseUrl?: string;
    timeoutMs?: number;
}): Promise<GithubTokenVerification>;
/** Informational unless `MINER_CODING_AGENT_PROVIDER=claude-cli` (#5165), in which case a missing CLI fails
 *  doctor. The auth probe is read-only and never spawns the CLI: it surfaces, proactively, the SAME condition
 *  claude checks at call time — `CLAUDE_CODE_OAUTH_TOKEN` present (see createClaudeCodeAi, src/selfhost/ai.ts). */
export declare function checkClaudeCliPresent(options?: {
    env?: Record<string, string | undefined>;
    resolveClaudePath?: () => string | null;
}): DoctorCheck;
/** Informational unless `MINER_CODING_AGENT_PROVIDER=codex-cli` (#5165), in which case a missing CLI fails
 *  doctor — mirrors {@link checkClaudeCliPresent}. The auth probe checks the same read-only condition
 *  assertCodexAuthConfigured uses at call time: codex's `auth.json` is readable. */
export declare function checkCodexCliPresent(options?: {
    env?: Record<string, string | undefined>;
    resolveCodexPath?: () => string | null;
    resolveCodexAuthPath?: () => string;
}): DoctorCheck;
export declare function runInit(args?: string[], env?: Record<string, string | undefined>): Promise<number>;
