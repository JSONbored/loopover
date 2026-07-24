import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkEngineParityDrift,
  checkGateDecisionTwinPresence,
  checkGateDecisionVersionBump,
  checkEngineVersionSkew,
  checkMinerEngineVersionPinSync,
  compareSemver,
  defaultReadExpectedEngineVersion,
  defaultResolveInstalledEngineVersion,
  describeEngineVersionSkew,
  DIFF_FILE_PRIORITY_MARKERS,
  DIFF_FILE_PRIORITY_TWIN_PAIR,
  discoverEngineParityPairs,
  discoverGateDecisionTwinPair,
  enginePackageVersionIncreased,
  GATE_DECISION_TWIN_PAIR,
  type EngineParityPair,
  isEngineStubPair,
  isThinEngineReExportShim,
  NAMED_TWIN_PAIRS,
  normalizeChangedPath,
  normalizeEngineParityText,
  normalizeImportSpec,
  parseEnginePackageVersion,
  runEngineParityChecks,
  runEngineParityMain,
  SAFE_URL_MARKERS,
  SAFE_URL_TWIN_PAIR,
  SECRET_DETECTION_MARKERS,
  SECRET_DETECTION_TWIN_PAIR,
  SHARES_MEANINGFUL_FILE_MARKERS,
  SHARES_MEANINGFUL_FILE_TWIN_PAIR,
} from "../../scripts/check-engine-parity";

const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");

describe("check-engine-parity script", () => {
  it("normalizes known-harmless import-path aliases", () => {
    expect(normalizeImportSpec("../types/predicted-gate-types.js")).toBe("../types");
    expect(normalizeImportSpec("../focus-manifest/guidance.js")).toBe("../signals/focus-manifest");
    const host = 'import type { X } from "../types/predicted-gate-types";\n';
    const engine = 'import type { X } from "../types/manifest-deps-types.js";\n';
    expect(normalizeEngineParityText(host)).toBe(normalizeEngineParityText(engine));
  });

  it("detects thin engine re-export shims and engine stub pairs", () => {
    const shim = `// comment\nexport * from "../../packages/loopover-engine/src/signals/test-evidence";\n`;
    expect(isThinEngineReExportShim(shim)).toBe(true);
    expect(isThinEngineReExportShim("export const MODE = 'strict';\n")).toBe(false);
    expect(isEngineStubPair("export const A = 1;\n".repeat(30), "export {};\n")).toBe(true);
  });

  it("passes when normalized host and engine copies are identical", () => {
    const body = "export const VALUE = 1;\nimport type { T } from \"../types\";\n";
    const readFile = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings/sample.ts") return body;
      if (relativePath === "packages/loopover-engine/src/settings/sample.ts") return body;
      throw new Error(`unexpected read: ${relativePath}`);
    };
    const listDir = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings") return ["sample.ts"];
      if (relativePath === "packages/loopover-engine/src/settings") return ["sample.ts"];
      return [];
    };
    const result = checkEngineParityDrift({ root: "/fake", readFile, listDir });
    expect(result.failures).toEqual([]);
    expect(result.pairsChecked).toHaveLength(1);
  });

  it("fails with a clear message when a discovered pair diverges", () => {
    const readFile = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings/autonomy.ts") return "export const MODE = 'strict';\n";
      if (relativePath === "packages/loopover-engine/src/settings/autonomy.ts") return "export const MODE = 'relaxed';\n";
      throw new Error(`unexpected read: ${relativePath}`);
    };
    const listDir = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings") return ["autonomy.ts"];
      if (relativePath === "packages/loopover-engine/src/settings") return ["autonomy.ts"];
      return [];
    };
    const result = checkEngineParityDrift({ root: "/fake", readFile, listDir });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("src/settings/autonomy.ts");
    expect(result.failures[0]).toContain("packages/loopover-engine/src/settings/autonomy.ts");
    expect(result.failures[0]).toContain("drifted apart");
  });

  it("discovers real in-scope pairs in the repository (regression guard)", () => {
    const pairs = discoverEngineParityPairs({ root: process.cwd() });
    // Tracked the count of still-hand-duplicated in-scope twins as a floor (with margin) through #6194 (14→10),
    // #6204 (change-guardrail.ts/preflight-limits.ts in src/signals/), and #6203 (the 9 remaining src/review/
    // twins: advisory-ai-routing-config/cla-check/enrichment-analyzer-names/guardrail-config/
    // linked-issue-hard-rules-config/linked-issue-label-propagation/pre-merge-checks/screenshot-table-gate/
    // unlinked-issue-guardrail-config) — the in-scope hand-duplicated set is now genuinely empty, so `toBe(0)`
    // is the precise (not vacuous, unlike a ">= 0" floor) regression guard: any real duplicate reappearing
    // fails this immediately. The `.some()` checks below name specific already-converged files individually,
    // so a regression on any ONE of them is diagnosable without re-running discovery by hand.
    expect(pairs.length).toBe(0);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "guardrail-config.ts")).toBe(false);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "change-guardrail.ts")).toBe(false);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "duplicate-winner.ts")).toBe(false);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "check-names.ts")).toBe(false);
  });

  describe("recursive nested-directory discovery (#4605)", () => {
    it("discovers a pair nested one directory deeper on BOTH sides, invisible to a top-level-only scan", () => {
      const body = "export const NESTED = 1;\n";
      const readFile = (_root: string, relativePath: string) => {
        if (relativePath === "src/review/sub/nested.ts") return body;
        if (relativePath === "packages/loopover-engine/src/review/sub/nested.ts") return body;
        throw new Error(`unexpected read: ${relativePath}`);
      };
      const listDir = (_root: string, relativePath: string) => {
        if (relativePath === "src/review") return ["sub"];
        if (relativePath === "src/review/sub") return ["nested.ts"];
        if (relativePath === "packages/loopover-engine/src/review") return ["sub"];
        if (relativePath === "packages/loopover-engine/src/review/sub") return ["nested.ts"];
        return [];
      };
      const pairs = discoverEngineParityPairs({ root: "/fake", readFile, listDir });
      expect(pairs).toHaveLength(1);
      expect(pairs[0]!.fileName).toBe("sub/nested.ts");
      expect(pairs[0]!.hostRelative).toBe("src/review/sub/nested.ts");
      expect(pairs[0]!.engineRelative).toBe("packages/loopover-engine/src/review/sub/nested.ts");
    });

    it("still requires an identical sub-path on both sides — a depth MISMATCH stays invisible to the scan (needs its own NAMED_TWIN_PAIRS entry)", () => {
      const body = "export const MISMATCHED = 1;\n";
      const readFile = (_root: string, relativePath: string) => {
        if (relativePath === "src/review/sub/mismatch.ts") return body;
        if (relativePath === "packages/loopover-engine/src/review/mismatch.ts") return body;
        throw new Error(`unexpected read: ${relativePath}`);
      };
      const listDir = (_root: string, relativePath: string) => {
        if (relativePath === "src/review") return ["sub"];
        if (relativePath === "src/review/sub") return ["mismatch.ts"];
        if (relativePath === "packages/loopover-engine/src/review") return ["mismatch.ts"];
        return [];
      };
      const pairs = discoverEngineParityPairs({ root: "/fake", readFile, listDir });
      expect(pairs).toHaveLength(0);
    });

    it("treats an empty listDir result for a non-.ts entry as a leaf (not a directory) rather than throwing", () => {
      // A plain file with no extension (or an empty real subdirectory) both resolve to listDir(...) === [];
      // collectTsFilesRecursive must not recurse into it or blow up either way — just contribute zero files.
      const listDir = (_root: string, relativePath: string) => {
        if (relativePath === "src/review") return ["not-a-directory-or-ts-file"];
        return [];
      };
      const pairs = discoverEngineParityPairs({ root: "/fake", readFile: () => "", listDir });
      expect(pairs).toEqual([]);
    });

    it("does not re-discover the already-invisible content-lane/safe-url.ts pair via recursion (depth mismatch, unchanged from before #4605's recursive fix)", () => {
      const scanned = discoverEngineParityPairs({ root: process.cwd() });
      expect(scanned.some((discovered) => discovered.fileName.endsWith("safe-url.ts"))).toBe(false);
    });
  });

  it("the real repo's hand-duplicated pairs agree after normalization (regression guard)", () => {
    const result = checkEngineParityDrift({ root: process.cwd() });
    expect(result.failures).toEqual([]);
  });

  describe("gate-decision twin coverage (#4518)", () => {
    it("discovers the advisory.ts <-> gate-advisory.ts pair outside ENGINE_PARITY_AREAS", () => {
      const pair = discoverGateDecisionTwinPair({ root: process.cwd() });
      expect(pair.hostRelative).toBe(GATE_DECISION_TWIN_PAIR.hostRelative);
      expect(pair.engineRelative).toBe(GATE_DECISION_TWIN_PAIR.engineRelative);
      expect(pair.hostText).toContain("function evaluateGateCheckCore");
      expect(pair.engineText).toContain("function evaluateGateCheckCore");
    });

    it("passes when both gate-decision twins change together without a version bump", () => {
      const result = checkGateDecisionVersionBump({
        changedFiles: [GATE_DECISION_TWIN_PAIR.hostRelative, GATE_DECISION_TWIN_PAIR.engineRelative],
        baseEngineVersion: "0.2.0",
        headEngineVersion: "0.2.0",
      });
      expect(result.failures).toEqual([]);
    });

    it("fails when only one gate-decision twin changes without an engine package version bump", () => {
      const hostOnly = checkGateDecisionVersionBump({
        changedFiles: [GATE_DECISION_TWIN_PAIR.hostRelative],
        baseEngineVersion: "0.2.0",
        headEngineVersion: "0.2.0",
      });
      expect(hostOnly.failures).toHaveLength(1);
      expect(hostOnly.failures[0]).toContain(GATE_DECISION_TWIN_PAIR.hostRelative);

      const engineOnly = checkGateDecisionVersionBump({
        changedFiles: [GATE_DECISION_TWIN_PAIR.engineRelative],
        baseEngineVersion: "0.2.0",
        headEngineVersion: "0.2.0",
      });
      expect(engineOnly.failures).toHaveLength(1);
      expect(engineOnly.failures[0]).toContain(GATE_DECISION_TWIN_PAIR.engineRelative);
    });

    it("passes when a single-sided gate-decision edit includes an engine package version bump", () => {
      const result = checkGateDecisionVersionBump({
        changedFiles: [GATE_DECISION_TWIN_PAIR.hostRelative, "packages/loopover-engine/package.json"],
        baseEngineVersion: "0.2.0",
        headEngineVersion: "0.2.1",
      });
      expect(result.failures).toEqual([]);
      expect(enginePackageVersionIncreased("0.2.0", "0.2.1")).toBe(true);
      expect(parseEnginePackageVersion(JSON.stringify({ version: "0.2.1" }))).toBe("0.2.1");
      expect(normalizeChangedPath(".\\src\\rules\\advisory.ts")).toBe("src/rules/advisory.ts");
    });

    it("includes the gate-decision twin in runEngineParityChecks pair coverage", () => {
      const gateBody = [
        "export function evaluateGateCheck() {}",
        "function evaluateGateCheckCore() {}",
        "function isConfiguredGateBlocker() {}",
        "export function buildPullRequestAdvisory() {}",
      ].join("\n");
      const combined = runEngineParityChecks({
        root: "/fake",
        readFile: (_root, relativePath) => {
          if (relativePath === "packages/loopover-engine/package.json") return JSON.stringify({ version: "0.2.0" });
          if (relativePath === GATE_DECISION_TWIN_PAIR.hostRelative) return gateBody;
          if (relativePath === GATE_DECISION_TWIN_PAIR.engineRelative) return gateBody;
          throw new Error(`unexpected read: ${relativePath}`);
        },
        listDir: () => [],
        resolveInstalled: () => "0.2.0",
        readExpected: () => "0.2.0",
        changedFiles: [GATE_DECISION_TWIN_PAIR.hostRelative],
        baseEngineVersion: "0.2.0",
        headEngineVersion: "0.2.0",
      });
      expect(combined.pairsChecked.some((pair) => pair.area === "gate-decision")).toBe(true);
      expect(combined.failures.some((failure) => failure.includes("Gate-decision logic change"))).toBe(true);
      expect(checkGateDecisionTwinPresence({
        root: "/fake",
        readFile: (_root, relativePath) => {
          if (relativePath === GATE_DECISION_TWIN_PAIR.hostRelative) return gateBody;
          if (relativePath === GATE_DECISION_TWIN_PAIR.engineRelative) return gateBody;
          throw new Error(`unexpected read: ${relativePath}`);
        },
      }).failures).toEqual([]);
    });

    // Regression guard for a real gap found while landing #7981: runEngineParityChecks previously aliased an
    // un-overridden baseEngineVersion straight to headEngineVersion, so a genuine version bump could never be
    // detected unless the caller passed baseEngineVersion explicitly (only runEngineParityMain did). That made
    // a single-sided gate-decision edit + version bump fail this check on any branch that had actually diverged
    // from origin/main, even though the bump was correct.
    it("resolves an un-overridden baseEngineVersion via git, mirroring the changedFiles default (#7981 side-discovery)", () => {
      const gateBody = [
        "export function evaluateGateCheck() {}",
        "function evaluateGateCheckCore() {}",
        "function isConfiguredGateBlocker() {}",
        "export function buildPullRequestAdvisory() {}",
      ].join("\n");
      const readFile = (_root: string, relativePath: string) => {
        if (relativePath === "packages/loopover-engine/package.json") return JSON.stringify({ version: "0.3.0" });
        if (relativePath === GATE_DECISION_TWIN_PAIR.hostRelative) return gateBody;
        if (relativePath === GATE_DECISION_TWIN_PAIR.engineRelative) return gateBody;
        if (relativePath === "packages/loopover-miner/expected-engine.version") return "0.3.0\n";
        throw new Error(`unexpected read: ${relativePath}`);
      };
      const execGit = vi.fn((args: string[]) => {
        if (args[0] === "show" && args[1] === "origin/main:packages/loopover-engine/package.json") {
          return JSON.stringify({ version: "0.2.0" });
        }
        throw new Error(`unexpected git invocation: ${args.join(" ")}`);
      });

      const result = runEngineParityChecks({
        root: "/fake",
        readFile,
        listDir: () => [],
        resolveInstalled: () => "0.3.0",
        changedFiles: [GATE_DECISION_TWIN_PAIR.hostRelative, "packages/loopover-engine/package.json"],
        headEngineVersion: "0.3.0",
        execGit,
        // baseEngineVersion intentionally omitted -- this is what previously aliased to headEngineVersion.
      });

      expect(result.failures.some((failure) => failure.includes("Gate-decision logic change"))).toBe(false);
      expect(execGit).toHaveBeenCalledWith(["show", "origin/main:packages/loopover-engine/package.json"], "/fake");
    });

    it("still fails a single-sided edit when git-resolved baseEngineVersion is unavailable (falls back to headEngineVersion, so no increase is observed)", () => {
      const gateBody = [
        "export function evaluateGateCheck() {}",
        "function evaluateGateCheckCore() {}",
        "function isConfiguredGateBlocker() {}",
        "export function buildPullRequestAdvisory() {}",
      ].join("\n");
      const readFile = (_root: string, relativePath: string) => {
        if (relativePath === "packages/loopover-engine/package.json") return JSON.stringify({ version: "0.3.0" });
        if (relativePath === GATE_DECISION_TWIN_PAIR.hostRelative) return gateBody;
        if (relativePath === GATE_DECISION_TWIN_PAIR.engineRelative) return gateBody;
        if (relativePath === "packages/loopover-miner/expected-engine.version") return "0.3.0\n";
        throw new Error(`unexpected read: ${relativePath}`);
      };
      const execGit = vi.fn(() => {
        throw new Error("git show failed");
      });

      const result = runEngineParityChecks({
        root: "/fake",
        readFile,
        listDir: () => [],
        resolveInstalled: () => "0.3.0",
        changedFiles: [GATE_DECISION_TWIN_PAIR.hostRelative, "packages/loopover-engine/package.json"],
        headEngineVersion: "0.3.0",
        execGit,
      });

      expect(result.failures.some((failure) => failure.includes("Gate-decision logic change"))).toBe(true);
    });

    it("skips git resolution and uses headEngineVersion when changedFiles is explicitly empty", () => {
      const execGit = vi.fn(() => {
        throw new Error("execGit should not be called when changedFiles is empty");
      });
      const result = runEngineParityChecks({
        root: "/fake",
        readFile: (_root, relativePath) => {
          if (relativePath === "packages/loopover-engine/package.json") return JSON.stringify({ version: "0.3.0" });
          if (relativePath === "packages/loopover-miner/expected-engine.version") return "0.3.0\n";
          throw new Error(`unexpected read: ${relativePath}`);
        },
        listDir: () => [],
        resolveInstalled: () => "0.3.0",
        changedFiles: [],
        headEngineVersion: "0.3.0",
        execGit,
      });
      // With no changedFiles, checkGateDecisionVersionBump never runs at all -- so no version-bump-shaped
      // failure appears regardless of the (unrelated) "could not load twin pair" noise from the other four
      // named twin pairs this readFile stub doesn't answer for.
      expect(result.failures.some((failure) => failure.includes("Gate-decision logic change"))).toBe(false);
      expect(execGit).not.toHaveBeenCalled();
    });
  });

  describe("named twin-pair coverage (#4605)", () => {
    it("registers the gate-decision, safe-url, diff-file-priority, shares-meaningful-file, and secret-detection pairs", () => {
      const areas = NAMED_TWIN_PAIRS.map(({ pair }) => pair.area);
      expect(areas).toEqual([
        "gate-decision",
        "content-lane",
        "diff-file-priority",
        "shares-meaningful-file",
        "secret-detection",
      ]);
    });

    it("discovers the content-lane/safe-url.ts pair invisible to the top-level directory scan", () => {
      const pair = discoverGateDecisionTwinPair({ root: process.cwd(), pair: SAFE_URL_TWIN_PAIR });
      expect(pair.hostRelative).toBe("src/review/content-lane/safe-url.ts");
      expect(pair.engineRelative).toBe("packages/loopover-engine/src/review/safe-url.ts");
      // Confirms the directory scan really would miss it: "safe-url.ts" is nested under content-lane/ on
      // the host, so a top-level readdirSync("src/review") pairing by filename never lists it.
      const scanned = discoverEngineParityPairs({ root: process.cwd() });
      expect(scanned.some((discovered) => discovered.fileName === "safe-url.ts")).toBe(false);
    });

    it("passes marker presence for all five named pairs against the real repo (regression guard)", () => {
      for (const { pair, markers } of NAMED_TWIN_PAIRS) {
        const result = checkGateDecisionTwinPresence({ root: process.cwd(), pair, markers });
        expect(result.failures).toEqual([]);
      }
    });

    it("diffFilePriority markers cover the Cartfile.resolved regression class at its root (#4605 Finding 1, #8357)", () => {
      // Reproduces the actual bug's ROOT CAUSE: a copy that hand-rolls its own lockfile-name regex can
      // silently drift (the engine copy once matched `cartfile\.lock`, not a real Carthage filename).
      // Since #8357 every copy delegates to the canonical isLockfile, so a body that still owns a private
      // name list fails presence — exactly what the old, un-checked engine copy would have done.
      const buggyEngineBody =
        "export function diffFilePriority(path: string): number {\n" +
        "  if (/cartfile\\.lock$/i.test(path)) return 4;\n" +
        "  return 0;\n" +
        "}\n";
      const fixedHostBody =
        "export function diffFilePriority(path: string): number {\n" +
        "  if (isLockfile(path)) return 4;\n" +
        "  return 0;\n" +
        "}\n";
      const result = checkGateDecisionTwinPresence({
        root: "/fake",
        readFile: (_root, relativePath) => {
          if (relativePath === DIFF_FILE_PRIORITY_TWIN_PAIR.hostRelative) return fixedHostBody;
          if (relativePath === DIFF_FILE_PRIORITY_TWIN_PAIR.engineRelative) return buggyEngineBody;
          throw new Error(`unexpected read: ${relativePath}`);
        },
        pair: DIFF_FILE_PRIORITY_TWIN_PAIR,
        markers: DIFF_FILE_PRIORITY_MARKERS,
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(DIFF_FILE_PRIORITY_TWIN_PAIR.engineRelative);
      expect(result.failures[0]).toContain(JSON.stringify(DIFF_FILE_PRIORITY_MARKERS[1]));
    });

    it("safe-url and shares-meaningful-file marker sets are non-empty and pair-specific", () => {
      expect(SAFE_URL_MARKERS.length).toBeGreaterThan(0);
      expect(SHARES_MEANINGFUL_FILE_MARKERS.length).toBeGreaterThan(0);
      expect(SHARES_MEANINGFUL_FILE_TWIN_PAIR.hostRelative).toBe("packages/loopover-engine/src/signals/engine.ts");
      expect(SHARES_MEANINGFUL_FILE_TWIN_PAIR.engineRelative).toBe(
        "packages/loopover-engine/src/signals/predicted-gate-engine.ts",
      );
    });

    it("includes all five named pairs in runEngineParityChecks pairsChecked", () => {
      const result = runEngineParityChecks({ root: process.cwd() });
      const checkedAreas = result.pairsChecked.map((pair) => pair.area);
      for (const { pair } of NAMED_TWIN_PAIRS) {
        expect(checkedAreas).toContain(pair.area);
      }
    });
  });

  describe("secret-detection twin coverage (#4608)", () => {
    it("pairs src/review/secret-patterns.ts with REES's genuinely-separate, wider copy", () => {
      expect(SECRET_DETECTION_TWIN_PAIR.hostRelative).toBe("src/review/secret-patterns.ts");
      expect(SECRET_DETECTION_TWIN_PAIR.engineRelative).toBe(
        "review-enrichment/src/analyzers/secret-scan.ts",
      );
      // Not discoverable by the generic src/{review,settings,signals} <-> packages/loopover-engine scan:
      // REES lives under review-enrichment/, a different root entirely.
      const scanned = discoverEngineParityPairs({ root: process.cwd() });
      expect(scanned.some((discovered) => discovered.fileName === "secret-patterns.ts")).toBe(false);
    });

    it("does not include the two kind names known to be named differently on REES's side (would false-fail)", () => {
      // REES calls these `private_key` / `aws_access_key_id` rather than
      // `private_key_block` / `aws_access_key` -- a pre-existing, out-of-scope naming divergence. Asserting
      // their ABSENCE here documents the deliberate omission and guards against someone "completing the
      // set" and reintroducing a false-fail.
      expect(SECRET_DETECTION_MARKERS).not.toContain('"private_key_block"');
      expect(SECRET_DETECTION_MARKERS).not.toContain('"aws_access_key"');
    });

    it("fails presence when the shared isPlaceholderSecretValue algorithm drifts on one side", () => {
      // Reproduces the drift class #4608 exists to catch: one side silently drops a placeholder-detection
      // exclusion rule (here, the mock-fixture carve-out) while the other keeps it. Both bodies start from
      // the FULL marker set (join, not a hand-picked subset) so only the deliberately dropped line
      // produces a failure -- a partial fixture would false-report every marker it happens to omit too.
      const droppedMarker = "if (LOWERCASE_HYPHENATED_MOCK_FIXTURE_PATTERN.test(value)) return true;";
      const hostBody = SECRET_DETECTION_MARKERS.join("\n");
      const driftedEngineBody = SECRET_DETECTION_MARKERS.filter((marker) => marker !== droppedMarker).join("\n");
      const result = checkGateDecisionTwinPresence({
        root: "/fake",
        readFile: (_root, relativePath) => {
          if (relativePath === SECRET_DETECTION_TWIN_PAIR.hostRelative) return hostBody;
          if (relativePath === SECRET_DETECTION_TWIN_PAIR.engineRelative) return driftedEngineBody;
          throw new Error(`unexpected read: ${relativePath}`);
        },
        pair: SECRET_DETECTION_TWIN_PAIR,
        markers: SECRET_DETECTION_MARKERS,
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(SECRET_DETECTION_TWIN_PAIR.engineRelative);
      expect(result.failures[0]).toContain(JSON.stringify(droppedMarker));
    });

    it("fails presence when a shared kind name is removed from REES's rule set", () => {
      const body = [
        "function isPlaceholderSecretValue(value: string): boolean {",
        "if (PLACEHOLDER_VALUE_PATTERN.test(value)) return true;",
        "if (new Set(value.toLowerCase()).size <= 2) return true;",
        "if (LOWERCASE_HYPHENATED_MOCK_FIXTURE_PATTERN.test(value)) return true;",
        "if (KNOWN_FIXTURE_SECRET_VALUES.has(value)) return true;",
        "return hasLongSequentialRun(value);",
      ].join("\n");
      const hostKinds = SECRET_DETECTION_MARKERS.filter((marker) => marker.startsWith('"')).join("\n");
      const engineKindsMissingVoyage = hostKinds.replace('"voyage_api_key"\n', "");
      const result = checkGateDecisionTwinPresence({
        root: "/fake",
        readFile: (_root, relativePath) => {
          if (relativePath === SECRET_DETECTION_TWIN_PAIR.hostRelative) return `${body}\n${hostKinds}`;
          if (relativePath === SECRET_DETECTION_TWIN_PAIR.engineRelative) return `${body}\n${engineKindsMissingVoyage}`;
          throw new Error(`unexpected read: ${relativePath}`);
        },
        pair: SECRET_DETECTION_TWIN_PAIR,
        markers: SECRET_DETECTION_MARKERS,
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain(SECRET_DETECTION_TWIN_PAIR.engineRelative);
      expect(result.failures[0]).toContain(JSON.stringify('"voyage_api_key"'));
    });
  });

  describe("engine version skew", () => {
    it("classifies equal, behind, and ahead boundary cases", () => {
      expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
      expect(describeEngineVersionSkew("0.2.0", "0.2.0")).toBe("equal");
      expect(compareSemver("0.1.9", "0.2.0")).toBe(-1);
      expect(describeEngineVersionSkew("0.1.9", "0.2.0")).toBe("behind");
      expect(compareSemver("0.3.0", "0.2.0")).toBe(1);
      expect(describeEngineVersionSkew("0.3.0", "0.2.0")).toBe("ahead");
    });

    it("passes when installed engine matches or exceeds the expected version", () => {
      const equal = checkEngineVersionSkew({
        root: "/fake",
        readFile: () => JSON.stringify({ version: "0.2.0" }),
        resolveInstalled: () => "0.2.0",
        readExpected: () => "0.2.0",
      });
      expect(equal.failures).toEqual([]);
      expect(equal.skew).toBe("equal");

      const ahead = checkEngineVersionSkew({
        root: "/fake",
        readFile: () => JSON.stringify({ version: "0.2.0" }),
        resolveInstalled: () => "0.2.1",
        readExpected: () => "0.2.0",
      });
      expect(ahead.failures).toEqual([]);
      expect(ahead.skew).toBe("ahead");
    });

    it("fails when installed engine is behind the monorepo expected version", () => {
      const result = checkEngineVersionSkew({
        root: "/fake",
        readFile: () => JSON.stringify({ version: "0.2.0" }),
        resolveInstalled: () => "0.1.0",
        readExpected: () => "0.2.0",
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("behind");
      expect(result.skew).toBe("behind");
    });

    it("fails when expected or installed engine versions are unavailable", () => {
      const missingExpected = checkEngineVersionSkew({
        root: "/fake",
        readFile: () => {
          throw new Error("missing");
        },
        resolveInstalled: () => "0.2.0",
        readExpected: () => null,
      });
      expect(missingExpected.failures[0]).toContain("Could not read expected");

      const missingInstalled = checkEngineVersionSkew({
        root: "/fake",
        readFile: () => JSON.stringify({ version: "0.2.0" }),
        resolveInstalled: () => null,
        readExpected: () => "0.2.0",
      });
      expect(missingInstalled.failures[0]).toContain("not installed");
    });

    it("treats unparseable semver as behind", () => {
      expect(compareSemver("not-a-version", "0.2.0")).toBe(-1);
      expect(describeEngineVersionSkew("not-a-version", "0.2.0")).toBe("behind");
    });
    it("default version readers handle missing or corrupt installs", () => {
      const emptyRoot = mkdtempSync(join(tmpdir(), "engine-parity-missing-"));
      try {
        expect(defaultResolveInstalledEngineVersion(emptyRoot)).toBeNull();
        expect(defaultReadExpectedEngineVersion(emptyRoot)).toBeNull();
        expect(defaultReadExpectedEngineVersion("/fake", () => {
          throw new Error("unreadable");
        })).toBeNull();

        const engineDir = join(emptyRoot, "node_modules", "@loopover", "engine");
        mkdirSync(engineDir, { recursive: true });
        writeFileSync(join(engineDir, "package.json"), "not-json");
        expect(defaultResolveInstalledEngineVersion(emptyRoot)).toBeNull();
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }
    });

    it("fails when the miner engine pin drifts from the monorepo engine package version", () => {
      const result = checkMinerEngineVersionPinSync({
        root: "/fake",
        readFile: (_root, relativePath) => {
          if (relativePath === "packages/loopover-miner/expected-engine.version") return "0.1.0\n";
          throw new Error(`unexpected read: ${relativePath}`);
        },
        readExpected: () => "0.2.0",
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("out of sync");
    });

    it("uses default version readers against the real monorepo workspace", () => {
      // Deliberately NOT a hardcoded literal (e.g. "0.2.0") -- that exact-value assertion would go stale on
      // every single engine release, exactly like the sibling hand-synced values this whole file exists to
      // catch drift in. The real invariant is that the reader returns a well-shaped semver AND that it
      // agrees with the installed version, which runEngineParityChecks below already verifies directly.
      expect(defaultResolveInstalledEngineVersion(process.cwd())).toMatch(/^\d+\.\d+\.\d+$/);
      expect(defaultReadExpectedEngineVersion(process.cwd())).toMatch(/^\d+\.\d+\.\d+$/);
      const result = runEngineParityChecks({ root: process.cwd() });
      expect(result.failures).toEqual([]);
    });
  });

  it("runEngineParityMain returns 1 and logs failures when checks fail", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = runEngineParityMain("/definitely-not-a-loopover-root");
    expect(exitCode).toBe(1);
    expect(errorLog).toHaveBeenCalled();
  });

  it("runEngineParityMain returns 0 for the real monorepo workspace", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runEngineParityMain(process.cwd())).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/Engine-parity check ok:/);
  });

  it("prints a clean summary and exits 0 for the real repo state when run as a subprocess", () => {
    const output = execFileSync(TSX_BIN, ["scripts/check-engine-parity.ts"], { encoding: "utf8" });
    expect(output).toMatch(/Engine-parity check ok:/);
    expect(output).toMatch(/hand-duplicated file pair/);
  });

  it("exits non-zero when run outside the monorepo workspace", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "engine-parity-empty-"));
    try {
      expect(() =>
        execFileSync(TSX_BIN, [join(process.cwd(), "scripts/check-engine-parity.ts")], {
          cwd: emptyRoot,
          encoding: "utf8",
        }),
      ).toThrow();
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("runEngineParityChecks aggregates drift and skew failures", () => {
    const combined = runEngineParityChecks({
      root: "/fake",
      readFile: (_root: string, relativePath: string) => {
        if (relativePath === "packages/loopover-engine/package.json") return JSON.stringify({ version: "0.2.0" });
        if (relativePath === "src/settings/autonomy.ts") return "export const MODE = 'strict';\n";
        if (relativePath === "packages/loopover-engine/src/settings/autonomy.ts") return "export const MODE = 'relaxed';\n";
        if (relativePath === GATE_DECISION_TWIN_PAIR.hostRelative) {
          return "export function evaluateGateCheck() {}\nfunction evaluateGateCheckCore() {}\nfunction isConfiguredGateBlocker() {}\nexport function buildPullRequestAdvisory() {}\n";
        }
        if (relativePath === GATE_DECISION_TWIN_PAIR.engineRelative) {
          return "export function evaluateGateCheck() {}\nfunction evaluateGateCheckCore() {}\nfunction isConfiguredGateBlocker() {}\nexport function buildPullRequestAdvisory() {}\n";
        }
        throw new Error(`unexpected read: ${relativePath}`);
      },
      listDir: (_root: string, relativePath: string) => {
        if (relativePath === "src/settings") return ["autonomy.ts"];
        if (relativePath === "packages/loopover-engine/src/settings") return ["autonomy.ts"];
        return [];
      },
      resolveInstalled: () => "0.1.0",
      readExpected: () => "0.2.0",
    });
    expect(combined.failures.length).toBeGreaterThanOrEqual(2);
  });
});
