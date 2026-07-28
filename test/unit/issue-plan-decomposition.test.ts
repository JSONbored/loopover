import { describe, expect, it } from "vitest";
import { decomposeIssueToPlan, type IssuePlanInput } from "../../packages/loopover-engine/src/issue-plan-decomposition";
import type { RawPlanStep } from "../../packages/loopover-engine/src/plan-templates";
import { rawPlanStepSchema } from "@loopover/contract/tools";

// Assert the structural rules plan-store.js's validatePlanDag enforces (rawPlanStepSchema-valid steps, unique ids,
// in-plan non-self deps, every dep declared BEFORE use → acyclic with a ready topo order). Mirrors the equivalent
// checks in plan-templates.test.ts so the two composers are held to the same contract.
function assertValidDag(steps: RawPlanStep[]): void {
  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps) expect(() => rawPlanStepSchema.parse(step)).not.toThrow();
  const ids = steps.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  const seen = new Set<string>();
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      expect(dep).not.toBe(step.id);
      expect(seen.has(dep)).toBe(true);
    }
    seen.add(step.id);
  }
}

const idsOf = (steps: RawPlanStep[]): string[] => steps.map((s) => s.id);

describe("decomposeIssueToPlan (#4292 issue → plan DAG)", () => {
  it("produces a schema-valid, acyclic 6-step DAG for a bug + docs issue", () => {
    const steps = decomposeIssueToPlan({ title: "Fix the crash on empty input", body: "It crashes; update the docs too.", labels: ["bug", "docs"] });
    assertValidDag(steps);
    expect(idsOf(steps)).toEqual(["locate", "reproduce", "implement", "test", "docs", "verify"]);
    expect(steps.find((s) => s.id === "implement")!.dependsOn).toEqual(["reproduce"]);
    expect(steps.find((s) => s.id === "verify")!.dependsOn).toEqual(["test", "docs"]);
    expect(steps.find((s) => s.id === "test")!.title).toContain("regression");
    expect(steps[0]!.title).toContain("Fix the crash on empty input"); // subject woven into titles
  });

  it("produces the minimal baseline spine for a bare issue (no title/body/labels)", () => {
    const steps = decomposeIssueToPlan();
    assertValidDag(steps);
    expect(idsOf(steps)).toEqual(["locate", "implement", "test", "verify"]);
    expect(steps.find((s) => s.id === "implement")!.dependsOn).toEqual(["locate"]);
    expect(steps.find((s) => s.id === "verify")!.dependsOn).toEqual(["test"]);
    expect(steps.find((s) => s.id === "test")!.title).toBe("Add tests and run the suite"); // no subject, non-bug
  });

  it("inserts a reproduce step + regression test for a bug-signalled issue with no docs", () => {
    const steps = decomposeIssueToPlan({ title: "regression in parser", labels: ["bug"] });
    assertValidDag(steps);
    expect(idsOf(steps)).toEqual(["locate", "reproduce", "implement", "test", "verify"]);
    expect(steps.some((s) => s.id === "docs")).toBe(false);
  });

  it("inserts a docs step (verify waits on it) for a docs-signalled non-bug issue", () => {
    const steps = decomposeIssueToPlan({ labels: ["documentation"] });
    assertValidDag(steps);
    expect(idsOf(steps)).toEqual(["locate", "implement", "test", "docs", "verify"]);
    expect(steps.some((s) => s.id === "reproduce")).toBe(false);
    expect(steps.find((s) => s.id === "verify")!.dependsOn).toEqual(["test", "docs"]);
  });

  it("detects the issue kind from free-text title/body even without labels", () => {
    expect(decomposeIssueToPlan({ title: "Fix broken retry" }).some((s) => s.id === "reproduce")).toBe(true);
    expect(decomposeIssueToPlan({ body: "please update the README guide" }).some((s) => s.id === "docs")).toBe(true);
  });

  it("caps an overlong title to the schema's 300-char ceiling", () => {
    const steps = decomposeIssueToPlan({ title: "x".repeat(500) });
    for (const step of steps) {
      expect(step.title.length).toBeLessThanOrEqual(300);
      expect(() => rawPlanStepSchema.parse(step)).not.toThrow();
    }
  });

  it("is deterministic: same input yields identical output", () => {
    const input: IssuePlanInput = { title: "Add a retry to the fetch helper", body: "b", labels: ["feature"] };
    expect(decomposeIssueToPlan(input)).toEqual(decomposeIssueToPlan(input));
  });
});
