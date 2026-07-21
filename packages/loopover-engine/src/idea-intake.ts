// Idea-intake bridge (pure) — turns a freeform renter idea into a strict, claimable task-graph and scores
// it against the SAME feasibility gate the loop already runs on. Product spec: #4779
// (packages/loopover-miner/docs/idea-intake-bridge-schema.md). This module owns the DETERMINISTIC seam:
// input validation, task-graph assembly, and the per-issue + graph-level feasibility verdict. The idea →
// constituent-issue decomposition is the one fuzzy step and is passed IN (from the renter-reviewed draft /
// the freeform-scoring adapter of #5671), so this bridge itself stays pure and testable — no IO, no AI.

import {
  buildFeasibilityVerdict,
  type FeasibilityGateInput,
  type FeasibilityVerdict,
} from "./feasibility.js";

// Intake bounds — mirror the manifest text-slot handling (focus-manifest.ts): a renter's freeform text is
// length-capped so one submission can never dominate a public surface.
export const IDEA_TITLE_MAX_CHARS = 120;
export const IDEA_BODY_MAX_CHARS = 4000;
export const IDEA_CONSTRAINT_MAX_CHARS = 200;

export type IdeaPriority = "normal" | "high";

/** Where an idea's work lands: an existing repo (BYOR) or a not-yet-created one to auto-provision (#7589). */
export type IdeaTarget =
  | { kind: "existing"; repo: string }
  | { kind: "provision" };

/** The raw input a renter provides (spec §1). */
export type IdeaSubmission = {
  id: string;
  title: string;
  body: string;
  targetRepo: IdeaTarget;
  constraints?: string[] | undefined;
  acceptanceHints?: string[] | undefined;
  priority?: IdeaPriority | undefined;
};

export type AcceptanceCriterionKind = "behavior" | "artifact" | "constraint";

export type AcceptanceCriterion = {
  id: string;
  statement: string;
  kind: AcceptanceCriterionKind;
};

/** One independently-shippable outcome (spec §2). `gittensor:priority` is NEVER emitted here — it is
 *  maintainer-propagated only, so a renter cannot self-assign the scarce reward label. */
export type ConstituentIssue = {
  key: string;
  title: string;
  body: string;
  labels: string[];
  dependsOn: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  feasibility: FeasibilityGateInput;
};

export type TaskGraph = {
  ideaId: string;
  issues: ConstituentIssue[];
  rubric: TaskGraphScore;
};

export type TaskGraphIssueScore = {
  key: string;
  verdict: FeasibilityVerdict;
  reasons: readonly string[];
};

/** Graph-level rubric (spec §3): the least-favorable verdict across constituent issues (`avoid` > `raise`
 *  > `go`), so a renter is never told "go" while any constituent is unshippable. */
export type TaskGraphScore = {
  verdict: FeasibilityVerdict;
  perIssue: TaskGraphIssueScore[];
};

export type IdeaValidationResult =
  | { ok: true; idea: IdeaSubmission }
  | { ok: false; errors: string[] };

// The renter-facing type labels the bridge may infer. `gittensor:priority` is deliberately absent.
const ALLOWED_ISSUE_TYPE_LABELS = new Set(["gittensor:bug", "gittensor:feature"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate + normalize a raw renter submission (spec §1). Returns every failure at once (never folds with
 *  `??`/`||`) so a caller can surface all problems in one pass rather than one-at-a-time. */
export function validateIdeaSubmission(raw: unknown): IdeaValidationResult {
  const errors: string[] = [];
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  if (!isNonEmptyString(input.id)) errors.push("id_required");
  if (!isNonEmptyString(input.title)) errors.push("title_required");
  else if (input.title.length > IDEA_TITLE_MAX_CHARS) errors.push("title_too_long");
  if (!isNonEmptyString(input.body)) errors.push("body_required");
  else if (input.body.length > IDEA_BODY_MAX_CHARS) errors.push("body_too_long");
  // Back-compat wire form: a bare "owner/name" string means an existing repo (each segment a GitHub-legal
  // slug -- an uninstallable/malformed repo is rejected at intake, never scored, since it can never produce a
  // `go`). A `{ kind: "provision" }` object requests a not-yet-created repo (#7589). Anything else is missing.
  let resolvedTarget: IdeaTarget | undefined;
  if (isNonEmptyString(input.targetRepo)) {
    if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input.targetRepo)) resolvedTarget = { kind: "existing", repo: input.targetRepo };
    else errors.push("target_repo_malformed");
  } else if (typeof input.targetRepo === "object" && input.targetRepo !== null && (input.targetRepo as Record<string, unknown>).kind === "provision") {
    resolvedTarget = { kind: "provision" };
  } else errors.push("target_repo_required");

  const constraints = input.constraints;
  if (constraints !== undefined) {
    if (!Array.isArray(constraints) || !constraints.every((c) => typeof c === "string")) errors.push("constraints_invalid");
    else if (constraints.some((c) => c.length > IDEA_CONSTRAINT_MAX_CHARS)) errors.push("constraint_too_long");
  }
  const acceptanceHints = input.acceptanceHints;
  if (acceptanceHints !== undefined) {
    if (!Array.isArray(acceptanceHints) || !acceptanceHints.every((h) => typeof h === "string")) errors.push("acceptance_hints_invalid");
    else if (acceptanceHints.some((h) => h.length > IDEA_CONSTRAINT_MAX_CHARS)) errors.push("acceptance_hint_too_long");
  }
  const priority = input.priority;
  if (priority !== undefined && priority !== "normal" && priority !== "high") errors.push("priority_invalid");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    idea: {
      id: input.id as string,
      title: input.title as string,
      body: input.body as string,
      targetRepo: resolvedTarget as IdeaTarget,
      constraints: constraints as string[] | undefined,
      acceptanceHints: acceptanceHints as string[] | undefined,
      priority: priority as IdeaPriority | undefined,
    },
  };
}

// Score ONE issue against the feasibility gate. Rule 5 (spec §2): an issue with an unlanded prerequisite is
// held until that prerequisite MERGES. Every issue in a freshly-built graph is new, so any issue that carries
// a `dependsOn` is held (`raise`) now and re-scores to `go` once its prerequisite lands — never claimed ahead
// of its prerequisite. Layered only over a `go` base, so an already-`avoid`/`raise` issue keeps its verdict.
function scoreIssue(issue: ConstituentIssue): TaskGraphIssueScore {
  const base = buildFeasibilityVerdict(issue.feasibility);
  if (base.verdict === "go" && issue.dependsOn.length > 0) {
    return { key: issue.key, verdict: "raise", reasons: ["dependency_not_landed"] };
  }
  return { key: issue.key, verdict: base.verdict, reasons: [...base.avoidReasons, ...base.raiseReasons] };
}

/** Score a task-graph against the feasibility gate (spec §3): the graph verdict is the least-favorable
 *  per-issue verdict (`avoid` > `raise` > `go`), so a renter is never told "go" while any constituent is
 *  unshippable. Adds no second decision surface beyond `buildFeasibilityVerdict` + the rule-5 dependency hold. */
export function scoreTaskGraph(graph: TaskGraph): TaskGraphScore {
  const perIssue: TaskGraphIssueScore[] = graph.issues.map(scoreIssue);

  const verdict: FeasibilityVerdict = perIssue.some((s) => s.verdict === "avoid")
    ? "avoid"
    : perIssue.some((s) => s.verdict === "raise")
      ? "raise"
      : "go";
  return { verdict, perIssue };
}

// Weak, transparent type heuristic: a repair of existing broken behavior reads as a bug; anything else is a
// feature. Deliberately conservative — the label is advisory and can be corrected, and it never emits
// `gittensor:priority`.
const BUG_SIGNAL = /\b(?:fix|bug|broken|regression|crash|error|fails?|failing|incorrect|wrong|should\s+(?:not\s+)?(?:retry|handle|return))\b/i;

function inferTypeLabel(text: string): "gittensor:bug" | "gittensor:feature" {
  return BUG_SIGNAL.test(text) ? "gittensor:bug" : "gittensor:feature";
}

/** A renter-reviewed draft of one constituent outcome — the output of the fuzzy decomposition step, fed IN
 *  so the bridge stays deterministic. `feasibility` defaults to a clean `go`-eligible shape when omitted. */
export type ConstituentIssueDraft = {
  key: string;
  title: string;
  body: string;
  dependsOn?: string[] | undefined;
  acceptanceCriteria?: AcceptanceCriterion[] | undefined;
  feasibility?: Partial<FeasibilityGateInput> | undefined;
  labels?: string[] | undefined;
};

function normalizeIssue(idea: IdeaSubmission, draft: ConstituentIssueDraft, index: number): ConstituentIssue {
  const inferred = inferTypeLabel(`${draft.title} ${draft.body}`);
  // Only the two renter-eligible type labels survive; a stray `gittensor:priority` (or anything else) in a
  // draft is dropped so the bridge can never mint a reward label.
  const labels = (draft.labels ?? [inferred]).filter((l) => ALLOWED_ISSUE_TYPE_LABELS.has(l));
  // A draft's own explicit criteria are honored as-is, but the renter's acceptanceHints/constraints must still be
  // folded into the FIRST issue (#7730) rather than silently dropped just because the decomposition happened to
  // supply its own criteria -- the same first-issue fold defaultAcceptanceCriteria applies when there are none.
  const criteria = draft.acceptanceCriteria && draft.acceptanceCriteria.length > 0
    ? [...draft.acceptanceCriteria, ...foldIdeaHintsAndConstraints(idea, draft, index)]
    : defaultAcceptanceCriteria(idea, draft, index);
  return {
    key: draft.key,
    title: draft.title,
    body: draft.body,
    labels: labels.length > 0 ? labels : [inferred],
    dependsOn: draft.dependsOn ?? [],
    acceptanceCriteria: criteria,
    feasibility: {
      claimStatus: draft.feasibility?.claimStatus ?? "unclaimed",
      duplicateClusterRisk: draft.feasibility?.duplicateClusterRisk ?? "none",
      issueStatus: draft.feasibility?.issueStatus ?? "ready",
      found: draft.feasibility?.found ?? true,
    },
  };
}

// Fold the renter's own success signals into criteria: `acceptanceHints` become behavior criteria, hard
// `constraints` become constraint criteria. Only the FIRST issue (index 0) gets them (so a multi-issue graph
// doesn't duplicate them across every issue). Factored out of defaultAcceptanceCriteria so it can also be appended
// to a draft's OWN explicit criteria (#7730) rather than only running on the no-criteria path.
function foldIdeaHintsAndConstraints(
  idea: IdeaSubmission,
  draft: ConstituentIssueDraft,
  index: number,
): AcceptanceCriterion[] {
  if (index !== 0) return [];
  const folded: AcceptanceCriterion[] = [];
  for (const [i, hint] of (idea.acceptanceHints ?? []).entries()) {
    if (hint.trim().length > 0) folded.push({ id: `${draft.key}-hint${i + 1}`, statement: hint, kind: "behavior" });
  }
  for (const [i, c] of (idea.constraints ?? []).entries()) {
    if (c.trim().length > 0) folded.push({ id: `${draft.key}-con${i + 1}`, statement: c, kind: "constraint" });
  }
  return folded;
}

// Every issue is guaranteed at least one behavior criterion; the first issue additionally folds in the renter's
// own hints/constraints (see foldIdeaHintsAndConstraints).
function defaultAcceptanceCriteria(idea: IdeaSubmission, draft: ConstituentIssueDraft, index: number): AcceptanceCriterion[] {
  return [
    { id: `${draft.key}-ac1`, statement: `The outcome described by "${draft.title}" is observable when done`, kind: "behavior" },
    ...foldIdeaHintsAndConstraints(idea, draft, index),
  ];
}

/** Assemble a scored `TaskGraph` from a validated idea and its decomposition (spec §2). Pass `drafts` from
 *  the reviewed freeform decomposition; omit it to get the deterministic single-outcome baseline (a simple
 *  idea → exactly one issue), which is the common case and needs no fuzzy step. */
export function buildTaskGraph(idea: IdeaSubmission, drafts?: ConstituentIssueDraft[]): TaskGraph {
  const source: ConstituentIssueDraft[] =
    drafts && drafts.length > 0 ? drafts : [{ key: "issue-1", title: idea.title, body: idea.body }];
  const issues = source.map((draft, i) => normalizeIssue(idea, draft, i));
  const graph: TaskGraph = { ideaId: idea.id, issues, rubric: { verdict: "go", perIssue: [] } };
  graph.rubric = scoreTaskGraph(graph);
  return graph;
}

/** One constituent issue routed to a loop disposition, carrying the target repo the loop will act on. */
export type ClaimStep = {
  key: string;
  title: string;
  targetRepo: string;
  verdict: FeasibilityVerdict;
  reasons: readonly string[];
};

/** The claim/code/submit-loop hand-off for one idea (#4799): a task-graph, scored, split into what the loop
 *  can claim NOW versus what it must hold or skip. Deterministic and side-effect-free — it decides *what* to
 *  claim and in what order; actually claiming/running is the loop's job. */
export type ClaimPlan = {
  ideaId: string;
  targetRepo: string;
  graphVerdict: FeasibilityVerdict;
  /** `go` issues with no unlanded prerequisite — ready to claim now, in dependency-respecting graph order. */
  claimable: ClaimStep[];
  /** `raise` issues — held until a prerequisite lands or their own quality clears; re-plan after each merge. */
  deferred: ClaimStep[];
  /** `avoid` issues — not claimable as stated (solved, duplicate, or invalid). */
  skipped: ClaimStep[];
};

/** Route a scored task-graph into a loop claim plan (#4799): the deterministic hand-off from idea intake
 *  (#4798) to the claim/code/submit loop. Each issue is dispositioned by its already-computed feasibility
 *  verdict — `go` → claimable, `raise` → deferred, `avoid` → skipped — preserving the graph's own
 *  dependency-respecting order so a prerequisite is always claimed before its dependents. No IO, no claiming. */
export function buildClaimPlan(graph: TaskGraph, target: IdeaTarget | string): ClaimPlan {
  // Accepts either a bare repo string (its historical shape) or an IdeaTarget, so callers threading a
  // submission's `targetRepo` (#7635) need no change. A not-yet-provisioned target has no repo yet, so the
  // plan carries "" -- ClaimStep/ClaimPlan.targetRepo stays a plain string, unchanged for every consumer.
  const targetRepo = typeof target === "string" ? target : target.kind === "existing" ? target.repo : "";
  const claimable: ClaimStep[] = [];
  const deferred: ClaimStep[] = [];
  const skipped: ClaimStep[] = [];
  for (const issue of graph.issues) {
    const scored = scoreIssue(issue);
    const step: ClaimStep = { key: issue.key, title: issue.title, targetRepo, verdict: scored.verdict, reasons: scored.reasons };
    if (scored.verdict === "go") claimable.push(step);
    else if (scored.verdict === "raise") deferred.push(step);
    else skipped.push(step);
  }
  return { ideaId: graph.ideaId, targetRepo, graphVerdict: graph.rubric.verdict, claimable, deferred, skipped };
}
