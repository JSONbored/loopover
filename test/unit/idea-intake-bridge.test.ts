import { describe, expect, it } from "vitest";
import {
  F1_COMPLEX_IDEA_EXAMPLE,
  F1_SIMPLE_IDEA_EXAMPLE,
  IDEA_INTAKE_MAX_IDEA_CHARS,
  expectedF1ComplexTaskGraph,
  expectedF1SimpleTaskGraph,
  translateIdeaToTaskGraph,
  translateIdeaToTaskGraphOrThrow,
  finalizeIdeaTaskGraph,
  validateIdeaSubmission,
  validateIdeaTaskGraph,
} from "../../packages/gittensory-engine/src/idea-intake-bridge";

describe("translateIdeaToTaskGraph (#4798)", () => {
  it("translates F1 simple worked example into a single-task graph", () => {
    const result = translateIdeaToTaskGraph(F1_SIMPLE_IDEA_EXAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.taskGraph).toEqual(expectedF1SimpleTaskGraph());
    expect(result.taskGraph.tasks).toHaveLength(1);
    expect(result.taskGraph.tasks[0]).toMatchObject({
      id: "task-1",
      title: "Add a dark mode toggle to the settings page.",
      dependsOn: [],
      claimableUnit: {
        kind: "issue",
        identifierHint: "add-a-dark-mode-toggle-to-the-settings-page",
      },
    });
    expect(result.taskGraph.tasks[0]?.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
  });

  it("translates F1 complex worked example into a dependent multi-step graph", () => {
    const result = translateIdeaToTaskGraph(F1_COMPLEX_IDEA_EXAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.taskGraph).toEqual(expectedF1ComplexTaskGraph());
    expect(result.taskGraph.summary).toMatch(/analytics dashboards/i);
    expect(result.taskGraph.tasks.map((task) => task.title)).toEqual([
      "Add CSV export endpoint for saved dashboard views.",
      "Wire the settings UI export button to the new endpoint.",
      "Add tests covering empty, partial, and full dashboard exports.",
    ]);
    expect(result.taskGraph.tasks[0]?.dependsOn).toEqual([]);
    expect(result.taskGraph.tasks[1]?.dependsOn).toEqual(["task-1"]);
    expect(result.taskGraph.tasks[2]?.dependsOn).toEqual(["task-2"]);
  });

  it("returns actionable errors for malformed or empty submissions", () => {
    expect(translateIdeaToTaskGraph({ repoFullName: "acme/widgets", idea: "   " })).toEqual({
      ok: false,
      errors: [
        {
          code: "idea_required",
          field: "idea",
          message: "idea must be a non-empty freeform description of the work to rent.",
        },
      ],
    });

    expect(translateIdeaToTaskGraph({ repoFullName: "not-a-repo", idea: "Ship export" })).toEqual({
      ok: false,
      errors: [
        {
          code: "invalid_repo_full_name",
          field: "repoFullName",
          message: "repoFullName must be a public GitHub repository in owner/name form.",
        },
      ],
    });
  });

  it("validateIdeaTaskGraph rejects structurally invalid graphs", () => {
    const valid = translateIdeaToTaskGraph(F1_SIMPLE_IDEA_EXAMPLE);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    expect(validateIdeaTaskGraph(valid.taskGraph)).toEqual([]);

    const broken = {
      ...valid.taskGraph,
      tasks: [{ ...valid.taskGraph.tasks[0]!, acceptanceCriteria: [] }],
    };
    expect(validateIdeaTaskGraph(broken).map((error) => error.code)).toContain("acceptance_criteria_required");
  });

  it("validateIdeaSubmission catches blank titles without silent failure", () => {
    expect(validateIdeaSubmission({ repoFullName: "acme/widgets", idea: "Ship it", title: "  " })).toEqual([
      {
        code: "invalid_title",
        field: "title",
        message: "title, when provided, must be a non-empty string.",
      },
    ]);
  });

  it("supports bullet and then-separated multi-step ideas", () => {
    const bulletsOnly = translateIdeaToTaskGraph({
      repoFullName: "acme/widgets",
      idea: "- Add welcome banner\n- Wire docs link in nav",
    });
    expect(bulletsOnly.ok).toBe(true);
    if (!bulletsOnly.ok) return;
    expect(bulletsOnly.taskGraph.summary).toBe("Add welcome banner");
    expect(bulletsOnly.taskGraph.tasks).toHaveLength(2);

    const bullets = translateIdeaToTaskGraph({
      repoFullName: "acme/widgets",
      idea: "Improve onboarding flow\n- Add welcome banner\n- Wire docs link in nav",
    });
    expect(bullets.ok).toBe(true);
    if (!bullets.ok) return;
    expect(bullets.taskGraph.summary).toBe("Improve onboarding flow");
    expect(bullets.taskGraph.tasks).toHaveLength(2);

    const thenChain = translateIdeaToTaskGraph({
      repoFullName: "acme/widgets",
      idea: "Add export endpoint then wire the settings button then add tests",
    });
    expect(thenChain.ok).toBe(true);
    if (!thenChain.ok) return;
    expect(thenChain.taskGraph.tasks).toHaveLength(3);
    expect(thenChain.taskGraph.tasks[2]?.dependsOn).toEqual(["task-2"]);
  });

  it("honors an optional title override and rejects overlong ideas", () => {
    const titled = translateIdeaToTaskGraph({
      ...F1_SIMPLE_IDEA_EXAMPLE,
      title: "Dark mode for settings",
    });
    expect(titled.ok).toBe(true);
    if (!titled.ok) return;
    expect(titled.taskGraph.summary).toBe("Dark mode for settings");

    expect(
      validateIdeaSubmission({
        repoFullName: "acme/widgets",
        idea: "x".repeat(IDEA_INTAKE_MAX_IDEA_CHARS + 1),
      }).map((error) => error.code),
    ).toContain("idea_too_long");
  });

  it("validateIdeaTaskGraph surfaces structural graph defects", () => {
    const valid = translateIdeaToTaskGraph(F1_SIMPLE_IDEA_EXAMPLE);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;

    expect(validateIdeaTaskGraph({ ...valid.taskGraph, version: 2 as 1 }).map((error) => error.code)).toContain(
      "invalid_version",
    );
    expect(validateIdeaTaskGraph({ ...valid.taskGraph, tasks: [] }).map((error) => error.code)).toContain(
      "tasks_required",
    );
    expect(
      validateIdeaTaskGraph({
        ...valid.taskGraph,
        tasks: [
          { ...valid.taskGraph.tasks[0]!, id: "task-1" },
          { ...valid.taskGraph.tasks[0]!, id: "task-1" },
        ],
      }).map((error) => error.code),
    ).toContain("duplicate_task_id");
    expect(validateIdeaTaskGraph({ ...valid.taskGraph, repoFullName: "bad" }).map((error) => error.code)).toContain(
      "invalid_repo_full_name",
    );
    expect(validateIdeaTaskGraph({ ...valid.taskGraph, summary: "  " }).map((error) => error.code)).toContain(
      "summary_required",
    );
    expect(
      validateIdeaTaskGraph({
        ...valid.taskGraph,
        tasks: [
          {
            ...valid.taskGraph.tasks[0]!,
            scoringRubric: {
              dimensions: [{ id: "x", label: "x", description: "x", weight: 0.2 }],
              passThreshold: 0.8,
            },
          },
        ],
      }).map((error) => error.code),
    ).toContain("invalid_rubric_weights");
    expect(
      validateIdeaTaskGraph({
        ...valid.taskGraph,
        tasks: [{ ...valid.taskGraph.tasks[0]!, dependsOn: ["missing-task"] }],
      }).map((error) => error.code),
    ).toContain("unknown_dependency");

    const forwardRef = {
      ...valid.taskGraph,
      tasks: [
        { ...valid.taskGraph.tasks[0]!, id: "task-1", dependsOn: [] },
        { ...valid.taskGraph.tasks[0]!, id: "task-2", dependsOn: ["task-3"] },
        { ...valid.taskGraph.tasks[0]!, id: "task-3", dependsOn: [] },
      ],
    };
    expect(validateIdeaTaskGraph(forwardRef).map((error) => error.code)).not.toContain("unknown_dependency");
  });

  it("translateIdeaToTaskGraphOrThrow throws aggregated validation errors", () => {
    expect(() => translateIdeaToTaskGraphOrThrow({ repoFullName: "bad", idea: "" })).toThrow(
      /repoFullName must be a public GitHub repository/i,
    );
    expect(validateIdeaSubmission({ repoFullName: "acme/widgets", idea: null as unknown as string })).toEqual([
      expect.objectContaining({ code: "idea_required" }),
    ]);
  });

  it("uses numbered steps without a preamble as the summary fallback", () => {
    const numberedOnly = translateIdeaToTaskGraph({
      repoFullName: "acme/widgets",
      idea: "1. Alpha slice\n2. Beta slice",
    });
    expect(numberedOnly.ok).toBe(true);
    if (!numberedOnly.ok) return;
    expect(numberedOnly.taskGraph.summary).toBe("Alpha slice");
    expect(numberedOnly.taskGraph.tasks).toHaveLength(2);
  });

  it("validateIdeaSubmission rejects non-string repoFullName values", () => {
    expect(validateIdeaSubmission({ repoFullName: 123 as unknown as string, idea: "Ship export" })).toEqual([
      expect.objectContaining({ code: "invalid_repo_full_name", field: "repoFullName" }),
    ]);
  });

  it("finalizeIdeaTaskGraph returns validation failures for structurally invalid graphs", () => {
    const valid = translateIdeaToTaskGraph(F1_SIMPLE_IDEA_EXAMPLE);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;

    expect(finalizeIdeaTaskGraph({ ...valid.taskGraph, tasks: [] })).toEqual({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "tasks_required" })]),
    });
    expect(finalizeIdeaTaskGraph(valid.taskGraph)).toEqual(valid);
  });

  it("truncates very long step titles and slugifies punctuation-only ideas", () => {
    const atLimit = translateIdeaToTaskGraph({ repoFullName: "acme/widgets", idea: "x".repeat(120) });
    expect(atLimit.ok).toBe(true);
    if (!atLimit.ok) return;
    expect(atLimit.taskGraph.tasks[0]?.title).toBe("x".repeat(120));

    const overLimit = translateIdeaToTaskGraph({ repoFullName: "acme/widgets", idea: "x".repeat(121) });
    expect(overLimit.ok).toBe(true);
    if (!overLimit.ok) return;
    expect(overLimit.taskGraph.tasks[0]?.title).toBe(`${"x".repeat(117)}...`);

    const punctuation = translateIdeaToTaskGraph({ repoFullName: "acme/widgets", idea: "***" });
    expect(punctuation.ok).toBe(true);
    if (!punctuation.ok) return;
    expect(punctuation.taskGraph.tasks[0]?.claimableUnit.identifierHint).toBe("task");
  });
});
