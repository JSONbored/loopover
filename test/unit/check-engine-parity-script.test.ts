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
  discoverEngineParityPairs,
  discoverGateDecisionTwinPair,
  enginePackageVersionIncreased,
  GATE_DECISION_TWIN_PAIR,
  type EngineParityPair,
  isEngineStubPair,
  isThinEngineReExportShim,
  normalizeChangedPath,
  normalizeEngineParityText,
  normalizeImportSpec,
  parseEnginePackageVersion,
  runEngineParityChecks,
  runEngineParityMain,
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
    const shim = `// comment\nexport * from "../../packages/gittensory-engine/src/signals/test-evidence";\n`;
    expect(isThinEngineReExportShim(shim)).toBe(true);
    expect(isThinEngineReExportShim("export const MODE = 'strict';\n")).toBe(false);
    expect(isEngineStubPair("export const A = 1;\n".repeat(30), "export {};\n")).toBe(true);
  });

  it("passes when normalized host and engine copies are identical", () => {
    const body = "export const VALUE = 1;\nimport type { T } from \"../types\";\n";
    const readFile = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings/sample.ts") return body;
      if (relativePath === "packages/gittensory-engine/src/settings/sample.ts") return body;
      throw new Error(`unexpected read: ${relativePath}`);
    };
    const listDir = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings") return ["sample.ts"];
      if (relativePath === "packages/gittensory-engine/src/settings") return ["sample.ts"];
      return [];
    };
    const result = checkEngineParityDrift({ root: "/fake", readFile, listDir });
    expect(result.failures).toEqual([]);
    expect(result.pairsChecked).toHaveLength(1);
  });

  it("fails with a clear message when a discovered pair diverges", () => {
    const readFile = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings/autonomy.ts") return "export const MODE = 'strict';\n";
      if (relativePath === "packages/gittensory-engine/src/settings/autonomy.ts") return "export const MODE = 'relaxed';\n";
      throw new Error(`unexpected read: ${relativePath}`);
    };
    const listDir = (_root: string, relativePath: string) => {
      if (relativePath === "src/settings") return ["autonomy.ts"];
      if (relativePath === "packages/gittensory-engine/src/settings") return ["autonomy.ts"];
      return [];
    };
    const result = checkEngineParityDrift({ root: "/fake", readFile, listDir });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("src/settings/autonomy.ts");
    expect(result.failures[0]).toContain("packages/gittensory-engine/src/settings/autonomy.ts");
    expect(result.failures[0]).toContain("drifted apart");
  });

  it("discovers real in-scope pairs in the repository (regression guard)", () => {
    const pairs = discoverEngineParityPairs({ root: process.cwd() });
    expect(pairs.length).toBeGreaterThanOrEqual(14);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "guardrail-config.ts")).toBe(true);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "change-guardrail.ts")).toBe(true);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "duplicate-winner.ts")).toBe(false);
    expect(pairs.some((pair: EngineParityPair) => pair.fileName === "check-names.ts")).toBe(false);
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
        changedFiles: [GATE_DECISION_TWIN_PAIR.hostRelative, "packages/gittensory-engine/package.json"],
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
          if (relativePath === "packages/gittensory-engine/package.json") return JSON.stringify({ version: "0.2.0" });
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

        const engineDir = join(emptyRoot, "node_modules", "@jsonbored", "gittensory-engine");
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
          if (relativePath === "packages/gittensory-miner/expected-engine.version") return "0.1.0\n";
          throw new Error(`unexpected read: ${relativePath}`);
        },
        readExpected: () => "0.2.0",
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("out of sync");
    });

    it("uses default version readers against the real monorepo workspace", () => {
      expect(defaultResolveInstalledEngineVersion(process.cwd())).toMatch(/^\d+\.\d+\.\d+$/);
      expect(defaultReadExpectedEngineVersion(process.cwd())).toBe("0.2.0");
      const result = runEngineParityChecks({ root: process.cwd() });
      expect(result.failures).toEqual([]);
    });
  });

  it("runEngineParityMain returns 1 and logs failures when checks fail", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = runEngineParityMain("/definitely-not-a-gittensory-root");
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
        if (relativePath === "packages/gittensory-engine/package.json") return JSON.stringify({ version: "0.2.0" });
        if (relativePath === "src/settings/autonomy.ts") return "export const MODE = 'strict';\n";
        if (relativePath === "packages/gittensory-engine/src/settings/autonomy.ts") return "export const MODE = 'relaxed';\n";
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
        if (relativePath === "packages/gittensory-engine/src/settings") return ["autonomy.ts"];
        return [];
      },
      resolveInstalled: () => "0.1.0",
      readExpected: () => "0.2.0",
    });
    expect(combined.failures.length).toBeGreaterThanOrEqual(2);
  });
});
