#!/usr/bin/env node
// Mechanical drift tripwire for hand-duplicated src/ <-> gittensory-engine file pairs (#4260). Most src/{review,
// settings,signals} modules are thin re-export shims over the engine, but ~15 twin files are still maintained in
// parallel — this script discovers those pairs, normalizes known-harmless import-path aliases, and fails CI when
// the normalized bodies diverge. Also compares the workspace-installed @jsonbored/gittensory-engine semver against
// the monorepo engine package's declared version (version-skew tripwire; no live-gate round-trip).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_PARITY_AREAS = Object.freeze(["review", "settings", "signals"] as const);

/** Hand-duplicated gate-decision twins live outside src/{review,settings,signals} (#4518). */
export const GATE_DECISION_TWIN_PAIR = Object.freeze({
  area: "gate-decision",
  hostRelative: "src/rules/advisory.ts",
  engineRelative: "packages/gittensory-engine/src/advisory/gate-advisory.ts",
  hostFileName: "advisory.ts",
  engineFileName: "gate-advisory.ts",
} as const);

export const GATE_DECISION_CORE_MARKERS = Object.freeze([
  "function evaluateGateCheckCore",
  "function isConfiguredGateBlocker",
  "export function buildPullRequestAdvisory",
  "export function evaluateGateCheck",
] as const);
const ENGINE_SRC_ROOT = "packages/gittensory-engine/src";
const HOST_SRC_ROOT = "src";
const ENGINE_PACKAGE_JSON = "packages/gittensory-engine/package.json";
const MINER_ENGINE_PIN_FILE = "packages/gittensory-miner/expected-engine.version";
const ENGINE_PACKAGE_NAME = "@jsonbored/gittensory-engine";

export type EngineParityPair = {
  area: string;
  fileName: string;
  hostRelative: string;
  engineRelative: string;
  hostText: string;
  engineText: string;
};

export type EngineParityReadFile = (root: string, relativePath: string) => string;
export type EngineParityListDir = (root: string, relativePath: string) => string[];

function defaultReadFile(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function defaultListDir(root: string, relativePath: string): string[] {
  try {
    return readdirSync(join(root, relativePath));
  } catch {
    return [];
  }
}

/** Map equivalent relative import paths so import-only drift between host and engine copies does not false-fail. */
export function normalizeImportSpec(spec: string): string {
  let normalized = spec;
  if (normalized.endsWith(".js")) normalized = normalized.slice(0, -3);
  if (/^\.\.\/types\/[\w-]+$/.test(normalized)) normalized = "../types";
  if (normalized === "../focus-manifest/guidance") normalized = "../signals/focus-manifest";
  return normalized;
}

/** Normalize line endings and canonicalize relative `from` specifiers before byte comparison. */
export function normalizeEngineParityText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line.replace(/from\s+['"](\.\.\/[^'"]+)['"]/g, (_match, spec: string) => `from "${normalizeImportSpec(spec)}"`),
    )
    .join("\n");
}

/** True when the host copy is only a thin re-export of the engine module (not a hand-duplicated twin). */
export function isThinEngineReExportShim(srcText: string): boolean {
  const stripped = srcText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .join("\n");
  return /^export\s+(\{[\s\S]*\}|\*)\s+from\s+['"][^'"]*gittensory-engine[^'"]*['"];?\s*$/.test(stripped);
}

/** True when the engine twin is a placeholder stub (e.g. check-names) rather than a full parallel copy.
 *  Thresholds mirror the 2026-07-08 audit: engine stubs were <250 non-whitespace chars while host copies were
 *  3×+ larger (check-names ~14 lines vs engine ~2; review-thread-findings ~98 vs ~2). */
export function isEngineStubPair(srcText: string, engineText: string): boolean {
  const compact = (text: string) => text.replace(/\s/g, "").length;
  const engineCompact = compact(engineText);
  const srcCompact = compact(srcText);
  return engineCompact > 0 && srcCompact > engineCompact * 3 && engineCompact < 250;
}

/**
 * Discover in-scope hand-duplicated twins under src/{review,settings,signals} that also exist in the engine tree
 * and are neither host shims nor engine stubs.
 */
export function discoverEngineParityPairs({
  root,
  listDir = defaultListDir,
  readFile = defaultReadFile,
}: {
  root: string;
  listDir?: EngineParityListDir;
  readFile?: EngineParityReadFile;
}): EngineParityPair[] {
  const pairs: EngineParityPair[] = [];
  for (const area of ENGINE_PARITY_AREAS) {
    const hostDir = join(HOST_SRC_ROOT, area);
    const engineDir = join(ENGINE_SRC_ROOT, area);
    const hostFiles = listDir(root, hostDir).filter((name) => name.endsWith(".ts"));
    const engineFiles = new Set(listDir(root, engineDir).filter((name) => name.endsWith(".ts")));
    for (const fileName of hostFiles.sort()) {
      if (!engineFiles.has(fileName)) continue;
      const hostRelative = join(hostDir, fileName);
      const engineRelative = join(engineDir, fileName);
      const hostText = readFile(root, hostRelative);
      const engineText = readFile(root, engineRelative);
      if (isThinEngineReExportShim(hostText)) continue;
      if (isEngineStubPair(hostText, engineText)) continue;
      pairs.push({ area, fileName, hostRelative, engineRelative, hostText, engineText });
    }
  }
  return pairs;
}

/** Normalize git diff paths for stable comparisons across platforms. */
export function normalizeChangedPath(path: string): string {
  return String(path ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/** Load the explicit gate-decision twin pair for monitoring and PR version-bump enforcement. */
export function discoverGateDecisionTwinPair({
  root,
  readFile = defaultReadFile,
  pair = GATE_DECISION_TWIN_PAIR,
}: {
  root: string;
  readFile?: EngineParityReadFile;
  pair?: typeof GATE_DECISION_TWIN_PAIR;
}): EngineParityPair {
  return {
    area: pair.area,
    fileName: `${pair.hostFileName}<->${pair.engineFileName}`,
    hostRelative: pair.hostRelative,
    engineRelative: pair.engineRelative,
    hostText: readFile(root, pair.hostRelative),
    engineText: readFile(root, pair.engineRelative),
  };
}

/** Structural guard: both gate-decision twins still expose the core gate entrypoints (#4518). */
export function checkGateDecisionTwinPresence({
  root,
  readFile = defaultReadFile,
  pair = GATE_DECISION_TWIN_PAIR,
  markers = GATE_DECISION_CORE_MARKERS,
}: {
  root: string;
  readFile?: EngineParityReadFile;
  pair?: typeof GATE_DECISION_TWIN_PAIR;
  markers?: readonly string[];
}): { failures: string[]; pairChecked: EngineParityPair } {
  let twin: EngineParityPair;
  try {
    twin = discoverGateDecisionTwinPair({ root, readFile, pair });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      failures: [`Could not load gate-decision twin files: ${message}`],
      pairChecked: {
        area: pair.area,
        fileName: `${pair.hostFileName}<->${pair.engineFileName}`,
        hostRelative: pair.hostRelative,
        engineRelative: pair.engineRelative,
        hostText: "",
        engineText: "",
      },
    };
  }
  const failures: string[] = [];
  for (const marker of markers) {
    if (!twin.hostText.includes(marker)) {
      failures.push(`${pair.hostRelative} is missing gate-decision marker ${JSON.stringify(marker)}.`);
    }
    if (!twin.engineText.includes(marker)) {
      failures.push(`${pair.engineRelative} is missing gate-decision marker ${JSON.stringify(marker)}.`);
    }
  }
  return { failures, pairChecked: twin };
}

export function parseEnginePackageVersion(text: string): string | null {
  try {
    const version = JSON.parse(text).version;
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

/** True when the head engine package version is strictly greater than the base version. */
export function enginePackageVersionIncreased(baseVersion: string | null, headVersion: string | null): boolean {
  if (!baseVersion || !headVersion) return false;
  return compareSemver(headVersion, baseVersion) > 0;
}

/**
 * Fail PRs that touch only one gate-decision twin without bumping packages/gittensory-engine/package.json.
 * Updating both twins together is allowed without a version bump; a single-sided edit requires a bump.
 */
export function checkGateDecisionVersionBump({
  changedFiles,
  pair = GATE_DECISION_TWIN_PAIR,
  enginePackageJson = ENGINE_PACKAGE_JSON,
  baseEngineVersion,
  headEngineVersion,
}: {
  changedFiles: readonly string[];
  pair?: typeof GATE_DECISION_TWIN_PAIR;
  enginePackageJson?: string;
  baseEngineVersion: string | null;
  headEngineVersion: string | null;
}): { failures: string[] } {
  const normalized = changedFiles.map(normalizeChangedPath).filter(Boolean);
  const touchedHost = normalized.includes(pair.hostRelative);
  const touchedEngine = normalized.includes(pair.engineRelative);
  const touchedEnginePackage = normalized.includes(enginePackageJson);
  const failures: string[] = [];

  if (!touchedHost && !touchedEngine) return { failures };
  if (touchedHost && touchedEngine) return { failures };
  if (touchedEnginePackage && enginePackageVersionIncreased(baseEngineVersion, headEngineVersion)) {
    return { failures };
  }

  const touched = touchedHost ? pair.hostRelative : pair.engineRelative;
  failures.push(
    [
      `Gate-decision logic change in ${touched} requires either:`,
      `  • a matching edit to the other twin (${touchedHost ? pair.engineRelative : pair.hostRelative}), or`,
      `  • a version bump in ${enginePackageJson} (currently ${headEngineVersion ?? "unknown"} vs base ${baseEngineVersion ?? "unknown"}).`,
    ].join("\n"),
  );
  return { failures };
}

export type EngineParityExecGit = (args: string[], cwd: string) => string;

function defaultExecGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Best-effort changed-file list for PR/push validation; returns [] outside git/PR contexts. */
export function listChangedEngineParityFiles({
  root,
  execGit = defaultExecGit,
  baseRef = process.env.GITTENSORY_ENGINE_PARITY_BASE_REF ?? process.env.GITHUB_BASE_SHA ?? "",
  headRef = process.env.GITTENSORY_ENGINE_PARITY_HEAD_REF ?? "HEAD",
}: {
  root: string;
  execGit?: EngineParityExecGit;
  baseRef?: string;
  headRef?: string;
}): string[] {
  try {
    const base =
      baseRef ||
      execGit(["merge-base", headRef, "origin/main"], root) ||
      execGit(["merge-base", headRef, "upstream/main"], root);
    if (!base) return [];
    return execGit(["diff", "--name-only", `${base}...${headRef}`], root)
      .split("\n")
      .map(normalizeChangedPath)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readEnginePackageVersionAtRef({
  root,
  ref,
  enginePackageJson = ENGINE_PACKAGE_JSON,
  execGit = defaultExecGit,
  readFile = defaultReadFile,
}: {
  root: string;
  ref: string;
  enginePackageJson?: string;
  execGit?: EngineParityExecGit;
  readFile?: EngineParityReadFile;
}): string | null {
  try {
    if (ref === "HEAD" || ref === "WORKTREE") {
      return parseEnginePackageVersion(readFile(root, enginePackageJson));
    }
    return parseEnginePackageVersion(execGit(["show", `${ref}:${enginePackageJson}`], root));
  } catch {
    return null;
  }
}

/**
 * Compare normalized bodies of every discovered pair. Returns `{ failures, pairsChecked }` — pure given injectable IO.
 */
export function checkEngineParityDrift({
  root,
  readFile = defaultReadFile,
  listDir = defaultListDir,
}: {
  root: string;
  readFile?: EngineParityReadFile;
  listDir?: EngineParityListDir;
}): { failures: string[]; pairsChecked: EngineParityPair[] } {
  const pairs = discoverEngineParityPairs({ root, readFile, listDir });
  const failures: string[] = [];
  for (const pair of pairs) {
    const normalizedHost = normalizeEngineParityText(pair.hostText);
    const normalizedEngine = normalizeEngineParityText(pair.engineText);
    if (normalizedHost !== normalizedEngine) {
      failures.push(
        [
          `${pair.hostRelative} and ${pair.engineRelative} have drifted apart (normalized comparison).`,
          `Edit both copies together or convert the host file to a thin engine re-export shim.`,
        ].join("\n"),
      );
    }
  }
  return { failures, pairsChecked: pairs };
}

/** Parse `major.minor.patch` prefix; non-numeric prerelease segments compare as equal at the patch level. */
export function parseSemverCore(version: string): [number, number, number] | null {
  const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two semver strings. Returns `-1` (installed behind expected), `0` (equal), or `1` (installed ahead).
 * Unparseable versions are treated as behind so the skew check fails loudly.
 */
export function compareSemver(installed: string, expected: string): -1 | 0 | 1 {
  const installedCore = parseSemverCore(installed);
  const expectedCore = parseSemverCore(expected);
  if (!installedCore || !expectedCore) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (installedCore[index]! < expectedCore[index]!) return -1;
    if (installedCore[index]! > expectedCore[index]!) return 1;
  }
  return 0;
}

/** Human-readable skew label for doctor output and test assertions. */
export function describeEngineVersionSkew(installed: string, expected: string): "behind" | "equal" | "ahead" {
  const comparison = compareSemver(installed, expected);
  if (comparison < 0) return "behind";
  if (comparison > 0) return "ahead";
  return "equal";
}

export function defaultResolveInstalledEngineVersion(root: string): string | null {
  try {
    const engineEntry = join(root, "node_modules", ENGINE_PACKAGE_NAME, "package.json");
    if (!existsSync(engineEntry)) return null;
    return JSON.parse(readFileSync(engineEntry, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

export function defaultReadExpectedEngineVersion(root: string, readFile: EngineParityReadFile = defaultReadFile): string | null {
  try {
    const text = readFile(root, ENGINE_PACKAGE_JSON);
    return JSON.parse(text).version ?? null;
  } catch {
    return null;
  }
}

export type EngineVersionSkewResult = {
  failures: string[];
  installed: string | null;
  expected: string | null;
  skew: string;
};

/**
 * Version-skew tripwire: installed @jsonbored/gittensory-engine must be >= the monorepo engine package version.
 * Returns `{ failures, installed, expected, skew }`.
 */
export function checkEngineVersionSkew({
  root,
  readFile = defaultReadFile,
  resolveInstalled = defaultResolveInstalledEngineVersion,
  readExpected = (r) => defaultReadExpectedEngineVersion(r, readFile),
}: {
  root: string;
  readFile?: EngineParityReadFile;
  resolveInstalled?: (root: string) => string | null;
  readExpected?: (root: string) => string | null;
}): EngineVersionSkewResult {
  const failures: string[] = [];
  const installed = resolveInstalled(root);
  const expected = readExpected(root);
  const skew = installed && expected ? describeEngineVersionSkew(installed, expected) : "unknown";

  if (!expected) {
    failures.push(`Could not read expected engine version from ${ENGINE_PACKAGE_JSON}.`);
  } else if (!installed) {
    failures.push(`${ENGINE_PACKAGE_NAME} is not installed under node_modules (cannot verify version skew).`);
  } else if (compareSemver(installed, expected) < 0) {
    failures.push(
      `${ENGINE_PACKAGE_NAME} version skew: installed ${installed} is behind expected minimum ${expected}.`,
    );
  }

  return { failures, installed, expected, skew };
}

/** Fail when the published-miner pin drifts from the monorepo engine package version. */
export function checkMinerEngineVersionPinSync({
  root,
  readFile = defaultReadFile,
  readExpected = (r) => defaultReadExpectedEngineVersion(r, readFile),
}: {
  root: string;
  readFile?: EngineParityReadFile;
  readExpected?: (root: string) => string | null;
}): { failures: string[]; expected: string | null; pin: string | null } {
  const failures: string[] = [];
  const expected = readExpected(root);
  let pin: string | null = null;
  try {
    pin = readFile(root, MINER_ENGINE_PIN_FILE).trim() || null;
  } catch {
    pin = null;
  }
  if (expected && pin && expected !== pin) {
    failures.push(
      `${MINER_ENGINE_PIN_FILE} (${pin}) is out of sync with ${ENGINE_PACKAGE_JSON} (${expected}).`,
    );
  } else if (expected && !pin) {
    failures.push(`Could not read miner engine version pin from ${MINER_ENGINE_PIN_FILE}.`);
  }
  return { failures, expected, pin };
}

/** Run drift, gate-decision, version-skew, and optional PR version-bump checks. */
export function runEngineParityChecks(options: {
  root: string;
  readFile?: EngineParityReadFile;
  listDir?: EngineParityListDir;
  resolveInstalled?: (root: string) => string | null;
  readExpected?: (root: string) => string | null;
  changedFiles?: readonly string[];
  baseEngineVersion?: string | null;
  headEngineVersion?: string | null;
}): {
  failures: string[];
  pairsChecked: EngineParityPair[];
  versionSkew: EngineVersionSkewResult;
} {
  const drift = checkEngineParityDrift(options);
  const gateDecision = checkGateDecisionTwinPresence(options);
  const skew = checkEngineVersionSkew(options);
  const pinSync = checkMinerEngineVersionPinSync(options);
  const readFile = options.readFile ?? defaultReadFile;
  let headEngineVersion = options.headEngineVersion;
  if (headEngineVersion === undefined) {
    try {
      headEngineVersion = parseEnginePackageVersion(readFile(options.root, ENGINE_PACKAGE_JSON));
    } catch {
      headEngineVersion = null;
    }
  }
  const baseEngineVersion = options.baseEngineVersion ?? headEngineVersion;
  const changedFiles = options.changedFiles ?? listChangedEngineParityFiles({ root: options.root });
  const versionBump =
    changedFiles.length > 0 && headEngineVersion
      ? checkGateDecisionVersionBump({
          changedFiles,
          baseEngineVersion,
          headEngineVersion,
        })
      : { failures: [] as string[] };
  return {
    failures: [
      ...drift.failures,
      ...gateDecision.failures,
      ...versionBump.failures,
      ...skew.failures,
      ...pinSync.failures,
    ],
    pairsChecked: [...drift.pairsChecked, gateDecision.pairChecked],
    versionSkew: skew,
  };
}

/** @internal Exported for subprocess-free unit tests of the CLI success/failure paths. */
export function runEngineParityMain(root: string = process.cwd()): number {
  const changedFiles = listChangedEngineParityFiles({ root });
  const headEngineVersion = readEnginePackageVersionAtRef({ root, ref: "HEAD" });
  const baseEngineVersion =
    changedFiles.length > 0
      ? readEnginePackageVersionAtRef({
          root,
          ref: process.env.GITTENSORY_ENGINE_PARITY_BASE_REF ?? process.env.GITHUB_BASE_SHA ?? "origin/main",
        }) ?? headEngineVersion
      : headEngineVersion;
  const { failures, pairsChecked, versionSkew } = runEngineParityChecks({
    root,
    changedFiles,
    baseEngineVersion,
    headEngineVersion,
  });

  if (failures.length > 0) {
    console.error(`Engine-parity check found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(failure);
    return 1;
  }

  console.log(
    `Engine-parity check ok: ${pairsChecked.length} hand-duplicated file pair(s) agree; ` +
      `${ENGINE_PACKAGE_NAME} ${versionSkew.installed} is ${versionSkew.skew} vs expected ${versionSkew.expected}.`,
  );
  return 0;
}

function main(): void {
  process.exit(runEngineParityMain(process.cwd()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
