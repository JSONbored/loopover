import { describe, expect, it } from "vitest";
import {
  renderPlanAsJson,
  renderPlanAsMarkdown,
  type PlanDag,
  type PlanStep,
} from "../../packages/gittensory-engine/src/plan-export";

function step(over: Partial<PlanStep> & { id: string; title: string }): PlanStep {
  return {
    actionClass: undefined,
    dependsOn: [],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    ...over,
  };
}

describe("renderPlanAsMarkdown", () => {
  it("renders an empty plan with a placeholder", () => {
    expect(renderPlanAsMarkdown({ steps: [] })).toBe("_No steps in this plan._");
  });

  it("checks completed steps, leaves others unchecked, and shows status", () => {
    const md = renderPlanAsMarkdown({
      steps: [
        step({ id: "a", title: "Build", status: "completed" }),
        step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
      ],
    });
    expect(md).toBe("- [x] Build — completed\n- [ ] Test — pending");
  });

  it("annotates attempts only after a step has run and appends the last error", () => {
    const md = renderPlanAsMarkdown({
      steps: [
        step({ id: "a", title: "Deploy", status: "failed", attempts: 2, maxAttempts: 2, lastError: "boom" }),
        step({ id: "b", title: "Wait", status: "pending", attempts: 0 }),
      ],
    });
    expect(md).toBe("- [ ] Deploy — failed (attempt 2/2): boom\n- [ ] Wait — pending");
  });

  it("orders steps by dependency so a dependency precedes its dependents", () => {
    const md = renderPlanAsMarkdown({
      steps: [
        step({ id: "b", title: "B", dependsOn: ["a"] }),
        step({ id: "a", title: "A" }),
      ],
    });
    expect(md).toBe("- [ ] A — pending\n- [ ] B — pending");
  });

  it("treats an unknown dependency id as already satisfied", () => {
    const md = renderPlanAsMarkdown({ steps: [step({ id: "a", title: "A", dependsOn: ["ghost"] })] });
    expect(md).toBe("- [ ] A — pending");
  });

  it("appends steps caught in a dependency cycle in original order instead of dropping or looping", () => {
    const md = renderPlanAsMarkdown({
      steps: [
        step({ id: "a", title: "A", dependsOn: ["b"] }),
        step({ id: "b", title: "B", dependsOn: ["a"] }),
      ],
    });
    expect(md.split("\n")).toEqual(["- [ ] A — pending", "- [ ] B — pending"]);
  });

  it("keeps each step on one line when a title or lastError contains newlines", () => {
    const md = renderPlanAsMarkdown({
      steps: [step({ id: "a", title: "Line one\nLine two", status: "failed", attempts: 1, maxAttempts: 3, lastError: "err one\r\nerr two" })],
    });
    expect(md.split("\n")).toHaveLength(1);
    expect(md).toBe("- [ ] Line one Line two — failed (attempt 1/3): err one err two");
  });

  it("escapes Markdown control characters in a title or lastError so they cannot re-style the line", () => {
    const md = renderPlanAsMarkdown({
      steps: [step({ id: "a", title: "drop `table` [x] *now*", status: "failed", attempts: 1, maxAttempts: 2, lastError: "path a\\b <tag> | ~x~" })],
    });
    expect(md.split("\n")).toHaveLength(1);
    expect(md).toBe("- [ ] drop \\`table\\` \\[x\\] \\*now\\* — failed (attempt 1/2): path a\\\\b \\<tag\\> \\| \\~x\\~");
  });
});

describe("renderPlanAsJson", () => {
  it("produces stable, key-sorted JSON that is byte-identical across renders of the same plan", () => {
    const plan: PlanDag = { steps: [step({ id: "z", title: "Z", status: "running", attempts: 1 })] };
    const first = renderPlanAsJson(plan);
    expect(renderPlanAsJson(plan)).toBe(first);
    const parsedStep = JSON.parse(first).steps[0];
    expect(Object.keys(parsedStep)).toEqual([...Object.keys(parsedStep)].sort());
  });

  it("sorts keys regardless of input insertion order but preserves the step array order", () => {
    const forward = renderPlanAsJson({
      steps: [step({ id: "1", title: "One" }), step({ id: "2", title: "Two" })],
    });
    const reorderedKeys = {
      title: "One",
      id: "1",
      maxAttempts: 3,
      attempts: 0,
      status: "pending",
      dependsOn: [],
      actionClass: undefined,
      lastError: null,
    } as PlanStep;
    const reordered = renderPlanAsJson({ steps: [reorderedKeys, step({ id: "2", title: "Two" })] });
    expect(reordered).toBe(forward);
    expect(forward.indexOf('"id": "1"')).toBeLessThan(forward.indexOf('"id": "2"'));
  });
});
