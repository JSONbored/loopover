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
  defaultRunLocalCommand,
  executeRepoAttempt,
  formatCrossRepoEvaluationReport,
  evaluateRepoReadiness,
  normalizeCrossRepoFullName,
  parseCrossRepoEvaluationManifest,
  runCrossRepoEvaluation,
  runCrossRepoExecution,
  scanPositiveLoopoverAssumptions,
  summarizeCrossRepoEvaluation,
} from "../../packages/loopover-miner/lib/cross-repo-evaluation.js";
import type { CodingAttemptContext } from "../../packages/loopover-miner/lib/cross-repo-evaluation.js";
import type { RepoStackResult } from "../../packages/loopover-miner/lib/stack-detection.js";
import {
  defaultFullExecutionCodingAttempt,
  loadCrossRepoEvaluationManifest,
  parseCrossRepoEvaluationArgs,
  resolveDefaultManifestPath,
  runCrossRepoEvaluationCli,
  runCrossRepoExecutionCli,
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

    // #5831: this file's own copy of the path-safety check now comes from repo-clone.js's shared
    // isValidRepoSegment -- exercise a traversal/invalid-character segment in both the owner and repo
    // position (a "one slash" value, unlike "../evil/repo" above which is rejected earlier for having two).
    it("rejects an unsafe owner or repo segment even with exactly one slash", () => {
      expect(normalizeCrossRepoFullName("../foo")).toBeNull();
      expect(normalizeCrossRepoFullName("foo/..")).toBeNull();
      expect(normalizeCrossRepoFullName("ac me/widgets")).toBeNull();
      expect(normalizeCrossRepoFullName("acme/wid gets")).toBeNull();
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

    it("measures the size guard in true UTF-8 bytes, not UTF-16 code units (#7223)", () => {
      // A small manifest carrying all four code-point widths — 1-byte 'a', 2-byte 'é', 3-byte '中', 4-byte '😀' —
      // stays well under the cap and parses normally (exercises every branch of the byte counter).
      const mixed = parseCrossRepoEvaluationManifest('{"repos":[],"note":"aé中😀"}');
      expect(mixed.warnings.some((warning) => warning.includes("exceeded"))).toBe(false);
      expect(mixed.present).toBe(true);

      // 25,000 three-byte characters: UTF-16 `.length` is 25,000 (under the cap) but the real UTF-8 size is
      // 75,000 bytes (over it). The old code-unit guard wrongly admitted this; the byte guard rejects it up front.
      const oversizeByBytes = "中".repeat(25_000);
      expect(oversizeByBytes.length).toBeLessThanOrEqual(MAX_CROSS_REPO_MANIFEST_BYTES);
      const parsed = parseCrossRepoEvaluationManifest(oversizeByBytes);
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

    it("treats an object with a missing or null repos field as an empty repo list", () => {
      const missing = parseCrossRepoEvaluationManifest(JSON.stringify({}));
      expect(missing.present).toBe(true);
      expect(missing.manifest.repos).toEqual([]);
      expect(missing.warnings).toEqual([]);

      const nulled = parseCrossRepoEvaluationManifest(JSON.stringify({ repos: null }));
      expect(nulled.present).toBe(true);
      expect(nulled.manifest.repos).toEqual([]);
      expect(nulled.warnings).toEqual([]);
    });

    it("drops a whitespace-only stackHint / fixturePath to undefined without a warning", () => {
      const parsed = parseCrossRepoEvaluationManifest(
        JSON.stringify({ repos: [{ repoFullName: "acme/blank", stackHint: "   ", fixturePath: "  " }] }),
      );
      expect(parsed.manifest.repos).toEqual([{ repoFullName: "acme/blank", requireTestCommand: false }]);
      expect(parsed.manifest.repos[0]?.stackHint).toBeUndefined();
      expect(parsed.manifest.repos[0]?.fixturePath).toBeUndefined();
      expect(parsed.warnings).toEqual([]);
    });

    it("parses the fullExecution flag, attaching it only when true (#7634)", () => {
      const parsed = parseCrossRepoEvaluationManifest(
        JSON.stringify({
          repos: [
            { repoFullName: "acme/on", fullExecution: true },
            { repoFullName: "acme/off", fullExecution: false },
            { repoFullName: "acme/absent" },
            { repoFullName: "acme/bad", fullExecution: "yes" },
          ],
        }),
      );
      expect(parsed.manifest.repos).toEqual([
        { repoFullName: "acme/on", requireTestCommand: false, fullExecution: true },
        { repoFullName: "acme/off", requireTestCommand: false },
        { repoFullName: "acme/absent", requireTestCommand: false },
        { repoFullName: "acme/bad", requireTestCommand: false },
      ]);
      expect(parsed.warnings.some((w) => w.includes("fullExecution"))).toBe(true);
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

    it("reports a non-string repoFullName as the placeholder '(invalid)'", () => {
      const result = evaluateRepoReadiness({ repoFullName: 123 } as never);
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.OTHER);
      expect(result.repoFullName).toBe("(invalid)");
    });

    it("fails other with String(error) when buildCodingTaskSpec throws a non-Error value", () => {
      const repoPath = tempRepo({ "package.json": pkg({ scripts: { test: "node --test" } }) });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/throws-string", requireTestCommand: false },
        {
          repoPath,
          existsSync: () => true,
          buildCodingTaskSpec: () => {
            throw "kaboom-string";
          },
        },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.OTHER);
      expect(result.reason).toBe("kaboom-string");
    });

    it("falls back to a 'unknown' verdict when an unready spec omits its verdict", () => {
      const repoPath = tempRepo({ "package.json": pkg({ scripts: { test: "node --test" } }) });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/no-verdict", requireTestCommand: false },
        { repoPath, existsSync: () => true, buildCodingTaskSpec: () => ({ ready: false }) },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION);
      expect(result.reason).toContain("unknown");
    });

    it("treats a ready spec with no instructions as leak-free (empty-string scan fallback)", () => {
      const repoPath = tempRepo({ "package.json": pkg({ scripts: { test: "node --test" } }) });
      const result = evaluateRepoReadiness(
        { repoFullName: "acme/no-instructions", requireTestCommand: false },
        { repoPath, existsSync: () => true, buildCodingTaskSpec: () => ({ ready: true }) },
      );
      expect(result.passed).toBe(true);
      expect(result.assumptionFindings).toEqual([]);
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

    it("runCrossRepoEvaluation treats a parsed manifest without a repos list as no repos", () => {
      expect(runCrossRepoEvaluation({} as never)).toEqual([]);
      expect(runCrossRepoEvaluation(undefined as never)).toEqual([]);
    });

    it("summarizeCrossRepoEvaluation treats a non-array input as an empty run", () => {
      const summary = summarizeCrossRepoEvaluation(null as never);
      expect(summary.total).toBe(0);
      expect(summary.majorityPassed).toBe(false);
    });

    it("formatCrossRepoEvaluationReport defaults its summary and omits the totals line for an empty run", () => {
      // Called with a single argument: the summary defaults to summarizeCrossRepoEvaluation([]) (total 0), so the
      // "without loopover-specific target config" line and the failures-by-category block are both omitted.
      const report = formatCrossRepoEvaluationReport([]);
      expect(report).toBe(
        ["loopover-miner cross-repo evaluation", "", "", "summary: 0/0 passed (majority failed)"].join("\n"),
      );
    });

    it("formatCrossRepoEvaluationReport sorts multiple failure categories alphabetically", () => {
      const results = [
        { repoFullName: "acme/a", passed: false, failureCategory: CROSS_REPO_FAILURE_CATEGORY.STACK_DETECTION, reason: "x" },
        { repoFullName: "acme/b", passed: false, failureCategory: CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP, reason: "y" },
      ] as never;
      const report = formatCrossRepoEvaluationReport(results);
      // clone_setup sorts before stack_detection_gap (the sort comparator runs only with >= 2 categories).
      const cloneIdx = report.indexOf("- clone_setup: 1");
      const stackIdx = report.indexOf("- stack_detection_gap: 1");
      expect(cloneIdx).toBeGreaterThan(-1);
      expect(stackIdx).toBeGreaterThan(cloneIdx);
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
        fullExecution: false,
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

  describe("full-execution mode (#7634)", () => {
    const nodeRepo = () => tempRepo({ "package.json": pkg({ scripts: { test: "node --test" } }) });
    const okAttempt = (diff: string) => () => Promise.resolve({ ok: true, diff });

    it("passes readiness failures straight through with executed:false", async () => {
      const result = await executeRepoAttempt(
        { repoFullName: "acme/missing", requireTestCommand: false },
        { repoPath: "/tmp/definitely-missing", existsSync: () => false, runCodingAttempt: okAttempt("x") },
      );
      expect(result.executed).toBe(false);
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP);
    });

    it("reports execution_no_diff when no coding-agent executor is configured", async () => {
      const result = await executeRepoAttempt(
        { repoFullName: "acme/unwired", requireTestCommand: false },
        { repoPath: nodeRepo(), existsSync: () => true },
      );
      expect(result.executed).toBe(true);
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NO_DIFF);
      expect(result.reason).toContain("No coding-agent executor");
    });

    it("reports execution_no_diff when the agent throws", async () => {
      const result = await executeRepoAttempt(
        { repoFullName: "acme/boom", requireTestCommand: false },
        {
          repoPath: nodeRepo(),
          existsSync: () => true,
          runCodingAttempt: () => {
            throw new Error("driver exploded");
          },
        },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NO_DIFF);
      expect(result.reason).toContain("driver exploded");
      expect(result.diffChars).toBeNull();
    });

    it("reports execution_no_diff when the agent fails and produces no diff", async () => {
      const result = await executeRepoAttempt(
        { repoFullName: "acme/empty", requireTestCommand: false },
        {
          repoPath: nodeRepo(),
          existsSync: () => true,
          runCodingAttempt: () => Promise.resolve({ ok: false, diff: "   ", error: "agent gave up" }),
        },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NO_DIFF);
      expect(result.reason).toBe("agent gave up");
    });

    it("reports execution_compile_gap when the generated diff does not build", async () => {
      const result = await executeRepoAttempt(
        { repoFullName: "acme/nobuild", requireTestCommand: false },
        {
          repoPath: nodeRepo(),
          existsSync: () => true,
          runCodingAttempt: okAttempt("diff --git a/x b/x\n+broken"),
          compileRepo: () => ({ ok: false, code: 1, output: "SyntaxError: bad token\nmore" }),
          runRepoTests: () => ({ ok: true }),
        },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION_COMPILE);
      expect(result.compilePassed).toBe(false);
      expect(result.testsPassed).toBeNull();
      expect(result.reason).toContain("SyntaxError: bad token");
    });

    it("reports execution_test_failure when the built diff fails the target test suite", async () => {
      const result = await executeRepoAttempt(
        { repoFullName: "acme/redtests", requireTestCommand: false },
        {
          repoPath: nodeRepo(),
          existsSync: () => true,
          runCodingAttempt: okAttempt("diff --git a/x b/x\n+change"),
          compileRepo: () => ({ ok: true }),
          runRepoTests: () => ({ ok: false, code: 1, output: "1 failing" }),
        },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION_TEST);
      expect(result.compilePassed).toBe(true);
      expect(result.testsPassed).toBe(false);
      expect(result.reason).toContain("1 failing");
    });

    it("reports execution_noop_diff when tests pass but the diff is empty", async () => {
      const result = await executeRepoAttempt(
        { repoFullName: "acme/noop", requireTestCommand: false },
        {
          repoPath: nodeRepo(),
          existsSync: () => true,
          runCodingAttempt: okAttempt("   \n  "),
          compileRepo: () => ({ ok: true }),
          runRepoTests: () => ({ ok: true }),
        },
      );
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION_NOOP);
      expect(result.testsPassed).toBe(true);
      expect(result.diffChars).toBe(0);
    });

    it("passes end-to-end when a real diff builds and the tests pass", async () => {
      const result = await executeRepoAttempt(
        { repoFullName: "acme/green", requireTestCommand: false },
        {
          repoPath: nodeRepo(),
          existsSync: () => true,
          runCodingAttempt: okAttempt("diff --git a/x b/x\n+real change"),
          compileRepo: () => ({ ok: true }),
          runRepoTests: () => ({ ok: true }),
        },
      );
      expect(result.passed).toBe(true);
      expect(result.executed).toBe(true);
      expect(result.compilePassed).toBe(true);
      expect(result.testsPassed).toBe(true);
      expect(result.diffChars).toBeGreaterThan(0);
    });

    it("uses the default compile/test runners via an injected runLocalCommand (skips a null build command)", async () => {
      const commands: string[] = [];
      const result = await executeRepoAttempt(
        { repoFullName: "acme/defaults", requireTestCommand: true },
        {
          repoPath: nodeRepo(),
          existsSync: () => true,
          runCodingAttempt: okAttempt("diff --git a/x b/x\n+change"),
          runLocalCommand: (command) => {
            commands.push(command);
            return { ok: true, code: 0, output: "" };
          },
        },
      );
      expect(result.passed).toBe(true);
      // The plain-Node repo has a test script but no build script, so only the inferred test command is spawned.
      expect(commands).toEqual(["npm test"]);
    });

    it("threads the derived instructions and attemptId into the coding agent", async () => {
      let seen: CodingAttemptContext | null = null;
      const result = await executeRepoAttempt(
        { repoFullName: "acme/threaded", requireTestCommand: false },
        {
          repoPath: nodeRepo(),
          existsSync: () => true,
          runCodingAttempt: (context) => {
            seen = context;
            return Promise.resolve({ ok: true, diff: "diff --git a/x b/x\n+c" });
          },
          compileRepo: () => ({ ok: true }),
          runRepoTests: () => ({ ok: true }),
        },
      );
      expect(result.passed).toBe(true);
      expect(seen).not.toBeNull();
      expect(seen!.attemptId).toBe("cross-repo-exec-acme__threaded");
      expect(typeof seen!.instructions).toBe("string");
    });

    it("runCrossRepoExecution runs only fullExecution entries, and a repoFilter overrides the flag", async () => {
      const parsed = parseCrossRepoEvaluationManifest(
        JSON.stringify({
          repos: [
            { repoFullName: "acme/a", fullExecution: true },
            { repoFullName: "acme/b" },
            { repoFullName: "acme/c", fullExecution: true },
          ],
        }),
      );
      const opts = { existsSync: () => false, runCodingAttempt: okAttempt("x") };

      const subset = await runCrossRepoExecution(parsed, opts);
      expect(subset.map((r) => r.repoFullName)).toEqual(["acme/a", "acme/c"]);

      const filtered = await runCrossRepoExecution(parsed, { ...opts, repoFilter: "acme/b" });
      expect(filtered.map((r) => r.repoFullName)).toEqual(["acme/b"]);
    });

    it("defaultFullExecutionCodingAttempt runs the driver then captures the staged diff via git", async () => {
      const calls: string[][] = [];
      const fakeDriver = {
        run: async () => ({ ok: true, changedFiles: ["x"], summary: "done" }),
      };
      const fakeSpawn = ((cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        return args.includes("diff")
          ? { stdout: "diff --git a/x b/x\n+1", status: 0 }
          : { stdout: "", status: 0 };
      }) as never;

      const outcome = await defaultFullExecutionCodingAttempt(
        {
          repoFullName: "acme/x",
          repoPath: nodeRepo(),
          stack: { detected: true } as never,
          instructions: "do the thing",
          attemptId: "a1",
          maxTurns: 5,
        },
        { driver: fakeDriver, spawnSync: fakeSpawn },
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.diff).toContain("diff --git");
      expect(calls[0]).toEqual(["git", "add", "-A"]);
      expect(calls[1]).toEqual(["git", "--no-pager", "diff", "--cached"]);
    });

    it("defaultRunLocalCommand spawns the argv directly with no shell (no `sh -c` injection surface)", () => {
      let seen: { file: string; args: string[]; opts: Record<string, unknown> } | null = null;
      const fakeSpawn = ((file: string, args: string[], opts: Record<string, unknown>) => {
        seen = { file, args, opts };
        return { stdout: "out", stderr: "err", status: 0 };
      }) as never;

      const result = defaultRunLocalCommand("npm run build", { cwd: "/clone", env: { FOO: "1" } }, fakeSpawn);

      expect(result).toEqual({ ok: true, code: 0, output: "outerr" });
      // The command must be split into a real argv and run WITHOUT a shell — never `sh -c "<command>"`.
      expect(seen!.file).toBe("npm");
      expect(seen!.args).toEqual(["run", "build"]);
      expect(seen!.opts.shell).toBe(false);
      expect(seen!.opts.cwd).toBe("/clone");
      expect(seen!.opts.env).toEqual({ FOO: "1" });
    });

    it("defaultRunLocalCommand keeps a crafted script name as an inert argv token (no metacharacter injection)", () => {
      let seen: { file: string; args: string[] } | null = null;
      const fakeSpawn = ((file: string, args: string[]) => {
        seen = { file, args };
        return { status: 1 };
      }) as never;

      // A malicious repo whose build script is named `build; rm -rf ~` would inject via `sh -c`; here it stays one token.
      const result = defaultRunLocalCommand("npm run build;rm", { cwd: "/clone" }, fakeSpawn);

      // Missing stdout/stderr default to empty; a non-zero exit resolves to ok:false rather than throwing.
      expect(result).toEqual({ ok: false, code: 1, output: "" });
      expect(seen!.file).toBe("npm");
      expect(seen!.args).toEqual(["run", "build;rm"]);
    });

    it("defaultRunLocalCommand surfaces a spawn error as ok:false with the error message", () => {
      const fakeSpawn = (() => ({ error: new Error("spawn ENOENT") })) as never;
      const result = defaultRunLocalCommand("cargo build", { cwd: "/clone" }, fakeSpawn);
      expect(result).toEqual({ ok: false, code: null, output: "spawn ENOENT" });
    });

    it("defaultRunLocalCommand rejects an empty command without spawning anything", () => {
      let spawned = false;
      const fakeSpawn = (() => {
        spawned = true;
        return { status: 0 };
      }) as never;
      const result = defaultRunLocalCommand("   ", { cwd: "/clone" }, fakeSpawn);
      expect(result).toEqual({ ok: false, code: null, output: "empty command" });
      expect(spawned).toBe(false);
    });

    it("runCrossRepoExecutionCli drives a fixture manifest with injected primitives", async () => {
      const repoPath = nodeRepo();
      const manifestDir = tempRepo();
      writeFileSync(
        join(manifestDir, "manifest.json"),
        JSON.stringify({
          repos: [{ repoFullName: "acme/fixture", fixturePath: repoPath, requireTestCommand: true, fullExecution: true }],
        }),
        "utf8",
      );

      const { results, summary } = await runCrossRepoExecutionCli({
        manifestPath: join(manifestDir, "manifest.json"),
        runCodingAttempt: okAttempt("diff --git a/x b/x\n+shipped"),
        compileRepo: () => ({ ok: true }),
        runRepoTests: () => ({ ok: true }),
      });
      expect(results[0]?.passed).toBe(true);
      expect(results[0]?.executed).toBe(true);
      expect(summary.passed).toBe(1);
    });
  });

  it("documents the harness in packages/loopover-miner/docs/cross-repo-evaluation.md", () => {
    const doc = readFileSync(join(process.cwd(), "packages/loopover-miner/docs/cross-repo-evaluation.md"), "utf8");
    expect(doc).toContain("#4788");
    expect(doc).toContain("stack_detection_gap");
    expect(doc).toContain("cross-repo-evaluation.mjs");
    expect(doc).toContain("benchmarks/cross-repo/manifest.json");
  });

  it("documents the full-execution mode and its taxonomy (#7634)", () => {
    const doc = readFileSync(join(process.cwd(), "packages/loopover-miner/docs/cross-repo-evaluation.md"), "utf8");
    expect(doc).toContain("--full-execution");
    expect(doc).toContain("#7634");
    expect(doc).toContain("execution_compile_gap");
    expect(doc).toContain("execution_test_failure");
    expect(doc).toContain("execution_noop_diff");
  });
});
