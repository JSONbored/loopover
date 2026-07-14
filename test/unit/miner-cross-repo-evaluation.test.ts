import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  CROSS_REPO_FAILURE_CATEGORY,
  DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH,
  MAX_CROSS_REPO_MANIFEST_BYTES,
  formatCrossRepoEvaluationReport,
  evaluateRepoReadiness,
  normalizeCrossRepoFullName,
  parseCrossRepoEvaluationManifest,
  runCrossRepoEvaluation,
  scanPositiveLoopoverAssumptions,
  summarizeCrossRepoEvaluation,
} from "../../packages/loopover-miner/lib/cross-repo-evaluation.js";
import type { RepoStackResult } from "../../packages/loopover-miner/lib/stack-detection.js";
import {
  loadCrossRepoEvaluationManifest,
  parseCrossRepoEvaluationArgs,
  resolveDefaultManifestPath,
  runCrossRepoEvaluationCli,
} from "../../packages/loopover-miner/scripts/cross-repo-evaluation.mjs";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRepo(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "loopover-cross-repo-eval-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(root, rel), content, "utf8");
  }
  return root;
}

const pkg = (value: Record<string, unknown>) => JSON.stringify(value);

describe("cross-repo evaluation harness (#4788)", () => {
  describe("normalizeCrossRepoFullName", () => {
    it("accepts canonical owner/repo names and rejects unsafe values", () => {
      expect(normalizeCrossRepoFullName("acme/widgets")).toBe("acme/widgets");
      expect(normalizeCrossRepoFullName("  acme/widgets  ")).toBe("acme/widgets");
      expect(normalizeCrossRepoFullName("acme")).toBeNull();
      expect(normalizeCrossRepoFullName("acme/widgets/extra")).toBeNull();
      expect(normalizeCrossRepoFullName("../evil/repo")).toBeNull();
      expect(normalizeCrossRepoFullName(12)).toBeNull();
    });
  });

  describe("parseCrossRepoEvaluationManifest", () => {
    it("degrades missing or invalid content to an empty repo list with warnings", () => {
      expect(parseCrossRepoEvaluationManifest(null)).toEqual({
        present: false,
        manifest: { repos: [] },
        warnings: [],
      });
      expect(parseCrossRepoEvaluationManifest(42 as never).warnings[0]).toContain("string");
      expect(parseCrossRepoEvaluationManifest("   ").present).toBe(false);
      expect(parseCrossRepoEvaluationManifest("{").warnings[0]).toContain("valid JSON");
      expect(parseCrossRepoEvaluationManifest("[]").warnings[0]).toContain("JSON object");
    });

    it("rejects oversize manifests", () => {
      const parsed = parseCrossRepoEvaluationManifest(`{"repos":${" ".repeat(MAX_CROSS_REPO_MANIFEST_BYTES)}}`);
      expect(parsed.present).toBe(false);
      expect(parsed.warnings[0]).toContain("exceeded");
    });

    it("normalizes string and object repo entries and skips invalid duplicates", () => {
      const parsed = parseCrossRepoEvaluationManifest(
        JSON.stringify({
          repos: [
            "acme/alpha",
            { repoFullName: "acme/beta", stackHint: "nodejs", requireTestCommand: true },
            "acme/alpha",
            { repoFullName: "bad", requireTestCommand: "yes" },
            7,
          ],
        }),
      );
      expect(parsed.present).toBe(true);
      expect(parsed.manifest.repos).toEqual([
        { repoFullName: "acme/alpha", requireTestCommand: false },
        { repoFullName: "acme/beta", stackHint: "nodejs", requireTestCommand: true },
      ]);
      expect(parsed.warnings.some((w) => w.includes("duplicate"))).toBe(true);
      expect(parsed.warnings.some((w) => w.includes("invalid"))).toBe(true);
      expect(parsed.warnings.some((w) => w.includes("boolean"))).toBe(true);
      expect(parsed.warnings.some((w) => w.includes("non-string"))).toBe(true);
    });

    it("truncates manifests with more than the documented repo cap", () => {
      const repos = Array.from({ length: 105 }, (_, i) => `acme/repo-${i}`);
      const parsed = parseCrossRepoEvaluationManifest(JSON.stringify({ repos }));
      expect(parsed.manifest.repos).toHaveLength(100);
      expect(parsed.warnings.some((w) => w.includes("exceeded"))).toBe(true);
    });

    it("ignores non-string stackHint values with a warning", () => {
      const parsed = parseCrossRepoEvaluationManifest(
        JSON.stringify({ repos: [{ repoFullName: "acme/hint", stackHint: 42 }] }),
      );
      expect(parsed.manifest.repos[0]?.stackHint).toBeUndefined();
      expect(parsed.warnings.some((w) => w.includes("stackHint"))).toBe(true);
    });
    it("treats a non-array repos field as empty", () => {
      const parsed = parseCrossRepoEvaluationManifest(JSON.stringify({ repos: "nope" }));
      expect(parsed.manifest.repos).toEqual([]);
      expect(parsed.warnings[0]).toContain("must be a list");
    });
  });

  describe("scanPositiveLoopoverAssumptions", () => {
    it("ignores non-strings and negative guidance lines", () => {
      expect(scanPositiveLoopoverAssumptions(null as never)).toEqual([]);
      const text = [
        "Do not assume LoopOver CI conventions or `npm run test:ci`.",
        "Run npm run test:ci before finishing.",
      ].join("\n");
      expect(scanPositiveLoopoverAssumptions(text)).toEqual([
        { id: "test_ci_script", line: "Run npm run test:ci before finishing." },
      ]);
    });

    it("detects other positive assumption markers", () => {
      const findings = scanPositiveLoopoverAssumptions(
        ["Ensure codecov/patch is green.", "Label with gittensor:bug.", "Wait for the loopover gate."].join("\n"),
      );
      expect(findings.map((f) => f.id).sort()).toEqual(["codecov_patch", "gittensor_label", "loopover_gate"]);
    });
  });

  describe("evaluateRepoReadiness", () => {
    it("fails clone_setup when the repo path is absent", () => {
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/missing", requireTestCommand: false },
        { repoPath: "/tmp/definitely-missing-repo-path", existsSync: () => false },
      );
      expect(result.passed).toBe(false);
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP);
    });

    it("fails stack_detection_gap when no manifest is recognized", () => {
      const repoPath = tempRepo({ "README.md": "# hello" });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/plain", requireTestCommand: false },
        { repoPath, existsSync: () => true },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION);
      expect(result.stackDetected).toBe(false);
    });

    it("fails execution_gap when requireTestCommand is set but no test command is inferred", () => {
      const repoPath = tempRepo({ "package.json": pkg({}) });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/no-test", requireTestCommand: true },
        { repoPath, existsSync: () => true },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION);
      expect(result.stackDetected).toBe(true);
    });

    it("fails loopover_assumption when injected instructions leak LoopOver CI defaults", () => {
      const repoPath = tempRepo({
        "package.json": pkg({ scripts: { test: "node --test" } }),
      });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/leaky", requireTestCommand: false },
        {
          repoPath,
          existsSync: () => true,
          buildCodingTaskSpec: () => ({
            ready: true,
            instructions: "Please run npm run test:ci and satisfy codecov/patch.",
          }),
        },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.GITTENSOR_ASSUMPTION);
      expect(result.assumptionFindings.length).toBeGreaterThan(0);
    });

    it("fails execution_gap when the coding-task spec is not ready", () => {
      const repoPath = tempRepo({
        "package.json": pkg({ scripts: { test: "node --test" } }),
      });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/not-ready", requireTestCommand: false },
        {
          repoPath,
          existsSync: () => true,
          buildCodingTaskSpec: () => ({ ready: false, verdict: "avoid" }),
        },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION);
      expect(result.reason).toContain("avoid");
    });

    it("fails other when buildCodingTaskSpec throws", () => {
      const repoPath = tempRepo({
        "package.json": pkg({ scripts: { test: "node --test" } }),
      });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/throws", requireTestCommand: false },
        {
          repoPath,
          existsSync: () => true,
          buildCodingTaskSpec: () => {
            throw new Error("boom");
          },
        },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.OTHER);
      expect(result.reason).toBe("boom");
    });

    it("passes end-to-end for a plain Node repo without loopover-specific target config", () => {
      const repoPath = tempRepo({
        "package.json": pkg({ scripts: { test: "node --test" } }),
      });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/pass", requireTestCommand: true },
        { repoPath, existsSync: () => true },
      );
      expect(result.passed).toBe(true);
      expect(result.usedDefaultGoalSpec).toBe(true);
      expect(result.assumptionFindings).toEqual([]);
    });

    it("honors fixturePath and resolveRepoPath overrides", () => {
      const fixtureRepo = tempRepo({ "package.json": pkg({ scripts: { test: "node --test" } }) });
      const resolverRepo = tempRepo({ "package.json": pkg({ scripts: { test: "node --test" } }) });
      const viaFixture = evaluateRepoReadiness(
        { repoFullName: "acme/fixture", fixturePath: fixtureRepo, requireTestCommand: false },
        { existsSync: (path) => path === fixtureRepo },
      );
      expect(viaFixture.passed).toBe(true);

      const viaResolver = evaluateRepoReadiness(
        { repoFullName: "acme/resolver", requireTestCommand: false },
        { existsSync: (path) => path === resolverRepo, resolveRepoPath: () => resolverRepo },
      );
      expect(viaResolver.passed).toBe(true);
    });

    it("uses options.repoPath when no fixturePath is present", () => {
      const repoPath = tempRepo({ "package.json": pkg({ scripts: { test: "node --test" } }) });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/direct", requireTestCommand: false },
        { repoPath, existsSync: (path) => path === repoPath },
      );
      expect(result.passed).toBe(true);
    });

    it("falls back to a generic stack-detection reason when the detector omits one", () => {
      const repoPath = tempRepo({ "package.json": pkg({}) });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/no-reason", requireTestCommand: false },
        {
          repoPath,
          existsSync: () => true,
          // Simulate a legacy detector that omits `reason` at runtime; evaluateRepoReadiness must fall back.
          detectRepoStack: () => ({ detected: false }) as RepoStackResult,
        },
      );
      expect(result.reason).toContain("did not recognize");
    });

    it("rejects benchmark entries with invalid repo names", () => {
      const result = evaluateRepoReadiness({ repoFullName: "not-a-repo", requireTestCommand: false });
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.OTHER);
    });
  });

  describe("runCrossRepoEvaluation + summarizeCrossRepoEvaluation", () => {
    it("filters to a single repo and computes majority + category counts", () => {
      const parsed = parseCrossRepoEvaluationManifest(
        JSON.stringify({ repos: ["acme/a", "acme/b", "acme/c"] }),
      );
      const results = runCrossRepoEvaluation(parsed, {
        repoFilter: "acme/b",
        existsSync: () => false,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.repoFullName).toBe("acme/b");

      const summary = summarizeCrossRepoEvaluation([
        { passed: true },
        { passed: false, failureCategory: CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION },
        { passed: false, failureCategory: CROSS_REPO_FAILURE_CATEGORY.EXECUTION },
        { passed: true, usedDefaultGoalSpec: true },
      ] as never);
      expect(summary.total).toBe(4);
      expect(summary.passed).toBe(2);
      expect(summary.majorityPassed).toBe(false);
      expect(summary.withoutLoopoverConfig).toBe(4);
      expect(summary.failuresByCategory[CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION]).toBe(1);
      expect(summary.failuresByCategory[CROSS_REPO_FAILURE_CATEGORY.EXECUTION]).toBe(1);
    });

    it("reports majority passed and renders a stable text report", () => {
      const results = [
        {
          repoFullName: "acme/ok",
          passed: true,
          failureCategory: null,
          reason: null,
        },
        {
          repoFullName: "acme/bad",
          passed: false,
          failureCategory: CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP,
          reason: "missing clone",
        },
      ] as never;
      const summary = summarizeCrossRepoEvaluation(results);
      expect(summary.majorityPassed).toBe(false);
      expect(formatCrossRepoEvaluationReport(results, summary)).toBe(
        [
          "loopover-miner cross-repo evaluation",
          "",
          "PASS acme/ok",
          "FAIL acme/bad [clone_setup] missing clone",
          "",
          "summary: 1/2 passed (majority failed)",
          "without loopover-specific target config: 2/2",
          "",
          "failures by category:",
          "- clone_setup: 1",
        ].join("\n"),
      );
    });

    it("treats an empty result set as no majority", () => {
      const summary = summarizeCrossRepoEvaluation([]);
      expect(summary.majorityPassed).toBe(false);
      expect(summary.total).toBe(0);
    });

    it("reports a strict majority when more than half the repos pass", () => {
      const summary = summarizeCrossRepoEvaluation([
        { passed: true, usedDefaultGoalSpec: true },
        { passed: true, usedDefaultGoalSpec: true },
        { passed: false, failureCategory: null },
      ] as never);
      expect(summary.majorityPassed).toBe(true);
      expect(summary.failuresByCategory.other).toBe(1);
    });
  });

  describe("committed benchmark manifest + CLI", () => {
    it("parses the shipped cross-repo manifest", () => {
      const manifestPath = join(process.cwd(), "packages/loopover-miner", DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH);
      const parsed = loadCrossRepoEvaluationManifest(manifestPath);
      expect(parsed.present).toBe(true);
      expect(parsed.manifest.repos.length).toBeGreaterThanOrEqual(5);
      expect(parsed.warnings).toEqual([]);
    });

    it("parses CLI flags and resolves the default manifest path", () => {
      expect(parseCrossRepoEvaluationArgs(["--json", "--require-majority", "--repo", "acme/widgets"])).toEqual({
        manifestPath: resolveDefaultManifestPath(),
        json: true,
        repoFilter: "acme/widgets",
        requireMajority: true,
      });
      expect(parseCrossRepoEvaluationArgs(["--manifest"])).toEqual({ error: "Missing value for --manifest." });
      expect(parseCrossRepoEvaluationArgs(["--nope"])).toEqual({ error: "Unknown argument: --nope" });
      expect(parseCrossRepoEvaluationArgs(["--help"])).toEqual({ help: true });
    });

    it("runs the harness driver against a fixture manifest", () => {
      const repoPath = tempRepo({
        "package.json": pkg({ scripts: { test: "node --test" } }),
      });
      const manifestPath = tempRepo();
      writeFileSync(
        join(manifestPath, "manifest.json"),
        JSON.stringify({
          repos: [{ repoFullName: "acme/fixture", fixturePath: repoPath, requireTestCommand: true }],
        }),
        "utf8",
      );

      const { parsed, results, summary } = runCrossRepoEvaluationCli({
        manifestPath: join(manifestPath, "manifest.json"),
      });
      expect(parsed.warnings).toEqual([]);
      expect(results[0]?.passed).toBe(true);
      expect(summary.passed).toBe(1);
      expect(formatCrossRepoEvaluationReport(results, summary)).toContain("PASS acme/fixture");
    });

    it("parseCrossRepoEvaluationArgs treats a missing --repo value as an error", () => {
      expect(parseCrossRepoEvaluationArgs(["--repo"])).toEqual({ error: "Missing value for --repo." });
    });
  });

  it("documents the harness in packages/loopover-miner/docs/cross-repo-evaluation.md", () => {
    const doc = readFileSync(join(process.cwd(), "packages/loopover-miner/docs/cross-repo-evaluation.md"), "utf8");
    expect(doc).toContain("#4788");
    expect(doc).toContain("stack_detection_gap");
    expect(doc).toContain("cross-repo-evaluation.mjs");
    expect(doc).toContain("benchmarks/cross-repo/manifest.json");
  });
});
