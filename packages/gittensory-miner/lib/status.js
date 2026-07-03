import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// Slim laptop-mode CLI commands (#2288): `status` (what's installed + where local state lives) and `doctor` (is
// this laptop set up correctly). Both are read-only and 100% local — no repo-scanning, no coding-agent invocation,
// no GitHub writes, and no network calls of any kind. Later phases add the real discover/plan/manage loop.

const require = createRequire(import.meta.url);

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

function readOwnVersion() {
  try {
    return require("../package.json").version ?? null;
  } catch {
    return null;
  }
}

// The pinned @jsonbored/gittensory-engine version this miner is built against, read from the miner's own declared
// dependency. (The engine package's `exports` map blocks `require("<pkg>/package.json")`, and its built `dist` may
// be absent depending on build order, so the declared-dependency version is the reliable, always-available source.)
function readEngineVersion() {
  try {
    return require("../package.json").dependencies?.[ENGINE_PACKAGE] ?? null;
  } catch {
    return null;
  }
}

/** The minimum Node major version from the package's `engines.node` floor (e.g. ">=22.13.0" → 22). */
function requiredNodeMajor() {
  const engines = require("../package.json").engines;
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

/** Gather the read-only status snapshot. Pure w.r.t. its (env, cwd) inputs — no writes, no network. */
export function collectStatus(env = process.env, cwd = process.cwd()) {
  const stateDir = resolveMinerStateDir(env);
  return {
    package: { name: PACKAGE_NAME, version: readOwnVersion() },
    engine: { name: ENGINE_PACKAGE, version: readEngineVersion() },
    node: process.version,
    stateDir,
    configFile: discoverConfigFile(cwd),
  };
}

function renderStatusText(status) {
  return [
    `${status.package.name} ${status.package.version ?? "unknown"} (node ${status.node})`,
    `engine: ${status.engine.name} ${status.engine.version ?? "unresolved"}`,
    `state dir: ${status.stateDir}`,
    `config file: ${status.configFile ?? "none found"}`,
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

/** Run the doctor checks. Returns an array of { name, ok, detail }; only writes a transient probe in the state dir,
 *  never touches the network. */
export function runDoctorChecks(env = process.env) {
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
    checkStateDirWritable(resolveMinerStateDir(env)),
  ];
}

export function runDoctor(args = [], env = process.env) {
  const checks = runDoctorChecks(env);
  const failed = checks.filter((check) => !check.ok);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  } else {
    for (const check of checks) console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
    if (failed.length > 0) console.error(`doctor: ${failed.length} check(s) failed`);
  }
  return failed.length === 0 ? 0 : 1;
}
