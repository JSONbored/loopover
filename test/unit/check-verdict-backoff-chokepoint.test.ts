import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { enclosingFunction, findViolations, occurrences, topLevelFunctionRange } from "../../scripts/check-verdict-backoff-chokepoint";

// #10227: the checker is the thing standing between "the choke point holds" and "the choke point held once,
// in the PR that introduced it". Each case below is a real way the structure can rot, written as the mutation
// that produces it -- so the checker is proven to FAIL on drift, not just to pass on the tree as it stands.

/** A miniature of processors.ts's shape: the two entry points, the choke point, and the derivation markers. */
const COMPLIANT = `
export async function reReviewStoredPullRequest(env: Env) {
  const gate = await maybePublishPrPublicSurface(env, 1);
  await maybeRunAgentMaintenance(env, { gate });
}

async function handlePullRequestWebhookEvent(env: Env) {
  const gate = await maybePublishPrPublicSurface(env, 2);
  await maybeRunAgentMaintenance(env, { gate });
}

async function maybePublishPrPublicSurface(env: Env, n: number) {
  await runVisualCaptureObligation(env, {});
  if (
    await stableVerdictBackoffEngaged(env, {
      repoFullName,
    })
  ) {
    return undefined;
  }
  const pendingGateResult = await createOrUpdatePendingGateCheckRun(env, n);
  gateEvaluation = await withReviewPipelineSpan("x", {}, () => evaluate());
  return gateEvaluation;
}

async function unrelatedHelper(env: Env) {
  return env;
}
`;

describe("check-verdict-backoff-chokepoint (#10227)", () => {
  it("passes on a compliant shape", () => {
    expect(findViolations(COMPLIANT)).toEqual([]);
  });

  it("passes on the real src/queue/processors.ts", () => {
    expect(findViolations(readFileSync("src/queue/processors.ts", "utf8"))).toEqual([]);
  });

  it("fails when a SECOND call site appears -- that is a per-entry-point rule again", () => {
    const drifted = COMPLIANT.replace(
      "async function handlePullRequestWebhookEvent(env: Env) {\n",
      "async function handlePullRequestWebhookEvent(env: Env) {\n  if (await stableVerdictBackoffEngaged(env, {\n    repoFullName,\n  })) return;\n",
    );
    expect(findViolations(drifted).map((violation) => violation.rule)).toContain("one call site");
  });

  it("fails when the guard is deleted outright", () => {
    const drifted = COMPLIANT.replace(
      "  if (\n    await stableVerdictBackoffEngaged(env, {\n      repoFullName,\n    })\n  ) {\n    return undefined;\n  }\n",
      "",
    );
    expect(findViolations(drifted)).toEqual([{ rule: "one call site", detail: "stableVerdictBackoffEngaged is called 0 time(s); the choke point is exactly one." }]);
  });

  it("fails when the guard drifts BELOW the derivation it is meant to skip", () => {
    // The quiet rot: still one call site, still inside the choke point, still "backs off" by every behavioural
    // assertion -- and saves nothing, because the gate check-run and the evaluation already ran.
    const drifted = COMPLIANT.replace(
      "  const pendingGateResult = await createOrUpdatePendingGateCheckRun(env, n);\n  gateEvaluation = await withReviewPipelineSpan(\"x\", {}, () => evaluate());\n",
      "",
    ).replace(
      "    return undefined;\n  }\n",
      "    return undefined;\n  }\n  const pendingGateResult = await createOrUpdatePendingGateCheckRun(env, n);\n  gateEvaluation = await withReviewPipelineSpan(\"x\", {}, () => evaluate());\n",
    );
    expect(findViolations(drifted), "moving the derivation below the guard is the COMPLIANT direction").toEqual([]);

    const rotted = COMPLIANT.replace(
      "  await runVisualCaptureObligation(env, {});\n",
      "  await runVisualCaptureObligation(env, {});\n  const pendingGateResult = await createOrUpdatePendingGateCheckRun(env, n);\n",
    );
    expect(findViolations(rotted).map((violation) => violation.rule)).toContain("guard precedes the derivation");
  });

  it("fails when a NEW publish-and-maintain entry point bypasses the choke point", () => {
    // The case the issue asked for: a fresh caller derives a verdict its own way and runs the maintenance pass
    // on it. Nothing else in the tree notices, and the backoff quietly stops covering the new path.
    const drifted = `${COMPLIANT}
async function someNewSweep(env: Env) {
  const gate = await deriveTheVerdictSomeOtherWay(env);
  await maybeRunAgentMaintenance(env, { gate });
}
`;
    const violations = findViolations(drifted);
    expect(violations.map((violation) => violation.rule)).toContain("entry points route through the choke point");
    expect(violations.map((violation) => violation.detail).join()).toContain("someNewSweep");
  });

  it("fails when the choke-point function is renamed out from under the checker", () => {
    const drifted = COMPLIANT.replaceAll("maybePublishPrPublicSurface", "publishPrSurface");
    expect(findViolations(drifted).map((violation) => violation.rule)).toContain("choke point exists");
  });

  it("reports the guard as outside the choke point when it moves to a caller", () => {
    const drifted = COMPLIANT.replace(
      "  if (\n    await stableVerdictBackoffEngaged(env, {\n      repoFullName,\n    })\n  ) {\n    return undefined;\n  }\n",
      "",
    ).replace(
      "export async function reReviewStoredPullRequest(env: Env) {\n",
      "export async function reReviewStoredPullRequest(env: Env) {\n  if (await stableVerdictBackoffEngaged(env, {\n    repoFullName,\n  })) return;\n",
    );
    expect(findViolations(drifted).map((violation) => violation.rule)).toContain("guard is inside the choke point");
  });

  describe("helpers", () => {
    it("occurrences finds every offset, and none when absent", () => {
      expect(occurrences("abcabc", "bc")).toEqual([1, 4]);
      expect(occurrences("abc", "zz")).toEqual([]);
    });

    it("topLevelFunctionRange bounds a function, and returns null for an unknown name", () => {
      const range = topLevelFunctionRange(COMPLIANT, "maybePublishPrPublicSurface");
      expect(range).not.toBeNull();
      expect(COMPLIANT.slice(range!.start, range!.end)).toContain("stableVerdictBackoffEngaged");
      expect(COMPLIANT.slice(range!.start, range!.end)).not.toContain("unrelatedHelper");
      expect(topLevelFunctionRange(COMPLIANT, "noSuchFunction")).toBeNull();
    });

    it("topLevelFunctionRange runs to end-of-file for the last function", () => {
      const source = "\nasync function only(env: Env) {\n  return env;\n}\n";
      expect(topLevelFunctionRange(source, "only")?.end).toBe(source.length);
    });

    it("enclosingFunction names the caller, and returns null before any declaration", () => {
      const offset = COMPLIANT.indexOf("maybeRunAgentMaintenance(env, {");
      expect(enclosingFunction(COMPLIANT, offset)?.name).toBe("reReviewStoredPullRequest");
      expect(enclosingFunction(COMPLIANT, 1)).toBeNull();
    });

    it("a maintenance call outside any function is skipped rather than misattributed", () => {
      expect(findViolations("await maybeRunAgentMaintenance(env, {\n})\n")).toEqual([
        { rule: "one call site", detail: "stableVerdictBackoffEngaged is called 0 time(s); the choke point is exactly one." },
      ]);
    });
  });
});
