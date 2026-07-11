// Idea-intake bridge (#4779 schema, #4798 enforcement): pure translation from a freeform human idea into a
// structured, claimable task-graph with per-task acceptance criteria and scoring rubrics. Deterministic and
// side-effect-free — callers own persistence and downstream queue wiring.

export const IDEA_INTAKE_BRIDGE_VERSION = 1 as const;
export const IDEA_INTAKE_MAX_IDEA_CHARS = 8_000;

const REPO_FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NUMBERED_STEP_RE = /^\d+[.)]\s+/;
const BULLET_STEP_RE = /^[-*•]\s+/;

export type IdeaSubmissionInput = {
  repoFullName: string;
  idea: string;
  title?: string | undefined;
};

export type IdeaIntakeError = {
  code: string;
  message: string;
  field?: string | undefined;
};

export type IdeaTaskScoringDimension = {
  id: string;
  label: string;
  description: string;
  weight: number;
};

export type IdeaTaskScoringRubric = {
  dimensions: IdeaTaskScoringDimension[];
  passThreshold: number;
};

export type IdeaTaskClaimableUnit = {
  kind: "issue" | "direct_pr";
  identifierHint: string;
  summary: string;
};

export type IdeaTaskGraphNode = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  scoringRubric: IdeaTaskScoringRubric;
  claimableUnit: IdeaTaskClaimableUnit;
  dependsOn: string[];
};

export type IdeaTaskGraph = {
  version: typeof IDEA_INTAKE_BRIDGE_VERSION;
  repoFullName: string;
  sourceIdea: string;
  summary: string;
  tasks: IdeaTaskGraphNode[];
};

export type IdeaIntakeSuccess = {
  ok: true;
  taskGraph: IdeaTaskGraph;
};

export type IdeaIntakeFailure = {
  ok: false;
  errors: IdeaIntakeError[];
};

export type IdeaIntakeResult = IdeaIntakeSuccess | IdeaIntakeFailure;

/** F1 worked examples from the #4779 spec — used by #4798 acceptance tests. */
export const F1_SIMPLE_IDEA_EXAMPLE: IdeaSubmissionInput = {
  repoFullName: "acme/widgets",
  idea: "Add a dark mode toggle to the settings page.",
};

export const F1_COMPLEX_IDEA_EXAMPLE: IdeaSubmissionInput = {
  repoFullName: "acme/widgets",
  idea: [
    "Ship user-facing export for analytics dashboards.",
    "1. Add CSV export endpoint for saved dashboard views.",
    "2. Wire the settings UI export button to the new endpoint.",
    "3. Add tests covering empty, partial, and full dashboard exports.",
  ].join("\n"),
};

const DEFAULT_SCORING_RUBRIC: IdeaTaskScoringRubric = {
  dimensions: [
    {
      id: "fidelity",
      label: "Idea fidelity",
      description: "Deliverable matches the requested slice of the original idea.",
      weight: 0.4,
    },
    {
      id: "acceptance",
      label: "Acceptance criteria",
      description: "Every listed criterion is met with observable evidence.",
      weight: 0.35,
    },
    {
      id: "scope",
      label: "Scope discipline",
      description: "Change stays within the task boundary without drive-by refactors.",
      weight: 0.25,
    },
  ],
  passThreshold: 0.8,
};

function normalizeRepoFullName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!REPO_FULL_NAME_RE.test(trimmed)) return null;
  const [owner, repo] = trimmed.split("/");
  return `${owner}/${repo}`;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "task";
}

function sentenceCase(text: string): string {
  const trimmed = text.trim();
  /* v8 ignore next -- splitIdeaIntoSteps never emits whitespace-only steps; defensive early return. */
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function titleFromStep(step: string, fallbackIndex: number): string {
  const firstLine = step.split(/\r?\n/, 1)[0]!.trim();
  /* v8 ignore next -- numbered/bullet parsing trims each step; defensive fallback when the first line is blank. */
  const candidate = firstLine.length > 0 ? firstLine : `Task ${fallbackIndex}`;
  if (candidate.length > 120) {
    return `${candidate.slice(0, 117)}...`;
  }
  return candidate;
}

function acceptanceCriteriaForStep(step: string, repoFullName: string): string[] {
  const normalized = sentenceCase(step.replace(/\s+/g, " ").trim());
  return [
    `Implement: ${normalized}`,
    `Changes land in ${repoFullName} with tests or verification steps appropriate to the slice.`,
    "No unrelated refactors or scope expansion beyond this task.",
  ];
}

function splitIdeaIntoSteps(idea: string): { summary: string; steps: string[] } {
  const lines = idea
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const numbered = lines.filter((line) => NUMBERED_STEP_RE.test(line));
  if (numbered.length >= 2) {
    const preamble = lines.filter((line) => !NUMBERED_STEP_RE.test(line));
    const steps = numbered.map((line) => line.replace(NUMBERED_STEP_RE, "").trim()).filter(Boolean);
    return {
      summary: preamble.join(" ") || steps[0]!,
      steps,
    };
  }

  const bullets = lines.filter((line) => BULLET_STEP_RE.test(line));
  if (bullets.length >= 2) {
    const preamble = lines.filter((line) => !BULLET_STEP_RE.test(line));
    const steps = bullets.map((line) => line.replace(BULLET_STEP_RE, "").trim()).filter(Boolean);
    return {
      summary: preamble.join(" ") || steps[0]!,
      steps,
    };
  }

  const thenParts = idea
    .split(/\s+then\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (thenParts.length >= 2) {
    return { summary: thenParts[0]!, steps: thenParts.map(sentenceCase) };
  }

  const trimmed = idea.trim();
  return { summary: trimmed, steps: [trimmed] };
}

/** Validate a raw idea submission before translation. Pure. */
export function validateIdeaSubmission(input: IdeaSubmissionInput): IdeaIntakeError[] {
  const errors: IdeaIntakeError[] = [];
  const repoFullName = normalizeRepoFullName(input.repoFullName);
  if (!repoFullName) {
    errors.push({
      code: "invalid_repo_full_name",
      field: "repoFullName",
      message: "repoFullName must be a public GitHub repository in owner/name form.",
    });
  }

  if (typeof input.idea !== "string" || input.idea.trim().length === 0) {
    errors.push({
      code: "idea_required",
      field: "idea",
      message: "idea must be a non-empty freeform description of the work to rent.",
    });
  } else if (input.idea.length > IDEA_INTAKE_MAX_IDEA_CHARS) {
    errors.push({
      code: "idea_too_long",
      field: "idea",
      message: `idea must be at most ${IDEA_INTAKE_MAX_IDEA_CHARS} characters.`,
    });
  }

  if (input.title !== undefined && (typeof input.title !== "string" || input.title.trim().length === 0)) {
    errors.push({
      code: "invalid_title",
      field: "title",
      message: "title, when provided, must be a non-empty string.",
    });
  }

  return errors;
}

function rubricWeightTotal(rubric: IdeaTaskScoringRubric): number {
  return rubric.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
}

/** Validate a translated task-graph against the #4779 schema shape. Pure. */
export function validateIdeaTaskGraph(taskGraph: IdeaTaskGraph): IdeaIntakeError[] {
  const errors: IdeaIntakeError[] = [];
  if (taskGraph.version !== IDEA_INTAKE_BRIDGE_VERSION) {
    errors.push({ code: "invalid_version", message: "taskGraph.version must be 1." });
  }
  if (!normalizeRepoFullName(taskGraph.repoFullName)) {
    errors.push({ code: "invalid_repo_full_name", field: "repoFullName", message: "taskGraph.repoFullName is invalid." });
  }
  if (typeof taskGraph.summary !== "string" || taskGraph.summary.trim().length === 0) {
    errors.push({ code: "summary_required", field: "summary", message: "taskGraph.summary must be non-empty." });
  }
  if (!Array.isArray(taskGraph.tasks) || taskGraph.tasks.length === 0) {
    errors.push({ code: "tasks_required", field: "tasks", message: "taskGraph.tasks must contain at least one claimable task." });
    return errors;
  }

  const ids = new Set<string>();
  for (const task of taskGraph.tasks) {
    if (ids.has(task.id)) errors.push({ code: "duplicate_task_id", field: "tasks", message: `Duplicate task id ${task.id}.` });
    ids.add(task.id);
    if (task.acceptanceCriteria.length === 0) {
      errors.push({
        code: "acceptance_criteria_required",
        field: `tasks.${task.id}.acceptanceCriteria`,
        message: `Task ${task.id} must include at least one acceptance criterion.`,
      });
    }
    if (Math.abs(rubricWeightTotal(task.scoringRubric) - 1) > 0.001) {
      errors.push({
        code: "invalid_rubric_weights",
        field: `tasks.${task.id}.scoringRubric`,
        message: `Task ${task.id} scoring rubric weights must sum to 1.`,
      });
    }
    for (const dep of task.dependsOn) {
      if (!ids.has(dep) && !taskGraph.tasks.some((candidate) => candidate.id === dep)) {
        errors.push({
          code: "unknown_dependency",
          field: `tasks.${task.id}.dependsOn`,
          message: `Task ${task.id} depends on unknown task ${dep}.`,
        });
      }
    }
  }

  return errors;
}

function buildTaskGraphNode(
  repoFullName: string,
  step: string,
  index: number,
  previousTaskId: string | null,
): IdeaTaskGraphNode {
  const id = `task-${index}`;
  const title = titleFromStep(step, index);
  return {
    id,
    title,
    description: sentenceCase(step),
    acceptanceCriteria: acceptanceCriteriaForStep(step, repoFullName),
    scoringRubric: {
      dimensions: DEFAULT_SCORING_RUBRIC.dimensions.map((dimension) => ({ ...dimension })),
      passThreshold: DEFAULT_SCORING_RUBRIC.passThreshold,
    },
    claimableUnit: {
      kind: "issue",
      identifierHint: slugify(title),
      summary: title,
    },
    dependsOn: previousTaskId ? [previousTaskId] : [],
  };
}

/**
 * Translate a freeform idea into a structured task-graph conforming to the #4779 schema. Pure and
 * deterministic — identical input always yields identical output.
 */
export function translateIdeaToTaskGraph(input: IdeaSubmissionInput): IdeaIntakeResult {
  const submissionErrors = validateIdeaSubmission(input);
  if (submissionErrors.length > 0) return { ok: false, errors: submissionErrors };

  const repoFullName = normalizeRepoFullName(input.repoFullName)!;
  const { summary, steps } = splitIdeaIntoSteps(input.idea);
  let previousTaskId: string | null = null;
  const tasks = steps.map((step, index) => {
    const node = buildTaskGraphNode(repoFullName, step, index + 1, previousTaskId);
    previousTaskId = node.id;
    return node;
  });

  const taskGraph: IdeaTaskGraph = {
    version: IDEA_INTAKE_BRIDGE_VERSION,
    repoFullName,
    sourceIdea: input.idea.trim(),
    summary: input.title?.trim() || summary,
    tasks,
  };

  return finalizeIdeaTaskGraph(taskGraph);
}

/** Validate a built task-graph and return the public result union (#4798). */
export function finalizeIdeaTaskGraph(taskGraph: IdeaTaskGraph): IdeaIntakeResult {
  const graphErrors = validateIdeaTaskGraph(taskGraph);
  if (graphErrors.length > 0) return { ok: false, errors: graphErrors };
  return { ok: true, taskGraph };
}

/** Convenience helper for callers that want a thrown error instead of a result union. */
export function translateIdeaToTaskGraphOrThrow(input: IdeaSubmissionInput): IdeaTaskGraph {
  const result = translateIdeaToTaskGraph(input);
  if (!result.ok) {
    throw new Error(result.errors.map((error) => error.message).join(" "));
  }
  return result.taskGraph;
}

/** Expected F1 simple task-graph for regression tests (#4798). */
export function expectedF1SimpleTaskGraph(): IdeaTaskGraph {
  return translateIdeaToTaskGraphOrThrow(F1_SIMPLE_IDEA_EXAMPLE);
}

/** Expected F1 complex task-graph for regression tests (#4798). */
export function expectedF1ComplexTaskGraph(): IdeaTaskGraph {
  return translateIdeaToTaskGraphOrThrow(F1_COMPLEX_IDEA_EXAMPLE);
}
