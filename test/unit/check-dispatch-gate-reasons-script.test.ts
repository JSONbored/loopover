import { describe, expect, it } from "vitest";
import { findDispatchGatesWithoutReasons } from "../../scripts/check-dispatch-gate-reasons";

/** One module's source, keyed by path — the injectable seam every checker in scripts/ exposes. */
function fakeModule(path: string, source: string) {
  return { modules: [path], readFile: () => source, allowedBareBoolean: new Map<string, string>() };
}

// #9003: a `forceAiReview: true` pass — whose entire purpose is to spend a fresh review — completed with no
// fresh review and ZERO audit events explaining why (#9000). The investigation took hours of elimination,
// while the disposition lane, which names every hold, answered the same class of question in minutes. This
// check makes "nothing happened and nothing says why" fail CI instead of costing an investigation.
describe("check-dispatch-gate-reasons script (#9003)", () => {
  it("REGRESSION: flags a bare-boolean gate on a dispatch path — the shape that produced #9000", () => {
    const violations = findDispatchGatesWithoutReasons(
      fakeModule("src/queue/ai-review-orchestration.ts", "export function shouldStartReview(args: X): boolean {\n  return true;\n}\n"),
    );
    expect(violations).toEqual([
      {
        file: "src/queue/ai-review-orchestration.ts",
        gate: "shouldStartReview",
        reason: expect.stringContaining("no paired reason resolver"),
      },
    ]);
  });

  it("INVARIANT: a gate returning its reason WITH the decision passes — the evaluateVisualVisionGate shape", () => {
    // { run: false, reason: "low_reputation" } cannot drift from its explanation, because they are one value.
    const violations = findDispatchGatesWithoutReasons(
      fakeModule("src/review/visual/visual-findings.ts", "export function evaluateVisualVisionGate(input: X): VisualVisionGateResult {\n  return { run: true };\n}\n"),
    );
    expect(violations).toEqual([]);
  });

  it("INVARIANT: an async gate returning Promise<boolean> is caught too", () => {
    const violations = findDispatchGatesWithoutReasons(
      fakeModule("src/queue/ai-review-orchestration.ts", "export async function shouldDispatch(args: X): Promise<boolean> {\n  return true;\n}\n"),
    );
    expect(violations.map((violation) => violation.gate)).toEqual(["shouldDispatch"]);
  });

  it("INVARIANT: a multi-line signature is caught — formatting must not decide whether a rule applies", () => {
    // The #9541 lesson: a family written in two formattings is a family a grep only half-sees.
    const source = "export function shouldStartReview(\n  env: Env,\n  args: Args,\n): boolean {\n  return true;\n}\n";
    const violations = findDispatchGatesWithoutReasons(fakeModule("src/queue/ai-review-orchestration.ts", source));
    expect(violations.map((violation) => violation.gate)).toEqual(["shouldStartReview"]);
  });

  it("INVARIANT: an allowlisted gate is exempt, but only by EXACT name", () => {
    const source = "export function shouldRequire(a: X): boolean {\n  return true;\n}\nexport function shouldRequireTwin(a: X): boolean {\n  return true;\n}\n";
    const violations = findDispatchGatesWithoutReasons({
      modules: ["src/queue/ai-review-orchestration.ts"],
      readFile: () => source,
      allowedBareBoolean: new Map([["shouldRequire", "paired with resolveXSkipReason"]]),
    });
    // The twin is NOT covered by its prefix-sharing sibling's entry — an exemption is a claim about one gate.
    expect(violations.map((violation) => violation.gate)).toEqual(["shouldRequireTwin"]);
  });

  it("REGRESSION: a resolver ELSEWHERE in the module does not exempt an unrelated gate", () => {
    // This was the check's first shape and it is unsound: one resolver anywhere in a file would exempt every
    // future gate added beside it — the same "a neighbour satisfies the scan for the one actually missing it"
    // false negative check-regate-sort-key.ts had to adopt brace-bounding to kill. Pairing must be STATED.
    const source =
      "export function resolvePublicAiReviewGateSkipReason(a: X): Reason | null {\n  return null;\n}\n" +
      "export function shouldSomethingElse(a: X): boolean {\n  return true;\n}\n";
    const violations = findDispatchGatesWithoutReasons(fakeModule("src/queue/ai-review-orchestration.ts", source));
    expect(violations.map((violation) => violation.gate)).toEqual(["shouldSomethingElse"]);
  });

  it("INVARIANT: a non-gate export is ignored — the rule is about suppressing work, not every boolean", () => {
    const source = "export function formatSummary(a: X): boolean {\n  return true;\n}\n";
    expect(findDispatchGatesWithoutReasons(fakeModule("src/queue/ai-review-orchestration.ts", source))).toEqual([]);
  });

  it("INVARIANT: a module absent from this checkout reports nothing rather than throwing", () => {
    const violations = findDispatchGatesWithoutReasons({
      modules: ["src/queue/does-not-exist.ts"],
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(violations).toEqual([]);
  });

  it("reports violations sorted by file then gate, so the failure output is stable", () => {
    const source = "export function shouldZeta(a: X): boolean {\n  return true;\n}\nexport function shouldAlpha(a: X): boolean {\n  return true;\n}\n";
    const violations = findDispatchGatesWithoutReasons(fakeModule("src/queue/ai-review-orchestration.ts", source));
    expect(violations.map((violation) => violation.gate)).toEqual(["shouldAlpha", "shouldZeta"]);
  });

  it("the REAL dispatch paths are clean — this check runs in CI and must stay green", () => {
    expect(findDispatchGatesWithoutReasons()).toEqual([]);
  });
});
