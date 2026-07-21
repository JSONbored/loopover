import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  CROSS_REPO_EXECUTION_FAILURE_CATEGORY,
  CROSS_REPO_FAILURE_CATEGORY,
  DEFAULT_CROSS_REPO_EXECUTION_COMMAND_TIMEOUT_MS,
  DEFAULT_CROSS_REPO_EXECUTION_MAX_TURNS,
  DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH,
  MAX_CROSS_REPO_MANIFEST_BYTES,
  createDefaultCrossRepoExecutionRunCommand,
  defaultPrepareExecutionWorkspace,
  evaluateRepoExecution,
  formatCrossRepoEvaluationReport,
  evaluateRepoReadiness,
  normalizeCrossRepoFullName,
  parseCrossRepoEvaluationManifest,
  runCrossRepoEvaluation,
  runCrossRepoFullExecution,
  scanPositiveLoopoverAssumptions,
  summarizeCrossRepoEvaluation,
} from "../../packages/loopover-miner/lib/cross-repo-evaluation.js";
import type {
  CrossRepoExecutionCommandResult,
  CrossRepoExecutionDriver,
} from "../../packages/loopover-miner/lib/cross-repo-evaluation.js";
import type { RepoStackResult } from "../../packages/loopover-miner/lib/stack-detection.js";
import {
  loadCrossRepoEvaluationManifest,
  parseCrossRepoEvaluationArgs,
  resolveDefaultManifestPath,
  runCrossRepoEvaluationCli,
  runCrossRepoFullExecutionCli,
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
      expect(parseCrossRepoEvaluationArgs(["--full-execution"])).toMatchObject({ fullExecution: true });
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
    /** A minimal Node fixture the real detector/spec-builder both handle. */
    function nodeFixture(scripts: Record<string, string> = { test: "node --test" }) {
      return tempRepo({ "package.json": pkg({ name: "exec-fixture", version: "0.0.0", scripts }) });
    }

    function entryFor(repoPath: string, name = "acme/exec") {
      return { repoFullName: name, fixturePath: repoPath, requireTestCommand: false };
    }

    /** Recording driver — returns `result` (or the queue of results) and captures every task it was handed. */
    function recordingDriver(result: unknown = { ok: true, changedFiles: ["src/x.js"], summary: "done" }) {
      const tasks: Array<Record<string, unknown>> = [];
      const driver = {
        run: async (task: Record<string, unknown>) => {
          tasks.push(task);
          return result;
        },
      } as unknown as CrossRepoExecutionDriver;
      return { tasks, driver };
    }

    /** Sequential fake runCommand — shifts scripted results, recording each (command, options) call. */
    function scriptedRunCommand(script: Array<Partial<CrossRepoExecutionCommandResult>>) {
      const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
      const runCommand = async (command: string, options: { cwd: string; timeoutMs: number }) => {
        calls.push({ command, cwd: options.cwd, timeoutMs: options.timeoutMs });
        return { code: 0, stdout: "", stderr: "", timedOut: false, ...script.shift() };
      };
      return { calls, runCommand };
    }

    /** Reuse the fixture itself as the "scratch" tree so real detect/spec impls work inside it. */
    function inPlaceWorkspace(cleanup: () => void = () => {}) {
      return (repoPath: string) => ({ path: repoPath, cleanup });
    }

    it("passes readiness failures through with execution:null and never touches the agent", async () => {
      const { tasks, driver } = recordingDriver();
      const result = await evaluateRepoExecution({ repoFullName: "not-a-repo", requireTestCommand: false }, { driver });
      expect(result.passed).toBe(false);
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.OTHER);
      expect(result.execution).toBeNull();
      expect(tasks).toHaveLength(0);
    });

    it("fails clone_setup when the scratch workspace cannot be prepared (Error and non-Error throws)", async () => {
      // Fresh fixture per call: the real spec builder writes ACCEPTANCE_CRITERIA.md (O_EXCL) during readiness,
      // so re-evaluating the same tree would fail readiness instead of reaching the phase under test.
      const errorRepo = nodeFixture();
      const viaError = await evaluateRepoExecution(entryFor(errorRepo), {
        repoPath: errorRepo,
        existsSync: () => true,
        driver: recordingDriver().driver,
        prepareExecutionWorkspace: () => {
          throw new Error("no space left");
        },
      });
      expect(viaError.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP);
      expect(viaError.reason).toContain("scratch execution workspace");
      expect(viaError.reason).toContain("no space left");
      expect(viaError.execution).toBeNull();

      const stringRepo = nodeFixture();
      const viaString = await evaluateRepoExecution(entryFor(stringRepo), {
        repoPath: stringRepo,
        existsSync: () => true,
        driver: recordingDriver().driver,
        prepareExecutionWorkspace: () => {
          throw "disk-full-string";
        },
      });
      expect(viaString.reason).toContain("disk-full-string");
    });

    it("always discards the workspace, even when cleanup itself throws, without masking the outcome", async () => {
      const repoPath = nodeFixture();
      const cleanup = vi.fn(() => {
        throw new Error("cleanup-fail");
      });
      const { runCommand } = scriptedRunCommand([{ code: 0 }]);
      const result = await evaluateRepoExecution(entryFor(repoPath), {
        repoPath,
        existsSync: () => true,
        prepareExecutionWorkspace: inPlaceWorkspace(cleanup),
        driver: recordingDriver().driver,
        runCommand,
      });
      expect(result.passed).toBe(true);
      expect(result.execution).toEqual({ attempted: true, changedFileCount: 1, buildRan: false, testRan: true });
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("categorizes a spec failure inside the scratch workspace as other / execution_gap with verdict fallback", async () => {
      const repoPath = nodeFixture();
      const optionsFor = (secondCall: () => unknown) => {
        let calls = 0;
        return {
          repoPath,
          existsSync: () => true,
          prepareExecutionWorkspace: inPlaceWorkspace(),
          driver: recordingDriver().driver,
          buildCodingTaskSpec: () => {
            calls += 1;
            if (calls === 1) return { ready: true, instructions: "fine" };
            return secondCall() as never;
          },
        };
      };
      const thrown = await evaluateRepoExecution(
        entryFor(repoPath),
        optionsFor(() => {
          throw new Error("spec-workspace-boom");
        }),
      );
      expect(thrown.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.OTHER);
      expect(thrown.reason).toContain("scratch workspace");
      expect(thrown.reason).toContain("spec-workspace-boom");
      expect(thrown.execution).toBeNull();

      const nullish = await evaluateRepoExecution(
        entryFor(repoPath),
        optionsFor(() => null),
      );
      expect(nullish.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION);
      expect(nullish.reason).toContain("unknown");

      const unready = await evaluateRepoExecution(
        entryFor(repoPath),
        optionsFor(() => ({ ready: false, verdict: "held" })),
      );
      expect(unready.reason).toContain("held");
    });

    it("fails agent_run_failed via the default driver construction when no provider is configured", async () => {
      const injectedEnvRepo = nodeFixture();
      const viaInjectedEnv = await evaluateRepoExecution(entryFor(injectedEnvRepo), {
        repoPath: injectedEnvRepo,
        existsSync: () => true,
        prepareExecutionWorkspace: inPlaceWorkspace(),
        env: {} as NodeJS.ProcessEnv,
      });
      expect(viaInjectedEnv.failureCategory).toBe(CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN);
      expect(viaInjectedEnv.reason).toContain("No runnable coding-agent driver");
      expect(viaInjectedEnv.reason).toContain("unconfigured_coding_agent_driver");
      expect(viaInjectedEnv.execution).toEqual({
        attempted: false,
        changedFileCount: null,
        buildRan: false,
        testRan: false,
      });

      // Same failure through the `?? process.env` default — pinned empty so the test never launches a real agent.
      const processEnvRepo = nodeFixture();
      vi.stubEnv("MINER_CODING_AGENT_PROVIDER", "");
      try {
        const viaProcessEnv = await evaluateRepoExecution(entryFor(processEnvRepo), {
          repoPath: processEnvRepo,
          existsSync: () => true,
          prepareExecutionWorkspace: inPlaceWorkspace(),
        });
        expect(viaProcessEnv.failureCategory).toBe(CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN);
        expect(viaProcessEnv.reason).toContain("unconfigured_coding_agent_driver");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    /** Fresh fixture + options per driver scenario — see the clone_setup test's O_EXCL note. */
    async function evaluateWithDriver(driver: CrossRepoExecutionDriver) {
      const repoPath = nodeFixture();
      return evaluateRepoExecution(entryFor(repoPath), {
        repoPath,
        existsSync: () => true,
        prepareExecutionWorkspace: inPlaceWorkspace(),
        driver,
      });
    }

    it("fails agent_run_failed when the driver throws, with detail fallbacks when it reports badly", async () => {
      const threw = await evaluateWithDriver({
        run: async () => {
          throw new Error("agent exploded");
        },
      } as never);
      expect(threw.failureCategory).toBe(CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN);
      expect(threw.reason).toContain("Coding agent run threw");
      expect(threw.reason).toContain("agent exploded");
      expect(threw.execution).toEqual({ attempted: true, changedFileCount: null, buildRan: false, testRan: false });

      const nullResult = await evaluateWithDriver(recordingDriver(null).driver);
      expect(nullResult.reason).toContain("no failure detail reported");

      const withError = await evaluateWithDriver(
        recordingDriver({ ok: false, changedFiles: [], summary: "s", error: "exploded mid-run" }).driver,
      );
      expect(withError.reason).toContain("exploded mid-run");

      const withSummaryOnly = await evaluateWithDriver(
        recordingDriver({ ok: false, changedFiles: [], summary: "gave up early" }).driver,
      );
      expect(withSummaryOnly.reason).toContain("gave up early");
    });

    it("fails noop_diff when the agent succeeds without changing any file (empty or missing changedFiles)", async () => {
      const emptyDiff = await evaluateWithDriver(
        recordingDriver({ ok: true, changedFiles: [], summary: "did nothing" }).driver,
      );
      expect(emptyDiff.failureCategory).toBe(CROSS_REPO_EXECUTION_FAILURE_CATEGORY.NOOP_DIFF);
      expect(emptyDiff.execution).toEqual({ attempted: true, changedFileCount: 0, buildRan: false, testRan: false });

      const missingDiff = await evaluateWithDriver(recordingDriver({ ok: true, summary: "malformed result" }).driver);
      expect(missingDiff.failureCategory).toBe(CROSS_REPO_EXECUTION_FAILURE_CATEGORY.NOOP_DIFF);
    });

    /** Fresh build+test fixture per command scenario — see the clone_setup test's O_EXCL note. */
    async function evaluateWithRunCommand(
      runCommand: (command: string, options: { cwd: string; timeoutMs: number }) => Promise<CrossRepoExecutionCommandResult>,
      scripts: Record<string, string> = { test: "node --test" },
    ) {
      const repoPath = nodeFixture(scripts);
      return evaluateRepoExecution(entryFor(repoPath), {
        repoPath,
        existsSync: () => true,
        prepareExecutionWorkspace: inPlaceWorkspace(),
        driver: recordingDriver().driver,
        runCommand,
      });
    }

    it("runs the inferred build command first and fails build_failed on a non-zero exit or a timeout", async () => {
      const buildScripts = { build: "node -e ok", test: "node --test" };
      const exited = scriptedRunCommand([{ code: 2 }]);
      const buildFailed = await evaluateWithRunCommand(exited.runCommand, buildScripts);
      expect(buildFailed.failureCategory).toBe(CROSS_REPO_EXECUTION_FAILURE_CATEGORY.BUILD);
      expect(buildFailed.reason).toContain("failed (exit 2)");
      expect(buildFailed.reason).toContain("npm run build");
      expect(buildFailed.execution).toEqual({ attempted: true, changedFileCount: 1, buildRan: true, testRan: false });
      expect(exited.calls[0]?.command).toBe("npm run build");

      const timedOut = scriptedRunCommand([{ code: null, timedOut: true }]);
      const buildTimeout = await evaluateWithRunCommand(timedOut.runCommand, buildScripts);
      expect(buildTimeout.failureCategory).toBe(CROSS_REPO_EXECUTION_FAILURE_CATEGORY.BUILD);
      expect(buildTimeout.reason).toContain("timed out");
    });

    it("passes end-to-end with build + test green, using the default command timeout", async () => {
      const repoPath = nodeFixture({ build: "node -e ok", test: "node --test" });
      const { calls, runCommand } = scriptedRunCommand([{ code: 0 }, { code: 0 }]);
      const result = await evaluateRepoExecution(entryFor(repoPath), {
        repoPath,
        existsSync: () => true,
        prepareExecutionWorkspace: inPlaceWorkspace(),
        driver: recordingDriver().driver,
        runCommand,
      });
      expect(result.passed).toBe(true);
      expect(result.execution).toEqual({ attempted: true, changedFileCount: 1, buildRan: true, testRan: true });
      expect(calls.map((call) => call.command)).toEqual(["npm run build", "npm test"]);
      expect(calls[0]?.timeoutMs).toBe(DEFAULT_CROSS_REPO_EXECUTION_COMMAND_TIMEOUT_MS);
      expect(calls[0]?.cwd).toBe(repoPath);
    });

    it("honors options.commandTimeoutMs and options.maxTurns", async () => {
      const repoPath = nodeFixture();
      const { calls, runCommand } = scriptedRunCommand([{ code: 0 }]);
      const { tasks, driver } = recordingDriver();
      const result = await evaluateRepoExecution(entryFor(repoPath), {
        repoPath,
        existsSync: () => true,
        prepareExecutionWorkspace: inPlaceWorkspace(),
        driver,
        runCommand,
        commandTimeoutMs: 12_345,
        maxTurns: 7,
      });
      expect(result.passed).toBe(true);
      expect(calls[0]?.timeoutMs).toBe(12_345);
      expect(tasks[0]?.maxTurns).toBe(7);
    });

    it("fails execution_gap when no test command was inferred to validate the diff", async () => {
      const repoPath = nodeFixture({});
      const result = await evaluateRepoExecution(entryFor(repoPath), {
        repoPath,
        existsSync: () => true,
        prepareExecutionWorkspace: inPlaceWorkspace(),
        driver: recordingDriver().driver,
        buildCodingTaskSpec: () => ({ ready: true, instructions: "fine" }),
      });
      expect(result.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.EXECUTION);
      expect(result.reason).toContain("cannot be validated");
      expect(result.execution).toEqual({ attempted: true, changedFileCount: 1, buildRan: false, testRan: false });
    });

    it("fails test_failed when the repo's own test suite exits non-zero or times out", async () => {
      const exited = await evaluateWithRunCommand(scriptedRunCommand([{ code: 3 }]).runCommand);
      expect(exited.failureCategory).toBe(CROSS_REPO_EXECUTION_FAILURE_CATEGORY.TEST);
      expect(exited.reason).toContain("failed (exit 3)");
      expect(exited.reason).toContain("npm test");
      expect(exited.execution).toEqual({ attempted: true, changedFileCount: 1, buildRan: false, testRan: true });

      const timedOut = await evaluateWithRunCommand(scriptedRunCommand([{ code: null, timedOut: true }]).runCommand);
      expect(timedOut.failureCategory).toBe(CROSS_REPO_EXECUTION_FAILURE_CATEGORY.TEST);
      expect(timedOut.reason).toContain("timed out");
    });

    it("hands the agent a task rooted in a REAL discardable scratch copy, then removes it (dry-run posture)", async () => {
      const repoPath = nodeFixture();
      const { tasks, driver } = recordingDriver();
      const { runCommand } = scriptedRunCommand([{ code: 0 }]);
      const result = await evaluateRepoExecution(entryFor(repoPath), {
        repoPath,
        existsSync,
        driver,
        runCommand,
      });
      expect(result.passed).toBe(true);
      const task = tasks[0]!;
      // The agent worked in the scratch copy, not the benchmark clone…
      expect(task.workingDirectory).not.toBe(repoPath);
      expect(String(task.workingDirectory)).toContain("loopover-cross-repo-exec-");
      // …the acceptance-criteria document was written INSIDE that copy…
      expect(String(task.acceptanceCriteriaPath).startsWith(String(task.workingDirectory))).toBe(true);
      expect(String(task.instructions)).not.toBe("");
      expect(task.maxTurns).toBe(DEFAULT_CROSS_REPO_EXECUTION_MAX_TURNS);
      // …and the whole scratch tree is discarded afterward while the clone survives untouched.
      expect(existsSync(String(task.workingDirectory))).toBe(false);
      expect(existsSync(join(repoPath, "package.json"))).toBe(true);
    });

    it("falls back to empty instructions and a workspace-local acceptance path when a spec omits them", async () => {
      const repoPath = nodeFixture();
      let calls = 0;
      const { tasks, driver } = recordingDriver();
      const result = await evaluateRepoExecution(entryFor(repoPath), {
        repoPath,
        existsSync: () => true,
        prepareExecutionWorkspace: inPlaceWorkspace(),
        driver,
        runCommand: scriptedRunCommand([{ code: 0 }]).runCommand,
        buildCodingTaskSpec: () => {
          calls += 1;
          return calls === 1 ? { ready: true, instructions: "readiness pass" } : { ready: true };
        },
      });
      expect(result.passed).toBe(true);
      expect(tasks[0]?.instructions).toBe("");
      expect(String(tasks[0]?.acceptanceCriteriaPath).endsWith("ACCEPTANCE_CRITERIA.md")).toBe(true);
    });

    it("runCrossRepoFullExecution mirrors the readiness runner's manifest and filter handling", async () => {
      expect(await runCrossRepoFullExecution(undefined as never)).toEqual([]);

      const parsed = parseCrossRepoEvaluationManifest(JSON.stringify({ repos: ["acme/a", "acme/b"] }));
      const all = await runCrossRepoFullExecution(parsed, { existsSync: () => false });
      expect(all).toHaveLength(2);
      expect(all[0]?.failureCategory).toBe(CROSS_REPO_FAILURE_CATEGORY.CLONE_SETUP);
      expect(all[0]?.execution).toBeNull();

      const filtered = await runCrossRepoFullExecution(parsed, { repoFilter: "acme/b", existsSync: () => false });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.repoFullName).toBe("acme/b");
    });

    it("defaultPrepareExecutionWorkspace copies the repo and cleanup removes the whole scratch tree", () => {
      const repoPath = nodeFixture();
      const workspace = defaultPrepareExecutionWorkspace(repoPath);
      expect(workspace.path).not.toBe(repoPath);
      expect(existsSync(join(workspace.path, "package.json"))).toBe(true);
      workspace.cleanup();
      expect(existsSync(workspace.path)).toBe(false);
    });

    it("createDefaultCrossRepoExecutionRunCommand reports exit codes, output, timeouts, and spawn errors", async () => {
      // The runner tokenizes on whitespace and execs directly (no shell), so every command here is a plain
      // `tool arg...` form — the only shape detectRepoStack ever emits.
      const runCommand = createDefaultCrossRepoExecutionRunCommand();
      const cwd = tempRepo();

      const ok = await runCommand("node -p 40+2", { cwd, timeoutMs: 30_000 });
      expect(ok).toMatchObject({ code: 0, timedOut: false });
      expect(ok.stdout).toContain("42");

      const failing = await runCommand("node --definitely-not-a-real-flag", { cwd, timeoutMs: 30_000 });
      expect(failing.code).not.toBe(0);
      expect(failing.code).not.toBeNull();
      expect(failing.stderr).toContain("bad option");

      const hung = await runCommand("node -e setTimeout(function(){},10000)", { cwd, timeoutMs: 300 });
      expect(hung.timedOut).toBe(true);
      expect(hung.code).toBeNull();

      const spawnError = await runCommand("node -v", { cwd: join(cwd, "definitely-missing-subdir"), timeoutMs: 5_000 });
      expect(spawnError.code).toBeNull();
      expect(spawnError.timedOut).toBe(false);
      expect(spawnError.stderr).not.toBe("");

      const empty = await runCommand("   ", { cwd, timeoutMs: 5_000 });
      expect(empty).toEqual({ stdout: "", stderr: "empty_command", code: null, timedOut: false });
    });

    it("runCrossRepoFullExecutionCli reports the new categories through the existing summary + report format", async () => {
      const repoPath = nodeFixture();
      const manifestDir = tempRepo();
      writeFileSync(
        join(manifestDir, "manifest.json"),
        JSON.stringify({ repos: [{ repoFullName: "acme/exec-cli", fixturePath: repoPath }] }),
        "utf8",
      );
      // Pin the provider empty so the CLI's default driver path fails closed instead of launching a real agent.
      vi.stubEnv("MINER_CODING_AGENT_PROVIDER", "");
      try {
        const { results, summary } = await runCrossRepoFullExecutionCli({
          manifestPath: join(manifestDir, "manifest.json"),
        });
        expect(results[0]?.failureCategory).toBe(CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN);
        expect(summary.failuresByCategory[CROSS_REPO_EXECUTION_FAILURE_CATEGORY.AGENT_RUN]).toBe(1);
        expect(formatCrossRepoEvaluationReport(results, summary)).toContain("- agent_run_failed: 1");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("documents the harness in packages/loopover-miner/docs/cross-repo-evaluation.md", () => {
    const doc = readFileSync(join(process.cwd(), "packages/loopover-miner/docs/cross-repo-evaluation.md"), "utf8");
    expect(doc).toContain("#4788");
    expect(doc).toContain("stack_detection_gap");
    expect(doc).toContain("cross-repo-evaluation.mjs");
    expect(doc).toContain("benchmarks/cross-repo/manifest.json");
    // #7634: the full-execution mode and its execution-specific failure categories are documented too.
    expect(doc).toContain("--full-execution");
    expect(doc).toContain("noop_diff");
    expect(doc).toContain("dry-run");
  });
});
