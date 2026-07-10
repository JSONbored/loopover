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

/** Shared shape for an explicitly named (non-directory-discovered) host/engine twin pair. The directory
 *  scan below only pairs identical top-level filenames within src/{review,settings,signals}, so anything
 *  nested one directory deeper, differently named, or duplicated by FUNCTION rather than by whole file is
 *  invisible to it by construction — this is the escape hatch (#4518, generalized #4605). */
export type NamedTwinPair = Readonly<{
  area: string;
  hostRelative: string;
  engineRelative: string;
  hostFileName: string;
  engineFileName: string;
}>;

/** Hand-duplicated gate-decision twins live outside src/{review,settings,signals} (#4518). */
export const GATE_DECISION_TWIN_PAIR: NamedTwinPair = Object.freeze({
  area: "gate-decision",
  hostRelative: "src/rules/advisory.ts",
  engineRelative: "packages/gittensory-engine/src/advisory/gate-advisory.ts",
  hostFileName: "advisory.ts",
  engineFileName: "gate-advisory.ts",
});

export const GATE_DECISION_CORE_MARKERS = Object.freeze([
  "function evaluateGateCheckCore",
  "function isConfiguredGateBlocker",
  "export function buildPullRequestAdvisory",
  "export function evaluateGateCheck",
] as const);

/** `safe-url.ts` lives nested under src/review/content-lane/ on the host but flat under the engine's
 *  review/ dir, so the directory scan's identical-top-level-filename match never sees it — currently
 *  byte-identical, but that is luck, not enforcement (#4605 Finding 2). */
export const SAFE_URL_TWIN_PAIR: NamedTwinPair = Object.freeze({
  area: "content-lane",
  hostRelative: "src/review/content-lane/safe-url.ts",
  engineRelative: "packages/gittensory-engine/src/review/safe-url.ts",
  hostFileName: "safe-url.ts",
  engineFileName: "safe-url.ts",
});

export const SAFE_URL_MARKERS = Object.freeze([
  "export function isSafeHttpUrl",
  "export function isSafeEndpointUrl",
] as const);

/** `diffFilePriority` is duplicated by FUNCTION, not by file: two byte-identical host copies
 *  (review-diff.ts, review-grounding.ts) and a differently-named engine copy (diff-file-priority.ts) —
 *  none share a filename, so the directory scan never pairs them. The `cartfile\.resolved` marker directly
 *  regression-guards #4605 Finding 1: the engine copy's Carthage-lockfile regex had silently drifted to
 *  `cartfile\.lock`, which is not a real filename (Carthage's lockfile is `Cartfile.resolved`). */
export const DIFF_FILE_PRIORITY_TWIN_PAIR: NamedTwinPair = Object.freeze({
  area: "diff-file-priority",
  hostRelative: "src/review/review-diff.ts",
  engineRelative: "packages/gittensory-engine/src/review/diff-file-priority.ts",
  hostFileName: "review-diff.ts",
  engineFileName: "diff-file-priority.ts",
});

export const DIFF_FILE_PRIORITY_MARKERS = Object.freeze([
  "export function diffFilePriority(path: string): number {",
  "cartfile\\.resolved",
] as const);

/** `sharesMeaningfulFile` is a near-duplicate helper (the host folds its guard clause into one `if`; the
 *  engine splits it into two) that both gate collision-detection on the same `diffFilePriority` threshold.
 *  It lives inside much larger files on both sides, so it's invisible to the file-level scan too. */
export const SHARES_MEANINGFUL_FILE_TWIN_PAIR: NamedTwinPair = Object.freeze({
  area: "shares-meaningful-file",
  hostRelative: "src/signals/engine.ts",
  engineRelative: "packages/gittensory-engine/src/signals/predicted-gate-engine.ts",
  hostFileName: "engine.ts",
  engineFileName: "predicted-gate-engine.ts",
});

export const SHARES_MEANINGFUL_FILE_MARKERS = Object.freeze([
  "function sharesMeaningfulFile(left: string[] | undefined, right: string[] | undefined): boolean {",
  "diffFilePriority(path) < 4",
] as const);

/** Every explicitly named twin pair, checked for core-marker presence in `runEngineParityChecks` — the
 *  same escape hatch #4518 built for `GATE_DECISION_TWIN_PAIR`, generalized (#4605) so a function-level or
 *  nested-directory duplicate can be added here without inventing a new mechanism. `GATE_DECISION_TWIN_PAIR`
 *  additionally gets the co-edit-or-version-bump enforcement (`checkGateDecisionVersionBump`) since its two
 *  sides are deliberately maintained as structurally divergent implementations; the other pairs here are
 *  meant to stay much closer to byte-identical, so presence-check plus a content marker on the specific
 *  historically-drifted value (see `DIFF_FILE_PRIORITY_MARKERS`) is the proportionate guard for now. */
export const NAMED_TWIN_PAIRS: ReadonlyArray<{ pair: NamedTwinPair; markers: readonly string[] }> = Object.freeze([
  { pair: GATE_DECISION_TWIN_PAIR, markers: GATE_DECISION_CORE_MARKERS },
  { pair: SAFE_URL_TWIN_PAIR, markers: SAFE_URL_MARKERS },
  { pair: DIFF_FILE_PRIORITY_TWIN_PAIR, markers: DIFF_FILE_PRIORITY_MARKERS },
  { pair: SHARES_MEANINGFUL_FILE_TWIN_PAIR, markers: SHARES_MEANINGFUL_FILE_MARKERS },
]);
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

/** Recursively collect `.ts` file paths under `dirRelative` (relative to `root`), reusing the same
 *  pluggable `listDir(root, relativePath)` shape `discoverEngineParityPairs` already accepted (#4605
 *  Finding 2: the old scan only listed the immediate children of each area directory, so a duplicate
 *  nested one level deeper -- e.g. `content-lane/` -- was invisible by construction even though the
 *  filter/shim/stub checks below it would have handled it fine). An entry ending in `.ts` is treated as a
 *  leaf file; anything else is probed with another `listDir` call and treated as a subdirectory only if
 *  that call returns at least one entry -- `defaultListDir` already resolves a non-directory path (or a
 *  missing one) to `[]` via its catch-all, so this reuses that existing convention rather than requiring
 *  callers to distinguish files from directories themselves (a plain `readdirSync` result can't tell them
 *  apart without an extra stat call per entry). An empty real subdirectory is indistinguishable from "not a
 *  directory" under this convention, which is harmless -- either way it contributes zero `.ts` files. */
function collectTsFilesRecursive(root: string, dirRelative: string, listDir: EngineParityListDir): string[] {
  const results: string[] = [];
  for (const entry of listDir(root, dirRelative)) {
    if (entry.endsWith(".ts")) {
      results.push(join(dirRelative, entry));
      continue;
    }
    const subRelative = join(dirRelative, entry);
    const subEntries = listDir(root, subRelative);
    if (subEntries.length > 0) results.push(...collectTsFilesRecursive(root, subRelative, listDir));
  }
  return results;
}

/**
 * Discover in-scope hand-duplicated twins under src/{review,settings,signals} (at any nesting depth, matched
 * by identical sub-path on both sides -- a depth MISMATCH, like `content-lane/safe-url.ts` on the host vs a
 * flat `safe-url.ts` on the engine, still needs its own `NAMED_TWIN_PAIRS` entry, same as before) that also
 * exist in the engine tree and are neither host shims nor engine stubs.
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
    const hostFiles = collectTsFilesRecursive(root, hostDir, listDir);
    const engineFiles = new Set(collectTsFilesRecursive(root, engineDir, listDir));
    for (const hostRelative of hostFiles.sort()) {
      const subPath = hostRelative.slice(hostDir.length + 1);
      const engineRelative = join(engineDir, subPath);
      if (!engineFiles.has(engineRelative)) continue;
      const hostText = readFile(root, hostRelative);
      const engineText = readFile(root, engineRelative);
      if (isThinEngineReExportShim(hostText)) continue;
      if (isEngineStubPair(hostText, engineText)) continue;
      pairs.push({ area, fileName: subPath, hostRelative, engineRelative, hostText, engineText });
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

/** Load an explicitly named twin pair (default: the gate-decision pair) for monitoring and, for
 *  gate-decision specifically, PR version-bump enforcement. */
export function discoverGateDecisionTwinPair({
  root,
  readFile = defaultReadFile,
  pair = GATE_DECISION_TWIN_PAIR,
}: {
  root: string;
  readFile?: EngineParityReadFile;
  pair?: NamedTwinPair;
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

/** Structural guard: both sides of a named twin pair still expose its core markers — e.g. the
 *  gate-decision twins' core entrypoints (#4518), or a hand-duplicated function's signature and any
 *  historically-drifted literal it must keep matching (#4605). */
export function checkGateDecisionTwinPresence({
  root,
  readFile = defaultReadFile,
  pair = GATE_DECISION_TWIN_PAIR,
  markers = GATE_DECISION_CORE_MARKERS,
}: {
  root: string;
  readFile?: EngineParityReadFile;
  pair?: NamedTwinPair;
  markers?: readonly string[];
}): { failures: string[]; pairChecked: EngineParityPair } {
  let twin: EngineParityPair;
  try {
    twin = discoverGateDecisionTwinPair({ root, readFile, pair });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      failures: [`Could not load ${pair.area} twin pair files: ${message}`],
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
      failures.push(`${pair.hostRelative} is missing expected twin-pair marker ${JSON.stringify(marker)}.`);
    }
    if (!twin.engineText.includes(marker)) {
      failures.push(`${pair.engineRelative} is missing expected twin-pair marker ${JSON.stringify(marker)}.`);
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
  pair?: NamedTwinPair;
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

/** Run drift, named-twin-pair marker-presence, version-skew, and optional PR version-bump checks. */
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
  const readFile = options.readFile ?? defaultReadFile;
  // Every named pair (gate-decision + #4605's safe-url/diff-file-priority/shares-meaningful-file) gets a
  // marker-presence check. Only gate-decision additionally gets the co-edit-or-version-bump enforcement
  // below — its two sides are deliberately maintained as structurally divergent implementations, while the
  // other pairs are meant to stay close to byte-identical and already carry a content-level marker on the
  // specific value that drifted (see e.g. `DIFF_FILE_PRIORITY_MARKERS`).
  const namedTwinPresence = NAMED_TWIN_PAIRS.map(({ pair, markers }) =>
    checkGateDecisionTwinPresence({ root: options.root, readFile, pair, markers }),
  );
  const skew = checkEngineVersionSkew(options);
  const pinSync = checkMinerEngineVersionPinSync(options);
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
      ...namedTwinPresence.flatMap((result) => result.failures),
      ...versionBump.failures,
      ...skew.failures,
      ...pinSync.failures,
    ],
    pairsChecked: [...drift.pairsChecked, ...namedTwinPresence.map((result) => result.pairChecked)],
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
