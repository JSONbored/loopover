// Direct-import branch coverage for cross-repo-evaluation's defensive/edge arms (#7302). The existing
// miner-cross-repo-evaluation.test.ts drives these paths indirectly; these cases exercise each remaining
// guard directly so the TypeScript source's branch coverage is complete after the .js -> .ts migration.
import { describe, expect, it } from "vitest";
import {
  parseCrossRepoEvaluationManifest,
  evaluateRepoReadiness,
  runCrossRepoEvaluation,
  summarizeCrossRepoEvaluation,
  formatCrossRepoEvaluationReport,
} from "../../packages/loopover-miner/lib/cross-repo-evaluation.js";

// Guards that let evaluateRepoReadiness reach its buildCodingTaskSpec step without touching the real
// filesystem, stack detector, or goal-spec resolver.
const passGuards = {
  existsSync: () => true,
  detectRepoStack: () => ({ detected: true, testCommand: "npm test" }),
  resolveMinerGoalSpec: () => ({ present: true }),
  repoPath: "/fake/repo",
} as any;

describe("cross-repo-evaluation edge-branch coverage", () => {
  it("normalizeOptionalString: a whitespace-only field trims to null while a real value is kept", () => {
    const empty = parseCrossRepoEvaluationManifest(JSON.stringify({ repos: [{ repoFullName: "o/a", stackHint: "   " }] }));
    expect(empty.manifest.repos).toHaveLength(1);
    expect(empty.manifest.repos[0]?.stackHint).toBeUndefined();
    const real = parseCrossRepoEvaluationManifest(JSON.stringify({ repos: [{ repoFullName: "o/b", stackHint: "node" }] }));
    expect(real.manifest.repos[0]?.stackHint).toBe("node");
  });

  it("normalizeRepoList: undefined, null, and array repos all resolve", () => {
    expect(parseCrossRepoEvaluationManifest(JSON.stringify({})).manifest.repos).toEqual([]);
    expect(parseCrossRepoEvaluationManifest(JSON.stringify({ repos: null })).manifest.repos).toEqual([]);
    expect(parseCrossRepoEvaluationManifest(JSON.stringify({ repos: ["o/c"] })).manifest.repos.length).toBe(1);
  });

  it("evaluateRepoReadiness: reports '(invalid)' for a non-string repoFullName and echoes an invalid string one", () => {
    expect(evaluateRepoReadiness({ repoFullName: 123 as any }).repoFullName).toBe("(invalid)");
    expect(evaluateRepoReadiness({ repoFullName: "not-valid" }).repoFullName).toBe("not-valid");
  });

  it("evaluateRepoReadiness: surfaces both an Error message and a non-Error throw from buildCodingTaskSpec", () => {
    const errCase = evaluateRepoReadiness({ repoFullName: "acme/widgets" }, { ...passGuards, buildCodingTaskSpec: () => { throw new Error("kaboom"); } });
    expect(errCase.reason).toContain("kaboom");
    const strCase = evaluateRepoReadiness({ repoFullName: "acme/widgets" }, { ...passGuards, buildCodingTaskSpec: () => { throw "plain-string-throw"; } });
    expect(strCase.reason).toContain("plain-string-throw");
  });

  it("evaluateRepoReadiness: falls back to 'unknown' verdict when a not-ready spec omits one", () => {
    const noVerdict = evaluateRepoReadiness({ repoFullName: "acme/widgets" }, { ...passGuards, buildCodingTaskSpec: () => ({ ready: false }) });
    expect(noVerdict.reason).toContain("unknown");
    const withVerdict = evaluateRepoReadiness({ repoFullName: "acme/widgets" }, { ...passGuards, buildCodingTaskSpec: () => ({ ready: false, verdict: "declined" }) });
    expect(withVerdict.reason).toContain("declined");
  });

  it("evaluateRepoReadiness: a ready spec passes with or without instructions", () => {
    const noInstr = evaluateRepoReadiness({ repoFullName: "acme/widgets" }, { ...passGuards, buildCodingTaskSpec: () => ({ ready: true }) });
    expect(noInstr.passed).toBe(true);
    const withInstr = evaluateRepoReadiness({ repoFullName: "acme/widgets" }, { ...passGuards, buildCodingTaskSpec: () => ({ ready: true, instructions: "do the thing" }) });
    expect(withInstr.passed).toBe(true);
  });

  it("runCrossRepoEvaluation: defaults to an empty result set for a null parsed manifest", () => {
    expect(runCrossRepoEvaluation(null as any)).toEqual([]);
    const res = runCrossRepoEvaluation(
      { present: true, manifest: { repos: [{ repoFullName: "acme/widgets", requireTestCommand: false }] }, warnings: [] },
      { ...passGuards, buildCodingTaskSpec: () => ({ ready: true, instructions: "x" }) },
    );
    expect(res.length).toBe(1);
  });

  it("summarizeCrossRepoEvaluation: tolerates a non-array input and counts a passing array", () => {
    expect(summarizeCrossRepoEvaluation(null as any).total).toBe(0);
    expect(summarizeCrossRepoEvaluation([{ passed: true } as any]).passed).toBe(1);
  });

  it("formatCrossRepoEvaluationReport: renders majority-passed, majority-failed, and empty runs", () => {
    const passRep = formatCrossRepoEvaluationReport([{ passed: true, repoFullName: "o/a" } as any]);
    expect(passRep).toContain("(majority passed)");
    const failRep = formatCrossRepoEvaluationReport([{ passed: false, repoFullName: "o/a", failureCategory: "other", reason: "x" } as any]);
    expect(failRep).toContain("(majority failed)");
    // total === 0 exercises the false arm of `if (summary.total > 0)`.
    const emptyRep = formatCrossRepoEvaluationReport([]);
    expect(emptyRep).toContain("0/0 passed");
    expect(emptyRep).not.toContain("without loopover-specific target config");
  });
});
