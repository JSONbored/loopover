import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODING_AGENT_DRIVER_CONFIG_ENV, parseMinerGoalSpecContent, resolveFirstConfiguredCodingAgentDriverName } from "@jsonbored/gittensory-engine";
import {
  checkClaudeCliPresent,
  checkCodexCliPresent,
  checkDockerPresent,
  checkLaptopStateSqlite,
  findExecutableOnPath,
  resolveCodexAuthPath,
} from "./laptop-init.js";
import { resolveMinerVersion } from "./version.js";
import { checkStoreIntegrity, describeError } from "./store-maintenance.js";
import { resolveEventLedgerDbPath } from "./event-ledger.js";
import { resolveGovernorLedgerDbPath } from "./governor-ledger.js";
import { resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import { resolvePortfolioQueueDbPath } from "./portfolio-queue.js";
import { resolveClaimLedgerDbPath } from "./claim-ledger.js";
import { resolveRunStateDbPath } from "./run-state.js";
import { resolvePlanStoreDbPath } from "./plan-store.js";

// Slim laptop-mode CLI commands (#2288): `status` (what's installed + where local state lives) and `doctor` (is
// this laptop set up correctly). Both are read-only and 100% local — no repo-scanning, no coding-agent invocation,
// no GitHub writes, and no network calls of any kind. Later phases add the real discover/plan/manage loop.

// Lazy, not module-scope: mirrors the gittensory-engine repo-map.ts fix -- this file is CLI-only today, but
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

const PACKAGE_NAME = "@jsonbored/gittensory-miner";
const ENGINE_PACKAGE = "@jsonbored/gittensory-engine";
// Config-file discovery order (mirrors the `.gittensory-miner.yml` precedence the goal-spec parser documents).
const CONFIG_FILE_CANDIDATES = Object.freeze([
  ".gittensory-miner.yml",
  ".github/gittensory-miner.yml",
  ".gittensory-miner.json",
  ".github/gittensory-miner.json",
]);

/** The miner's local-state directory (holds the run-state / queue / ledger SQLite files). */
export function resolveMinerStateDir(env = process.env) {
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
 * The REAL installed @jsonbored/gittensory-engine version, for `status`'s own display. Prefers `readInstalled`
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
  if (installed) return installed;
  try {
    return requireFromHere()("../package.json").dependencies?.[ENGINE_PACKAGE] ?? null;
  } catch {
    return null;
  }
}

function readEngineVersion() {
  return buildEngineVersionDisplay();
}

export function readInstalledEnginePackageVersionFromPaths(
  resolvedEntry,
  workspacePkg,
  deps = { existsSync, readFileSync },
) {
  try {
    for (const pkgJson of [join(resolvedEntry, "..", "package.json"), join(resolvedEntry, "..", "..", "package.json")]) {
      if (deps.existsSync(pkgJson)) {
        const version = JSON.parse(deps.readFileSync(pkgJson, "utf8")).version;
        if (version) return version;
      }
    }
  } catch {
    // fall through to monorepo workspace fallback
  }
  if (deps.existsSync(workspacePkg)) {
    try {
      return JSON.parse(deps.readFileSync(workspacePkg, "utf8")).version ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Installed @jsonbored/gittensory-engine semver from node_modules (not the declared dependency range). */
export function readInstalledEnginePackageVersion() {
  try {
    return readInstalledEnginePackageVersionFromPaths(
      requireFromHere().resolve(ENGINE_PACKAGE),
      join(moduleDir(), "../../gittensory-engine/package.json"),
    );
  } catch {
    const workspacePkg = join(moduleDir(), "../../gittensory-engine/package.json");
    if (existsSync(workspacePkg)) {
      try {
        return JSON.parse(readFileSync(workspacePkg, "utf8")).version ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Expected minimum engine semver: monorepo engine package.json when present, else the shipped pin file. */
export function readExpectedEnginePackageVersionFromPaths(
  monorepoEnginePkg,
  pinFile,
  deps = { existsSync, readFileSync },
) {
  if (deps.existsSync(monorepoEnginePkg)) {
    try {
      return JSON.parse(deps.readFileSync(monorepoEnginePkg, "utf8")).version ?? null;
    } catch {
      return null;
    }
  }
  try {
    const pinned = deps.readFileSync(pinFile, "utf8").trim();
    return pinned || null;
  } catch {
    return null;
  }
}

export function readExpectedEnginePackageVersion() {
  return readExpectedEnginePackageVersionFromPaths(
    join(moduleDir(), "../../gittensory-engine/package.json"),
    join(moduleDir(), "../expected-engine.version"),
  );
}

function parseSemverCore(version) {
  const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Returns -1 when installed is behind expected, 0 when equal, 1 when ahead. */
export function compareInstalledEngineVersion(installed, expected) {
  const installedCore = parseSemverCore(installed);
  const expectedCore = parseSemverCore(expected);
  if (!installedCore || !expectedCore) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (installedCore[index] < expectedCore[index]) return -1;
    if (installedCore[index] > expectedCore[index]) return 1;
  }
  return 0;
}

export function buildEngineVersionSkewCheck(
  readInstalled = readInstalledEnginePackageVersion,
  readExpected = readExpectedEnginePackageVersion,
) {
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
    detail:
      comparison < 0
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
  const match = typeof engines?.node === "string" ? engines.node.match(/(\d+)/) : null;
  return match ? Number(match[1]) : 0;
}

function discoverConfigFile(cwd) {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const path = join(cwd, candidate);
    if (existsSync(path)) return path;
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
  const modelEnvVar = provider ? (CODING_AGENT_DRIVER_CONFIG_ENV[provider]?.model ?? null) : null;
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
  if (!driver.provider) return "driver: none configured";
  const cliText = driver.cliPresent === null ? "n/a" : driver.cliPresent ? "yes" : "no";
  const modelText = driver.modelEnvVar ? `, model env: ${driver.modelEnvVar}` : "";
  return `driver: ${driver.provider} (CLI present: ${cliText}${modelText})`;
}

function renderStatusText(status) {
  return [
    `${status.package.name} ${status.package.version ?? "unknown"} (node ${status.node})`,
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
  const probe = join(stateDir, ".gittensory-miner-write-probe");
  try {
    // Creating the dir and writing (then removing) a probe file proves it is writable — the state dir must be
    // creatable/writable for the local SQLite stores to work.
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return { name: "state-dir-writable", ok: true, detail: stateDir };
  } catch (error) {
    return {
      name: "state-dir-writable",
      ok: false,
      detail: `${stateDir}: ${error instanceof Error ? error.message : "not writable"}`,
    };
  }
}

/** Per-store `PRAGMA integrity_check` sweep for `doctor` (#4834) — flags a corrupted store instead of probing
 *  only one with `SELECT 1`. A store file that does not exist yet is healthy by absence. */
function storeIntegrityChecks(env) {
  const stores = [
    ["event-ledger", resolveEventLedgerDbPath(env)],
    ["governor-ledger", resolveGovernorLedgerDbPath(env)],
    ["prediction-ledger", resolvePredictionLedgerDbPath(env)],
    ["portfolio-queue", resolvePortfolioQueueDbPath(env)],
    ["claim-ledger", resolveClaimLedgerDbPath(env)],
    ["run-state", resolveRunStateDbPath(env)],
    ["plan-store", resolvePlanStoreDbPath(env)],
  ];
  return stores.map(([name, dbPath]) => checkStoreIntegrity(`store-integrity:${name}`, dbPath));
}

/** Validate the discovered `.gittensory-miner` config's CONTENT (#4873), not just its path: parse it with the
 *  tolerant goal-spec parser and surface its warnings, so a malformed config is flagged by `doctor` rather than
 *  silently degrading to defaults. No config file is fine (defaults apply); a read failure is reported. `readImpl`
 *  is injectable for tests. */
export function checkConfigContent(cwd, readImpl = readFileSync) {
  const configPath = discoverConfigFile(cwd);
  if (!configPath) {
    return { name: "config-content", ok: true, detail: "no .gittensory-miner config found (using defaults)" };
  }
  let warnings;
  try {
    warnings = parseMinerGoalSpecContent(readImpl(configPath, "utf8")).warnings;
  } catch (error) {
    return { name: "config-content", ok: false, detail: `${configPath}: ${describeError(error)}` };
  }
  return warnings.length === 0
    ? { name: "config-content", ok: true, detail: `${configPath}: valid` }
    : { name: "config-content", ok: false, detail: `${configPath}: ${warnings.join("; ")}` };
}

function nonEmptyEnv(value) {
  return typeof value === "string" && value.length > 0;
}

/** `GITHUB_TOKEN` presence (#5170). A purely offline string check — `doctor` never calls GitHub — but a missing
 *  token fails every real attempt the moment it tries to push a branch or open a PR, so surface it up front
 *  rather than mid-run. Reports presence only; the token value itself is never included in the detail. */
export function checkGitHubTokenPresent(env = process.env) {
  const present = nonEmptyEnv(env.GITHUB_TOKEN);
  return {
    name: "github-token",
    ok: present,
    detail: present
      ? "GITHUB_TOKEN is set"
      : "GITHUB_TOKEN is not set — attempts that push a branch or open a PR will fail",
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
      detail:
        provider === "noop"
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
  } catch {
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
  } else {
    for (const check of checks) console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
    if (failed.length > 0) console.error(`doctor: ${failed.length} check(s) failed`);
  }
  return failed.length === 0 ? 0 : 1;
}
