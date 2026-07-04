import { describe, expect, it } from "vitest";
import {
  analyzePlanTemplate,
  buildPlanTemplate,
  createPlanTemplate,
  discoverPlanTemplate,
  managePlanTemplate,
  planPlanTemplate,
  preparePlanTemplate,
  PLAN_TEMPLATE_BUILDERS,
  type PlanTemplateStage,
  type RawPlanStep,
} from "../../packages/gittensory-engine/src/plan-templates";
import { rawPlanStepSchema } from "../../src/mcp/server";

const STAGES = Object.keys(PLAN_TEMPLATE_BUILDERS) as PlanTemplateStage[];

function idsOf(steps: RawPlanStep[]): string[] {
  return steps.map((s) => s.id);
}

describe("plan-templates", () => {
  it("exposes a builder for every declared stage", () => {
    expect(STAGES.sort()).toEqual(["analyze", "create", "discover", "manage", "plan", "prepare"]);
  });

  it.each(STAGES)("'%s' template round-trips through the real rawPlanStepSchema", (stage) => {
    const steps = buildPlanTemplate(stage, { subject: "fix flaky retry" });
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(() => rawPlanStepSchema.parse(step)).not.toThrow();
    }
  });

  it.each(STAGES)("'%s' template has unique ids and only in-plan, acyclic dependencies", (stage) => {
    const steps = buildPlanTemplate(stage);
    const ids = idsOf(steps);
    expect(new Set(ids).size).toBe(ids.length);
    const present = new Set(ids);
    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) {
        expect(present.has(dep)).toBe(true);
      }
    }
    // A step may only depend on steps declared before it, which both proves acyclicity and gives a ready topo order.
    const seen = new Set<string>();
    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) expect(seen.has(dep)).toBe(true);
      seen.add(step.id);
    }
  });

  it("is deterministic: same context yields identical output", () => {
    expect(discoverPlanTemplate({ subject: "x" })).toEqual(discoverPlanTemplate({ subject: "x" }));
    expect(analyzePlanTemplate({ subject: "x" })).toEqual(analyzePlanTemplate({ subject: "x" }));
    expect(planPlanTemplate({ subject: "x" })).toEqual(planPlanTemplate({ subject: "x" }));
    expect(preparePlanTemplate()).toEqual(preparePlanTemplate());
    expect(createPlanTemplate({ subject: "x" })).toEqual(createPlanTemplate({ subject: "x" }));
    expect(managePlanTemplate()).toEqual(managePlanTemplate());
  });

  it("weaves the subject into every title as a single clean line", () => {
    const steps = analyzePlanTemplate({ subject: "  add\ta\nlaptop   mode  " });
    for (const step of steps) {
      expect(step.title).toContain(": add a laptop mode");
      expect(step.title).not.toMatch(/[\r\n\t]/);
    }
  });

  it("omits the subject suffix when no subject is given", () => {
    const first = preparePlanTemplate()[0];
    expect(first?.title).toBe("Create working branch");
  });

  it("bounds an oversized subject so every title stays within the schema's 300-char limit", () => {
    const steps = analyzePlanTemplate({ subject: "z".repeat(5000) });
    for (const step of steps) {
      expect(() => rawPlanStepSchema.parse(step)).not.toThrow();
      expect(step.title.length).toBeLessThanOrEqual(300);
    }
  });

  it("encodes the real discover ordering: lane-fit and pre-start depend on prior discovery steps", () => {
    const steps = discoverPlanTemplate();
    expect(steps.map((s) => s.id)).toEqual(["opportunity-rank", "lane-fit-check", "pre-start-check"]);
    expect(steps.find((s) => s.id === "lane-fit-check")?.dependsOn).toEqual(["opportunity-rank"]);
    expect(steps.find((s) => s.id === "pre-start-check")?.dependsOn).toEqual(["lane-fit-check"]);
  });

  it("encodes the real analyze ordering: prompt-packet depends on both feasibility and retrieval", () => {
    const steps = analyzePlanTemplate();
    const packet = steps.find((s) => s.id === "prompt-packet");
    expect(packet?.dependsOn).toEqual(["feasibility-check", "rag-retrieval"]);
  });

  it("encodes the real prepare ordering: a strict branch-create -> coding-agent -> local-test chain", () => {
    const steps = preparePlanTemplate();
    expect(steps.map((s) => s.id)).toEqual(["branch-create", "coding-agent", "local-test"]);
    expect(steps.find((s) => s.id === "coding-agent")?.dependsOn).toEqual(["branch-create"]);
    expect(steps.find((s) => s.id === "local-test")?.dependsOn).toEqual(["coding-agent"]);
  });

  it("encodes the real plan ordering: readiness depends on the built DAG", () => {
    const steps = planPlanTemplate();
    expect(steps.map((s) => s.id)).toEqual(["packet-validate", "plan-dag-build", "readiness-check"]);
    expect(steps.find((s) => s.id === "plan-dag-build")?.dependsOn).toEqual(["packet-validate"]);
    expect(steps.find((s) => s.id === "readiness-check")?.dependsOn).toEqual(["plan-dag-build"]);
  });

  it("encodes the real create ordering: open PR depends on a pushed branch", () => {
    const steps = createPlanTemplate();
    expect(steps.map((s) => s.id)).toEqual(["commit-changes", "push-branch", "open-pull-request"]);
    expect(steps.find((s) => s.id === "push-branch")?.dependsOn).toEqual(["commit-changes"]);
    expect(steps.find((s) => s.id === "open-pull-request")?.dependsOn).toEqual(["push-branch"]);
  });

  it("encodes the real manage ordering: fork sync follows the gate verdict", () => {
    const steps = managePlanTemplate();
    expect(steps.map((s) => s.id)).toEqual(["wait-ci", "read-gate-result", "sync-fork"]);
    expect(steps.find((s) => s.id === "read-gate-result")?.dependsOn).toEqual(["wait-ci"]);
    expect(steps.find((s) => s.id === "sync-fork")?.dependsOn).toEqual(["read-gate-result"]);
  });

  it("rejects an unknown stage with a clear error instead of a generic TypeError", () => {
    expect(() => buildPlanTemplate("bogus" as PlanTemplateStage)).toThrow(/Unknown plan-template stage/);
  });

  it.each(["constructor", "toString", "hasOwnProperty"])(
    "rejects inherited Object.prototype stage '%s' instead of dispatching it",
    (stage) => {
      expect(() => buildPlanTemplate(stage as PlanTemplateStage, [] as unknown as never)).toThrow(
        /Unknown plan-template stage/,
      );
    },
  );

  it("exposes a frozen registry so the shared dispatch table cannot be mutated", () => {
    expect(Object.isFrozen(PLAN_TEMPLATE_BUILDERS)).toBe(true);
  });
});
