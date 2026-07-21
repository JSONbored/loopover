import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  CROSS_REPO_EXECUTION_CATEGORY,
  evaluateRepoFullExecution,
  formatCrossRepoExecutionReport,
  parseCrossRepoEvaluationManifest,
  runFullCrossRepoExecution,
  summarizeCrossRepoExecution,
} from "../../packages/loopover-miner/lib/cross-repo-evaluation.js";

// NOTE: the full-execution CLI seams (parseCrossRepoEvaluationArgs / runFullCrossRepoExecutionCli in
// scripts/cross-repo-evaluation.mjs) are intentionally NOT exercised here. Its hand-written type surface
// (scripts/cross-repo-evaluation.d.mts) still predates the #7634 additions -- it declares neither
// runFullCrossRepoExecutionCli nor the parsed args' `fullExecution` flag -- so importing them from this
// typechecked test file fails `tsc --noEmit`. Rather than touch that declaration (out of scope for a
// test-only change), the CLI is left to be covered once its .d.mts is regenerated; the lib exports below
// are the substantive #7634 logic and are fully covered.

afterEach(() => {
  vi.restoreAllMocks();
});

// Guards that make evaluateRepoReadiness PASS so full-execution proceeds to the code/build/test loop.
const passGuards = {
  existsSync: () => true,
  detectRepoStack: () => ({ detected: true, testCommand: "npm test", buildCommand: "npm run build" }),
  resolveMinerGoalSpec: () => ({ present: true }),
  repoPath: "/fake/repo",
  buildCodingTaskSpec: () => ({ ready: true, instructions: "make a change" }),
} as const;

// Injected as EvaluateRepoFullExecutionOptions; the crafted fakes are intentionally loose, so cast per call.
const opts = (overrides: Record<string, unknown> = {}) => ({ ...passGuards, ...overrides }) as any;

const entry = { repoFullName: "acme/repo", requireTestCommand: false } as const;

describe("cross-repo full-execution harness (#7634)", () => {
  describe("evaluateRepoFullExecution", () => {
    it("reports plan_not_formed when readiness fails for a non-clone reason", async () => {
      // Stack detection fails while the clone exists -> no plan could be formed (not a clone gap).
      const result = await evaluateRepoFullExecution(
        entry,
        opts({ detectRepoStack: () => ({ detected: false, reason: "unrecognized stack" }) }),
      );
      expect(result.executionCategory).toBe(CROSS_REPO_EXECUTION_CATEGORY.PLAN_NOT_FORMED);
      expect(result.passed).toBe(false);
      expect(result.readinessPassed).toBe(false);
    });

    it("reports clone_setup when the readiness clone gap fires", async () => {
      const result = await evaluateRepoFullExecution(entry, opts({ existsSync: () => false }));
      expect(result.executionCategory).toBe(CROSS_REPO_EXECUTION_CATEGORY.CLONE_SETUP);
      expect(result.passed).toBe(false);
      expect(result.readinessPassed).toBe(false);
    });

    it("reports other when readiness passes but no test command was inferred", async () => {
      const result = await evaluateRepoFullExecution(
        entry,
        opts({ detectRepoStack: () => ({ detected: true, testCommand: null, buildCommand: null }) }),
      );
      expect(result.executionCategory).toBe(CROSS_REPO_EXECUTION_CATEGORY.OTHER);
      expect(result.reason).toContain("test command");
      expect(result.readinessPassed).toBe(true);
    });

    it("reports other when no coding-agent runner seam is provided", async () => {
      const result = await evaluateRepoFullExecution(entry, opts());
      expect(result.executionCategory).toBe(CROSS_REPO_EXECUTION_CATEGORY.OTHER);
      expect(result.reason).toContain("coding-agent runner");
      expect(result.readinessPassed).toBe(true);
    });

    it("reports other and surfaces the error message when the coding agent throws", async () => {
      const result = await evaluateRepoFullExecution(
        entry,
        opts({
          runAgentAttempt: () => {
            throw new Error("boom");
          },
        }),
      );
      expect(result.executionCategory).toBe(CROSS_REPO_EXECUTION_CATEGORY.OTHER);
      expect(result.reason).toContain("boom");
      expect(result.readinessPassed).toBe(true);
    });

    it("reports code_build_failed when the edited clone does not build", async () => {
      const result = await evaluateRepoFullExecution(
        entry,
        opts({
          runAgentAttempt: async () => ({ diff: "x" }),
          buildRepo: async () => ({ ok: false, detail: "tsc error" }),
        }),
      );
      expect(result.executionCategory).toBe(CROSS_REPO_EXECUTION_CATEGORY.CODE_BUILD_FAILED);
      expect(result.built).toBe(false);
      expect(result.diffPresent).toBe(true);
      expect(result.reason).toContain("tsc error");
    });

    it("reports other when a diff builds but no test runner seam is provided", async () => {
      const result = await evaluateRepoFullExecution(
        entry,
        opts({
          runAgentAttempt: async () => ({ diff: "x" }),
          buildRepo: async () => ({ ok: true }),
          // no runRepoTests
        }),
      );
      expect(result.executionCategory).toBe(CROSS_REPO_EXECUTION_CATEGORY.OTHER);
      expect(result.reason).toContain("test runner");
      expect(result.built).toBe(true);
      expect(result.diffPresent).toBe(true);
    });

    it("reports tests_failed when the repo's own tests fail", async () => {
      const result = await evaluateRepoFullExecution(
        entry,
        opts({
          runAgentAttempt: async () => ({ diff: "x" }),
          buildRepo: async () => ({ ok: true }),
          runRepoTests: async () => ({ ok: false, detail: "1 failing" }),
        }),
      );
      expect(result.executionCategory).toBe(CROSS_REPO_EXECUTION_CATEGORY.TESTS_FAILED);
      expect(result.testsPassed).toBe(false);
      expect(result.diffPresent).toBe(true);
      expect(result.reason).toContain("1 failing");
    });

    it("reports no_op_diff when tests pass but the agent produced an empty diff", async () => {
      const result = await evaluateRepoFullExecution(
        entry,
        opts({
          runAgentAttempt: async () => ({ diff: "   " }),
          buildRepo: async () => ({ ok: true }),
          runRepoTests: async () => ({ ok: true }),
        }),
      );
      expect(result.executionCategory).toBe(CROSS_REPO_EXECUTION_CATEGORY.NO_OP_DIFF);
      expect(result.passed).toBe(false);
      expect(result.diffPresent).toBe(false);
      expect(result.testsPassed).toBe(true);
    });

    it("passes when a real diff builds and the repo's tests pass", async () => {
      const result = await evaluateRepoFullExecution(
        entry,
        opts({
          runAgentAttempt: async () => ({ diff: "real change" }),
          buildRepo: async () => ({ ok: true }),
          runRepoTests: async () => ({ ok: true }),
        }),
      );
      expect(result.passed).toBe(true);
      expect(result.executionCategory).toBeNull();
      expect(result.diffPresent).toBe(true);
      expect(result.built).toBe(true);
      expect(result.testsPassed).toBe(true);
    });

    it("skips the build step cleanly when the stack exposes no build command", async () => {
      let buildCalled = false;
      const result = await evaluateRepoFullExecution(
        entry,
        opts({
          detectRepoStack: () => ({ detected: true, testCommand: "npm test", buildCommand: null }),
          runAgentAttempt: async () => ({ diff: "real change" }),
          buildRepo: async () => {
            buildCalled = true;
            return { ok: false, detail: "should not run" };
          },
          runRepoTests: async () => ({ ok: true }),
        }),
      );
      expect(buildCalled).toBe(false);
      expect(result.passed).toBe(true);
      expect(result.executionCategory).toBeNull();
    });
  });

  describe("runFullCrossRepoExecution", () => {
    it("applies the repoFilter and runs the loop only for the selected repo", async () => {
      const parsed = parseCrossRepoEvaluationManifest(JSON.stringify({ repos: ["acme/one", "acme/two"] }));
      const results = await runFullCrossRepoExecution(
        parsed,
        opts({
          repoFilter: "acme/two",
          runAgentAttempt: async () => ({ diff: "real change" }),
          buildRepo: async () => ({ ok: true }),
          runRepoTests: async () => ({ ok: true }),
        }),
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.repoFullName).toBe("acme/two");
      expect(results[0]?.passed).toBe(true);
    });
  });

  describe("summarizeCrossRepoExecution", () => {
    it("computes totals, majority, and per-category failure counts", () => {
      const summary = summarizeCrossRepoExecution([
        { passed: true },
        { passed: false, executionCategory: CROSS_REPO_EXECUTION_CATEGORY.TESTS_FAILED },
        { passed: false, executionCategory: CROSS_REPO_EXECUTION_CATEGORY.TESTS_FAILED },
        { passed: false, executionCategory: CROSS_REPO_EXECUTION_CATEGORY.NO_OP_DIFF },
      ] as any);
      expect(summary.total).toBe(4);
      expect(summary.passed).toBe(1);
      expect(summary.failed).toBe(3);
      expect(summary.majorityPassed).toBe(false);
      expect(summary.failuresByCategory[CROSS_REPO_EXECUTION_CATEGORY.TESTS_FAILED]).toBe(2);
      expect(summary.failuresByCategory[CROSS_REPO_EXECUTION_CATEGORY.NO_OP_DIFF]).toBe(1);
    });

    it("reports a strict majority and buckets a null category as other", () => {
      const summary = summarizeCrossRepoExecution([
        { passed: true },
        { passed: true },
        { passed: false, executionCategory: null },
      ] as any);
      expect(summary.majorityPassed).toBe(true);
      expect(summary.failuresByCategory[CROSS_REPO_EXECUTION_CATEGORY.OTHER]).toBe(1);
    });

    it("treats a non-array input as an empty run", () => {
      const summary = summarizeCrossRepoExecution(null as any);
      expect(summary.total).toBe(0);
      expect(summary.majorityPassed).toBe(false);
    });
  });

  describe("formatCrossRepoExecutionReport", () => {
    it("renders PASS/FAIL lines, a majority-failed summary, and the category breakdown", () => {
      const results = [
        { repoFullName: "acme/ok", passed: true, executionCategory: null, reason: null },
        {
          repoFullName: "acme/bad",
          passed: false,
          executionCategory: CROSS_REPO_EXECUTION_CATEGORY.TESTS_FAILED,
          reason: "Tests failed: x",
        },
      ] as any;
      const report = formatCrossRepoExecutionReport(results);
      expect(report).toContain("loopover-miner cross-repo full execution");
      expect(report).toContain("PASS acme/ok");
      expect(report).toContain("FAIL acme/bad [tests_failed] Tests failed: x");
      expect(report).toContain("summary: 1/2 passed (majority failed)");
      expect(report).toContain("failures by category:");
      expect(report).toContain("- tests_failed: 1");
    });

    it("renders a majority-passed summary and omits the category block when there are no failures", () => {
      const results = [
        { repoFullName: "acme/a", passed: true, executionCategory: null, reason: null },
        { repoFullName: "acme/b", passed: true, executionCategory: null, reason: null },
      ] as any;
      const report = formatCrossRepoExecutionReport(results);
      expect(report).toContain("summary: 2/2 passed (majority passed)");
      expect(report).not.toContain("failures by category:");
    });
  });
});
