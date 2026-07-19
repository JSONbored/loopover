import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODING_AGENT_DRIVER_CONFIG_ENV, parseMinerGoalSpecContent, resolveFirstConfiguredCodingAgentDriverName } from "@loopover/engine";
import { checkClaudeCliPresent, checkCodexCliPresent, checkDockerPresent, checkLaptopStateSqlite, findExecutableOnPath, resolveCodexAuthPath, } from "./laptop-init.js";
import { resolveMinerVersion } from "./version.js";
import { checkStoreIntegrity, describeError } from "./store-maintenance.js";
import { resolveEventLedgerDbPath } from "./event-ledger.js";
import { resolveGovernorLedgerDbPath } from "./governor-ledger.js";
import { hasGitHubTokenSource } from "./github-token-resolution.js";
import { resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import { resolvePortfolioQueueDbPath } from "./portfolio-queue.js";
import { resolveClaimLedgerDbPath } from "./claim-ledger.js";
import { resolveRunStateDbPath } from "./run-state.js";
import { resolvePlanStoreDbPath } from "./plan-store.js";
import { resolveGovernorStateDbPath } from "./governor-state.js";
import { resolveAttemptLogDbPath } from "./attempt-log.js";
import { resolveReplaySnapshotDbPath } from "./replay-snapshot.js";
import { resolveWorktreeAllocatorDbPath } from "./worktree-allocator.js";
import { resolveContributionProfileCacheDbPath } from "./contribution-profile-cache.js";
import { resolvePolicyVerdictCacheDbPath } from "./policy-verdict-cache.js";
import { resolvePolicyDocCacheDbPath } from "./policy-doc-cache.js";
// Slim laptop-mode CLI commands (#2288): `status` (what's installed + where local state lives) and `doctor` (is
// this laptop set up correctly). Both are read-only and 100% local — no repo-scanning, no coding-agent invocation,
// no GitHub writes, and no network calls of any kind. Later phases add the real discover/plan/manage loop.
// Lazy, not module-scope: mirrors the loopover-engine repo-map.ts fix -- this file is CLI-only today, but
// an eager createRequire(import.meta.url)/import.meta.dirname at module scope would crash on import in any
// bundler context where import.meta is unavailable (e.g. if a future import chain pulls this into a Worker
// bundle, the way repo-map.ts was). Deferring construction to first real use keeps this import-safe.
let cachedRequire = null;
function requireFromHere() {
    return (cachedRequire ??= createRequire(import.meta.url));
}
let cachedModuleDir = null;
function moduleDir() {
    return (cachedModuleDir ??= import.meta.dirname);
}
const PACKAGE_NAME = "@loopover/miner";
const ENGINE_PACKAGE = "@loopover/engine";
// Config-file discovery order (mirrors the `.loopover-miner.yml` precedence the goal-spec parser documents).
const CONFIG_FILE_CANDIDATES = Object.freeze([
    ".loopover-miner.yml",
    ".github/loopover-miner.yml",
    ".loopover-miner.json",
    ".github/loopover-miner.json",
]);
/** The miner's local-state directory (holds the run-state / queue / ledger SQLite files). */
export function resolveMinerStateDir(env = process.env) {
    const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string" ? env.LOOPOVER_MINER_CONFIG_DIR.trim() : "";
    if (explicitConfigDir)
        return explicitConfigDir;
    const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
        ? env.XDG_CONFIG_HOME.trim()
        : join(homedir(), ".config");
    return join(configHome, "loopover-miner");
}
/**
 * The REAL installed @loopover/engine version, for `status`'s own display. Prefers `readInstalled`
 * (the actually-resolved semver from node_modules/the monorepo workspace, the same real resolution `doctor`'s
 * engine-version-skew check already relies on) -- a self-hoster asking "what's installed" wants the real
 * answer, not the declared dependency RANGE ("*" in this monorepo, which tells them nothing). Falls back to
 * the declared range only if real resolution genuinely comes up empty (the engine package's `exports` map
 * blocks `require("<pkg>/package.json")` in some resolution orders, and its built `dist` may be absent
 * depending on build order) -- still better than reporting nothing at all.
 *
 * Exported + injectable (mirrors `buildEngineVersionSkewCheck`'s own `readInstalled` param): real resolution
 * succeeding is the only realistic case in a working install, so the fallback path needs a way to force it.
 */
export function buildEngineVersionDisplay(readInstalled = readInstalledEnginePackageVersion) {
    const installed = readInstalled();
    if (installed)
        return installed;
    try {
        /* v8 ignore next -- package.json declares @loopover/engine in every supported miner build */
        return requireFromHere()("../package.json").dependencies?.[ENGINE_PACKAGE] ?? null;
    }
    catch {
        /* v8 ignore next -- import metadata/package resolution failure is bundler-only; normal Node tests resolve it */
        return null;
    }
}
function readEngineVersion() {
    return buildEngineVersionDisplay();
}
export function readInstalledEnginePackageVersionFromPaths(resolvedEntry, workspacePkg, deps = {
    existsSync,
    readFileSync,
}) {
    try {
        for (const pkgJson of [join(resolvedEntry, "..", "package.json"), join(resolvedEntry, "..", "..", "package.json")]) {
            if (deps.existsSync(pkgJson)) {
                const version = JSON.parse(deps.readFileSync(pkgJson, "utf8")).version;
                if (version)
                    return version;
            }
        }
    }
    catch {
        // fall through to monorepo workspace fallback
    }
    if (deps.existsSync(workspacePkg)) {
        try {
            return JSON.parse(deps.readFileSync(workspacePkg, "utf8")).version ?? null;
        }
        catch {
            return null;
        }
    }
    return null;
}
/** Installed @loopover/engine semver from node_modules (not the declared dependency range). */
/* v8 ignore next -- Node resolver failure cannot be induced after this module's require is initialized; fallback is defensive */
export function readInstalledEnginePackageVersion() {
    try {
        return readInstalledEnginePackageVersionFromPaths(requireFromHere().resolve(ENGINE_PACKAGE), join(moduleDir(), "../../loopover-engine/package.json"));
    }
    catch {
        /* v8 ignore next 9 -- only reaches when Node cannot resolve the installed package at all */
        const workspacePkg = join(moduleDir(), "../../loopover-engine/package.json");
        if (existsSync(workspacePkg)) {
            try {
                return JSON.parse(readFileSync(workspacePkg, "utf8")).version ?? null;
            }
            catch {
                return null;
            }
        }
        return null;
    }
}
/** Expected minimum engine semver: monorepo engine package.json when present, else the shipped pin file. */
export function readExpectedEnginePackageVersionFromPaths(monorepoEnginePkg, pinFile, deps = {
    existsSync,
    readFileSync,
}) {
    if (deps.existsSync(monorepoEnginePkg)) {
        try {
            return JSON.parse(deps.readFileSync(monorepoEnginePkg, "utf8")).version ?? null;
        }
        catch {
            return null;
        }
    }
    try {
        const pinned = deps.readFileSync(pinFile, "utf8").trim();
        return pinned || null;
    }
    catch {
        return null;
    }
}
export function readExpectedEnginePackageVersion() {
    return readExpectedEnginePackageVersionFromPaths(join(moduleDir(), "../../loopover-engine/package.json"), join(moduleDir(), "../expected-engine.version"));
}
function parseSemverCore(version) {
    const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match)
        return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
/** Returns -1 when installed is behind expected, 0 when equal, 1 when ahead. */
export function compareInstalledEngineVersion(installed, expected) {
    const installedCore = parseSemverCore(installed);
    const expectedCore = parseSemverCore(expected);
    if (!installedCore || !expectedCore)
        return -1;
    for (let index = 0; index < 3; index += 1) {
        if (installedCore[index] < expectedCore[index])
            return -1;
        if (installedCore[index] > expectedCore[index])
            return 1;
    }
    return 0;
}
export function buildEngineVersionSkewCheck(readInstalled = readInstalledEnginePackageVersion, readExpected = readExpectedEnginePackageVersion) {
    const installed = readInstalled();
    const expected = readExpected();
    if (!expected) {
        return { name: "engine-version-skew", ok: true, detail: "expected engine version unavailable (skipped)" };
    }
    if (!installed) {
        return {
            name: "engine-version-skew",
            ok: false,
            detail: `${ENGINE_PACKAGE} not installed (cannot verify version skew)`,
        };
    }
    const comparison = compareInstalledEngineVersion(installed, expected);
    return {
        name: "engine-version-skew",
        ok: comparison >= 0,
        detail: comparison < 0
            ? `installed ${installed} is behind expected ${expected}`
            : `installed ${installed} (${comparison === 0 ? "matches" : "ahead of"} expected ${expected})`,
    };
}
function checkEngineVersionSkew() {
    return buildEngineVersionSkewCheck();
}
/** The minimum Node major version from the package's `engines.node` floor (e.g. ">=22.13.0" → 22). */
function requiredNodeMajor() {
    const engines = requireFromHere()("../package.json").engines;
    /* v8 ignore next -- package.json's required engines.node is a build-time invariant */
    const match = typeof engines?.node === "string" ? engines.node.match(/(\d+)/) : null;
    /* v8 ignore next -- a matching engines.node floor always includes the captured major */
    return match ? Number(match[1]) : 0;
}
function discoverConfigFile(cwd) {
    for (const candidate of CONFIG_FILE_CANDIDATES) {
        const path = join(cwd, candidate);
        if (existsSync(path))
            return path;
    }
    return null;
}
// CLI names driver-factory.ts's resolved provider values that actually spawn a local subprocess -- "noop" and
// "agent-sdk" have no separate CLI binary to check presence for, so cliPresent is null (not applicable) for them.
const PROVIDER_CLI_BINARY = Object.freeze({ "claude-cli": "claude", "codex-cli": "codex" });
/** The `driver` section of `status`/`status --json` (#5164): which coding-agent provider is configured, the
 *  NAME (never the value) of its model env var, and whether its CLI binary is on PATH. Reuses
 *  `resolveFirstConfiguredCodingAgentDriverName`/`CODING_AGENT_DRIVER_CONFIG_ENV` (the same resolution
 *  driver-factory.ts uses) and `findExecutableOnPath` (the same PATH scan the doctor CLI-presence checks use)
 *  rather than duplicating either. Never reads or returns an env var's actual value. */
function resolveDriverStatus(env) {
    const provider = resolveFirstConfiguredCodingAgentDriverName(env) ?? null;
    /* v8 ignore next -- resolved provider names always have a static driver configuration */
    const driverConfig = provider
        ? (CODING_AGENT_DRIVER_CONFIG_ENV[provider] ?? null)
        : null;
    const modelEnvVar = driverConfig?.model ?? null;
    const cliBinary = provider ? (PROVIDER_CLI_BINARY[provider] ?? null) : null;
    const cliPresent = cliBinary ? Boolean(findExecutableOnPath(cliBinary, env)) : null;
    return { provider, modelEnvVar, cliPresent };
}
/** Gather the read-only status snapshot. Pure w.r.t. its (env, cwd) inputs — no writes, no network. */
export function collectStatus(env = process.env, cwd = process.cwd()) {
    const stateDir = resolveMinerStateDir(env);
    return {
        package: { name: PACKAGE_NAME, version: resolveMinerVersion(env) },
        engine: { name: ENGINE_PACKAGE, version: readEngineVersion() },
        node: process.version,
        stateDir,
        configFile: discoverConfigFile(cwd),
        driver: resolveDriverStatus(env),
    };
}
function renderDriverLine(driver) {
    if (!driver.provider)
        return "driver: none configured";
    const cliText = driver.cliPresent === null ? "n/a" : driver.cliPresent ? "yes" : "no";
    const modelText = driver.modelEnvVar ? `, model env: ${driver.modelEnvVar}` : "";
    return `driver: ${driver.provider} (CLI present: ${cliText}${modelText})`;
}
function renderStatusText(status) {
    return [
        /* v8 ignore next -- resolveMinerVersion always supplies package.json's build version */
        `${status.package.name} ${status.package.version ?? "unknown"} (node ${status.node})`,
        /* v8 ignore next -- engine fallback is already handled in buildEngineVersionDisplay */
        `engine: ${status.engine.name} ${status.engine.version ?? "unresolved"}`,
        `state dir: ${status.stateDir}`,
        `config file: ${status.configFile ?? "none found"}`,
        renderDriverLine(status.driver),
    ].join("\n");
}
export function runStatus(args = [], env = process.env, cwd = process.cwd()) {
    const status = collectStatus(env, cwd);
    console.log(args.includes("--json") ? JSON.stringify(status, null, 2) : renderStatusText(status));
    return 0;
}
function checkStateDirWritable(stateDir) {
    const probe = join(stateDir, ".loopover-miner-write-probe");
    try {
        // Creating the dir and writing (then removing) a probe file proves it is writable — the state dir must be
        // creatable/writable for the local SQLite stores to work.
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        writeFileSync(probe, "");
        rmSync(probe, { force: true });
        return { name: "state-dir-writable", ok: true, detail: stateDir };
    }
    catch (error) {
        return {
            name: "state-dir-writable",
            ok: false,
            /* v8 ignore next -- Node fs throws Error objects; fallback guards hostile/non-Node implementations */
            detail: `${stateDir}: ${error instanceof Error ? error.message : "not writable"}`,
        };
    }
}
/** Per-store `PRAGMA integrity_check` sweep for `doctor` (#4834) — flags a corrupted store instead of probing
 *  only one with `SELECT 1`. A store file that does not exist yet is healthy by absence. Keep in sync with
 *  migrate-cli.js's `STORES` list (#6768): every durable local SQLite store using resolveLocalStoreDbPath. */
function storeIntegrityChecks(env) {
    const stores = [
        ["event-ledger", resolveEventLedgerDbPath(env)],
        ["governor-ledger", resolveGovernorLedgerDbPath(env)],
        ["prediction-ledger", resolvePredictionLedgerDbPath(env)],
        ["portfolio-queue", resolvePortfolioQueueDbPath(env)],
        ["claim-ledger", resolveClaimLedgerDbPath(env)],
        ["run-state", resolveRunStateDbPath(env)],
        ["plan-store", resolvePlanStoreDbPath(env)],
        ["governor-state", resolveGovernorStateDbPath(env)],
        ["attempt-log", resolveAttemptLogDbPath(env)],
        // replay-snapshot's .d.ts still types env as ProcessEnv (not yet migrated); cast is lossless.
        ["replay-snapshot", resolveReplaySnapshotDbPath(env)],
        ["worktree-allocator", resolveWorktreeAllocatorDbPath(env)],
        ["contribution-profile", resolveContributionProfileCacheDbPath(env)],
        ["policy-verdict-cache", resolvePolicyVerdictCacheDbPath(env)],
        ["policy-doc-cache", resolvePolicyDocCacheDbPath(env)],
    ];
    return stores.map(([name, dbPath]) => checkStoreIntegrity(`store-integrity:${name}`, dbPath));
}
/** Validate the discovered `.loopover-miner` config's CONTENT (#4873), not just its path: parse it with the
 *  tolerant goal-spec parser and surface its warnings, so a malformed config is flagged by `doctor` rather than
 *  silently degrading to defaults. No config file is fine (defaults apply); a read failure is reported. `readImpl`
 *  is injectable for tests. */
export function checkConfigContent(cwd, readImpl = readFileSync) {
    const configPath = discoverConfigFile(cwd);
    if (!configPath) {
        return { name: "config-content", ok: true, detail: "no .loopover-miner config found (using defaults)" };
    }
    let warnings;
    try {
        warnings = parseMinerGoalSpecContent(readImpl(configPath, "utf8")).warnings;
    }
    catch (error) {
        return { name: "config-content", ok: false, detail: `${configPath}: ${describeError(error)}` };
    }
    return warnings.length === 0
        ? { name: "config-content", ok: true, detail: `${configPath}: valid` }
        : { name: "config-content", ok: false, detail: `${configPath}: ${warnings.join("; ")}` };
}
function nonEmptyEnv(value) {
    return typeof value === "string" && value.length > 0;
}
/** GitHub token presence (#5170, extended by #6116). A purely offline check — `doctor` never calls GitHub — but
 *  a missing token fails every real attempt the moment it tries to push a branch or open a PR, so surface it up
 *  front rather than mid-run. Checks BOTH a GITHUB_TOKEN env override AND a recorded `loopover-mcp login`
 *  session (hasGitHubTokenSource, offline: reads the local config file, makes no network call) -- otherwise a
 *  user who only ran `loopover-mcp login` (the new primary flow) would see a spurious "not set" warning even
 *  though AMS would resolve a live token from that session at attempt time. A session recorded here is not
 *  re-verified as still valid/unexpired -- only an actual attempt (or resolveGitHubToken itself) discovers
 *  that. Reports presence only; no token value is ever included in the detail. */
export function checkGitHubTokenPresent(env = process.env) {
    // hasGitHubTokenSource's .d.ts still types env as ProcessEnv; cast is lossless.
    const present = hasGitHubTokenSource(env);
    return {
        name: "github-token",
        ok: present,
        detail: present
            ? "A GitHub token is available (GITHUB_TOKEN or a loopover-mcp login session)"
            : "No GitHub token available — run `loopover-mcp login`, or set GITHUB_TOKEN, before attempts that push a branch or open a PR",
    };
}
/** Credential presence for the CONFIGURED coding-agent provider (#5170). Distinct from the CLI-present checks,
 *  which by design keep `ok: true` when only the credential is missing (#5165): this FAILS `doctor` when the
 *  resolved provider's credential is absent, so an operator learns before an attempt fails partway through.
 *  Fully offline — an env-var string check for the Claude backends, a file-readability check for codex — and it
 *  never prints the credential value, only the env-var names / file path. `resolveAuthPath` is injectable for
 *  tests, mirroring `checkCodexCliPresent`. */
export function checkCodingAgentCredential(env = process.env, resolveAuthPath = resolveCodexAuthPath) {
    const provider = resolveFirstConfiguredCodingAgentDriverName(env) ?? null;
    if (provider === null || provider === "noop") {
        return {
            name: "coding-agent-credential",
            ok: true,
            detail: provider === "noop"
                ? "noop driver needs no credential"
                : "no coding-agent provider configured (skipped)",
        };
    }
    if (provider === "claude-cli" || provider === "agent-sdk") {
        // Both run the Claude backend (a `claude` subprocess vs the in-process Agent SDK) off the same subscription
        // OAuth token the rest of the tree reads (CLAUDE_CODE_OAUTH_TOKEN; see createClaudeCodeAi in
        // src/selfhost/ai.ts). The SDK additionally accepts a raw ANTHROPIC_API_KEY, so either satisfies the credential.
        const present = nonEmptyEnv(env.CLAUDE_CODE_OAUTH_TOKEN) || nonEmptyEnv(env.ANTHROPIC_API_KEY);
        return {
            name: "coding-agent-credential",
            ok: present,
            detail: present
                ? `${provider}: Claude credential is set`
                : `${provider}: no Claude credential — set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)`,
        };
    }
    // codex-cli: the only remaining configured provider — its credential is a readable auth.json, the same
    // read-only condition checkCodexCliPresent probes (reusing resolveCodexAuthPath so the location never drifts).
    const authPath = resolveAuthPath(env);
    let readable = false;
    try {
        accessSync(authPath, constants.R_OK);
        readable = true;
    }
    catch {
        // missing or unreadable — codex would fail for lack of credentials at attempt time.
    }
    return {
        name: "coding-agent-credential",
        ok: readable,
        detail: readable
            ? `codex-cli: auth.json is readable at ${authPath}`
            : `codex-cli: auth.json missing or unreadable at ${authPath} — run \`codex auth\``,
    };
}
/** Run the doctor checks. Returns an array of { name, ok, detail }; only writes a transient probe in the state dir,
 *  never touches the network. */
export function runDoctorChecks(env = process.env, cwd = process.cwd()) {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const requiredMajor = requiredNodeMajor();
    const engineVersion = readEngineVersion();
    return [
        {
            name: "node-version",
            ok: nodeMajor >= requiredMajor,
            detail: `node ${process.version} (requires >= ${requiredMajor})`,
        },
        {
            name: "engine-resolves",
            ok: engineVersion !== null,
            /* v8 ignore next -- buildEngineVersionDisplay has a declared-range fallback in supported Node installs */
            detail: engineVersion ? `${ENGINE_PACKAGE} ${engineVersion}` : `${ENGINE_PACKAGE} not resolvable`,
        },
        checkEngineVersionSkew(),
        checkStateDirWritable(resolveMinerStateDir(env)),
        checkLaptopStateSqlite(env),
        checkDockerPresent(),
        checkClaudeCliPresent({ env }),
        checkCodexCliPresent({ env }),
        checkGitHubTokenPresent(env),
        checkCodingAgentCredential(env),
        checkConfigContent(cwd),
        ...storeIntegrityChecks(env),
    ];
}
export function runDoctor(args = [], env = process.env, cwd = process.cwd()) {
    const checks = runDoctorChecks(env, cwd);
    const failed = checks.filter((check) => !check.ok);
    if (args.includes("--json")) {
        console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
    }
    else {
        for (const check of checks)
            console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
        if (failed.length > 0)
            console.error(`doctor: ${failed.length} check(s) failed`);
    }
    return failed.length === 0 ? 0 : 1;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3RhdHVzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic3RhdHVzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxVQUFVLEVBQUUsU0FBUyxFQUFFLFVBQVUsRUFBRSxTQUFTLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxhQUFhLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDNUcsT0FBTyxFQUFFLGFBQWEsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUM1QyxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxJQUFJLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFDakMsT0FBTyxFQUFFLDhCQUE4QixFQUFFLHlCQUF5QixFQUFFLDJDQUEyQyxFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDMUksT0FBTyxFQUNMLHFCQUFxQixFQUNyQixvQkFBb0IsRUFDcEIsa0JBQWtCLEVBQ2xCLHNCQUFzQixFQUN0QixvQkFBb0IsRUFDcEIsb0JBQW9CLEdBQ3JCLE1BQU0sa0JBQWtCLENBQUM7QUFDMUIsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sY0FBYyxDQUFDO0FBQ25ELE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxhQUFhLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUM1RSxPQUFPLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUM3RCxPQUFPLEVBQUUsMkJBQTJCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUNuRSxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSw4QkFBOEIsQ0FBQztBQUNwRSxPQUFPLEVBQUUsNkJBQTZCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUN2RSxPQUFPLEVBQUUsMkJBQTJCLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUNuRSxPQUFPLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUM3RCxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSxn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QztRQUMzQixrQkFBa0IsRUFBRTtRQUNwQixxQkFBcUIsQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDO1FBQzlCLG9CQUFvQixDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUM7UUFDN0IsdUJBQXVCLENBQUMsR0FBRyxDQUFDO1FBQzVCLDBCQUEwQixDQUFDLEdBQUcsQ0FBQztRQUMvQixrQkFBa0IsQ0FBQyxHQUFHLENBQUM7UUFDdkIsR0FBRyxvQkFBb0IsQ0FBQyxHQUFHLENBQUM7S0FDN0IsQ0FBQztBQUNKLENBQUM7QUFFRCxNQUFNLFVBQVUsU0FBUyxDQUN2QixPQUFpQixFQUFFLEVBQ25CLE1BQTBDLE9BQU8sQ0FBQyxHQUFHLEVBQ3JELE1BQWMsT0FBTyxDQUFDLEdBQUcsRUFBRTtJQUUzQixNQUFNLE1BQU0sR0FBRyxlQUFlLENBQUMsR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQ3pDLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ25ELElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1FBQzVCLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxNQUFNLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxNQUFNLEVBQUUsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM1RSxDQUFDO1NBQU0sQ0FBQztRQUNOLEtBQUssTUFBTSxLQUFLLElBQUksTUFBTTtZQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsR0FBRyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sSUFBSSxLQUFLLENBQUMsSUFBSSxLQUFLLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBQ3hHLElBQUksTUFBTSxDQUFDLE1BQU0sR0FBRyxDQUFDO1lBQUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxXQUFXLE1BQU0sQ0FBQyxNQUFNLGtCQUFrQixDQUFDLENBQUM7SUFDbkYsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3JDLENBQUMifQ==