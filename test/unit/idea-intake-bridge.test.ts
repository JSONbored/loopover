import { describe, expect, it } from "vitest";
import {
  buildClaimPlan,
  buildTaskGraph,
  scoreTaskGraph,
  validateIdeaSubmission,
  IDEA_TITLE_MAX_CHARS,
  IDEA_BODY_MAX_CHARS,
  IDEA_CONSTRAINT_MAX_CHARS,
  type ConstituentIssueDraft,
  type IdeaSubmission,
  type TaskGraph,
} from "../../packages/loopover-engine/src/idea-intake";

function validIdea(overrides: Partial<IdeaSubmission> = {}): IdeaSubmission {
  return { id: "idea-1", title: "One-line intent", body: "A freeform description of the outcome.", targetRepo: { kind: "existing", repo: "acme/widgets" }, ...overrides };
}

// Loose raw input for validateIdeaSubmission(unknown): lets a test pass a bare-string or malformed targetRepo
// (the back-compat wire form) that a strict IdeaSubmission would reject.
function rawIdea(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "idea-1", title: "One-line intent", body: "A freeform description of the outcome.", targetRepo: "acme/widgets", ...overrides };
}

describe("validateIdeaSubmission", () => {
  it("accepts a full, well-formed submission", () => {
    const r = validateIdeaSubmission({
      id: "idea-1", title: "t", body: "b", targetRepo: "owner/name",
      constraints: ["no new dependencies"], acceptanceHints: ["existing callers keep working"], priority: "high",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.idea.priority).toBe("high");
  });

  it("accepts a minimal submission (only required fields)", () => {
    const r = validateIdeaSubmission({ id: "i", title: "t", body: "b", targetRepo: "o/n" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.idea.constraints).toBeUndefined();
  });

  it("treats a non-object input as empty and reports every required field", () => {
    for (const raw of [null, "not-an-object", 42]) {
      const r = validateIdeaSubmission(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toEqual(expect.arrayContaining(["id_required", "title_required", "body_required", "target_repo_required"]));
    }
  });

  it("flags each missing/blank required field", () => {
    const r = validateIdeaSubmission({ id: "  ", title: "", body: "   ", targetRepo: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(expect.arrayContaining(["id_required", "title_required", "body_required", "target_repo_required"]));
  });

  it("flags over-length title and body", () => {
    const r = validateIdeaSubmission(rawIdea({ title: "x".repeat(IDEA_TITLE_MAX_CHARS + 1), body: "y".repeat(IDEA_BODY_MAX_CHARS + 1) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(expect.arrayContaining(["title_too_long", "body_too_long"]));
  });

  it("flags a malformed targetRepo (must be owner/name)", () => {
    expect(validateIdeaSubmission(rawIdea({ targetRepo: "no-slash" })).ok).toBe(false);
    expect(validateIdeaSubmission(rawIdea({ targetRepo: "a/b/c" })).ok).toBe(false);
    expect(validateIdeaSubmission(rawIdea({ targetRepo: "owner/name" })).ok).toBe(true);
  });

  it("resolves a back-compat string targetRepo to an existing target, and accepts a provision object", () => {
    const existing = validateIdeaSubmission(rawIdea({ targetRepo: "owner/name" }));
    expect(existing.ok).toBe(true);
    if (existing.ok) expect(existing.idea.targetRepo).toEqual({ kind: "existing", repo: "owner/name" });

    const provision = validateIdeaSubmission(rawIdea({ targetRepo: { kind: "provision" } }));
    expect(provision.ok).toBe(true);
    if (provision.ok) expect(provision.idea.targetRepo).toEqual({ kind: "provision" });
  });

  it("rejects an object targetRepo that is not a provision request", () => {
    for (const targetRepo of [{}, { kind: "existing" }]) {
      const r = validateIdeaSubmission(rawIdea({ targetRepo }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("target_repo_required");
    }
  });

  it("flags invalid constraints (non-array, non-string element, over-length entry)", () => {
    expect((validateIdeaSubmission(rawIdea({ constraints: "x" as unknown as string[] }))).ok).toBe(false);
    expect((validateIdeaSubmission(rawIdea({ constraints: [1] as unknown as string[] }))).ok).toBe(false);
    const long = validateIdeaSubmission(rawIdea({ constraints: ["c".repeat(IDEA_CONSTRAINT_MAX_CHARS + 1)] }));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors).toContain("constraint_too_long");
    expect(validateIdeaSubmission(rawIdea({ constraints: ["ok"] })).ok).toBe(true);
  });

  it("flags invalid acceptanceHints and an invalid priority", () => {
    expect(validateIdeaSubmission(rawIdea({ acceptanceHints: "x" as unknown as string[] })).ok).toBe(false);
    expect(validateIdeaSubmission(rawIdea({ acceptanceHints: [2] as unknown as string[] })).ok).toBe(false);
    expect(validateIdeaSubmission(rawIdea({ priority: "urgent" as unknown as IdeaSubmission["priority"] })).ok).toBe(false);
    expect(validateIdeaSubmission(rawIdea({ priority: "normal" })).ok).toBe(true);
  });

  it("caps acceptanceHints entry length at IDEA_CONSTRAINT_MAX_CHARS, same bound as constraints (#7243)", () => {
    const atCap = validateIdeaSubmission(rawIdea({ acceptanceHints: ["h".repeat(IDEA_CONSTRAINT_MAX_CHARS)] }));
    expect(atCap.ok).toBe(true);

    const overCap = validateIdeaSubmission(rawIdea({ acceptanceHints: ["h".repeat(IDEA_CONSTRAINT_MAX_CHARS + 1)] }));
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.errors).toContain("acceptance_hint_too_long");
  });

  it("does not raise acceptance_hint_too_long for a malformed (non-array) acceptanceHints — shape error only", () => {
    const r = validateIdeaSubmission(rawIdea({ acceptanceHints: "x".repeat(IDEA_CONSTRAINT_MAX_CHARS + 1) as unknown as string[] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("acceptance_hints_invalid");
      expect(r.errors).not.toContain("acceptance_hint_too_long");
    }
  });

  it("collects an over-length acceptanceHints entry alongside other unrelated errors in one pass", () => {
    const r = validateIdeaSubmission({
      title: "t",
      body: "b",
      targetRepo: "o/n",
      acceptanceHints: ["h".repeat(IDEA_CONSTRAINT_MAX_CHARS + 1)],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(expect.arrayContaining(["id_required", "acceptance_hint_too_long"]));
  });
});

describe("buildTaskGraph — spec §4 Example A (simple idea → one issue → go)", () => {
  const idea = validIdea({
    id: "idea-A", title: "Retry flaky uploads",
    body: "Our upload client gives up on the first 5xx; it should retry a few times before failing.",
    constraints: ["no new dependencies"],
  });

  it("produces exactly one constituent issue with verdict go", () => {
    const g = buildTaskGraph(idea);
    expect(g.ideaId).toBe("idea-A");
    expect(g.issues).toHaveLength(1);
    expect(g.issues[0]?.key).toBe("issue-1");
    expect(g.issues[0]?.dependsOn).toEqual([]);
    expect(g.rubric.verdict).toBe("go");
  });

  it("infers a bug label from repair-of-broken-behavior wording", () => {
    expect(buildTaskGraph(idea).issues[0]?.labels).toEqual(["gittensor:bug"]);
  });

  it("folds a renter constraint into a constraint acceptance criterion (issue-1 only)", () => {
    const criteria = buildTaskGraph(idea).issues[0]?.acceptanceCriteria ?? [];
    expect(criteria.some((c) => c.kind === "behavior")).toBe(true);
    expect(criteria.some((c) => c.kind === "constraint" && c.statement === "no new dependencies")).toBe(true);
  });

  it("treats an empty drafts array the same as none (single-issue baseline)", () => {
    expect(buildTaskGraph(idea, []).issues).toHaveLength(1);
  });
});

describe("buildTaskGraph — spec §4 Example B (multi-step idea → dependency chain → raise)", () => {
  const idea = validIdea({
    id: "idea-B", title: "Add API key auth to the public endpoints",
    body: "Let callers authenticate the read API with an API key instead of leaving it open.",
    acceptanceHints: ["existing callers keep working during rollout"],
  });
  const drafts: ConstituentIssueDraft[] = [
    { key: "issue-1", title: "Introduce API-key store + validation helper", body: "A valid key validates; an unknown key is rejected." },
    { key: "issue-2", title: "Gate the read endpoints behind key validation", body: "Requests with a valid key succeed.", dependsOn: ["issue-1"] },
  ];

  it("orders by dependsOn and holds the dependent issue at raise until its prerequisite lands", () => {
    const g = buildTaskGraph(idea, drafts);
    expect(g.issues.map((i) => i.key)).toEqual(["issue-1", "issue-2"]);
    expect(g.rubric.perIssue.find((s) => s.key === "issue-1")?.verdict).toBe("go");
    const dep = g.rubric.perIssue.find((s) => s.key === "issue-2");
    expect(dep?.verdict).toBe("raise");
    expect(dep?.reasons).toContain("dependency_not_landed");
    expect(g.rubric.verdict).toBe("raise"); // graph = least-favorable
    expect(g.issues[0]?.labels).toEqual(["gittensor:feature"]);
  });

  it("folds acceptanceHints into the first issue only, not every issue", () => {
    const g = buildTaskGraph(idea, drafts);
    const i1 = g.issues[0]?.acceptanceCriteria ?? [];
    const i2 = g.issues[1]?.acceptanceCriteria ?? [];
    expect(i1.some((c) => c.statement === "existing callers keep working during rollout")).toBe(true);
    expect(i2.some((c) => c.statement === "existing callers keep working during rollout")).toBe(false);
  });
});

describe("buildTaskGraph — normalization details", () => {
  const idea = validIdea();

  it("keeps an explicit draft acceptanceCriteria AND folds in the first issue's hints/constraints (#7730), and drops a non-eligible label", () => {
    // The renter's hints/constraints must still be represented on issue-0 rather than silently dropped just
    // because the first draft also supplied its own explicit criteria.
    const ideaWithSignals = validIdea({
      acceptanceHints: ["existing callers keep working"],
      constraints: ["no new dependencies"],
    });
    const g = buildTaskGraph(ideaWithSignals, [{
      key: "issue-1", title: "Add a widget", body: "new capability",
      labels: ["gittensor:feature", "gittensor:priority"],
      acceptanceCriteria: [{ id: "x", statement: "explicit", kind: "artifact" }],
    }]);
    const criteria = g.issues[0]?.acceptanceCriteria ?? [];
    expect(criteria[0]).toEqual({ id: "x", statement: "explicit", kind: "artifact" }); // explicit criterion kept, first
    expect(criteria.some((c) => c.statement === "existing callers keep working" && c.kind === "behavior")).toBe(true);
    expect(criteria.some((c) => c.statement === "no new dependencies" && c.kind === "constraint")).toBe(true);
    expect(g.issues[0]?.labels).toEqual(["gittensor:feature"]); // gittensor:priority stripped
  });

  it("falls back to the inferred label when a draft's labels are all non-eligible", () => {
    const g = buildTaskGraph(idea, [{ key: "issue-1", title: "Fix the broken parser", body: "it crashes", labels: ["gittensor:priority"] }]);
    expect(g.issues[0]?.labels).toEqual(["gittensor:bug"]);
  });

  it("applies feasibility defaults when a draft supplies only a partial feasibility", () => {
    const g = buildTaskGraph(idea, [{ key: "issue-1", title: "t", body: "b", feasibility: { claimStatus: "claimed" } }]);
    expect(g.issues[0]?.feasibility).toEqual({ claimStatus: "claimed", duplicateClusterRisk: "none", issueStatus: "ready", found: true });
    expect(g.rubric.verdict).toBe("raise"); // claimed → raise
  });

  it("skips blank hint/constraint entries", () => {
    const g = buildTaskGraph(validIdea({ acceptanceHints: ["  "], constraints: [""] }));
    expect(g.issues[0]?.acceptanceCriteria).toHaveLength(1); // only the default behavior criterion
  });

  it("folds hints/constraints into the FIRST draft's explicit criteria but not a later draft's (#7730)", () => {
    const withSignals = validIdea({ acceptanceHints: ["callers keep working"], constraints: ["no new deps"] });
    const g = buildTaskGraph(withSignals, [
      { key: "issue-1", title: "First", body: "b", acceptanceCriteria: [{ id: "a", statement: "first-explicit", kind: "artifact" }] },
      {
        key: "issue-2",
        title: "Second",
        body: "b",
        dependsOn: ["issue-1"],
        acceptanceCriteria: [{ id: "b", statement: "second-explicit", kind: "artifact" }],
      },
    ]);
    const first = g.issues[0]?.acceptanceCriteria ?? [];
    const second = g.issues[1]?.acceptanceCriteria ?? [];
    // Issue 0: explicit criterion first, then the renter's hint + constraint folded in.
    expect(first[0]).toEqual({ id: "a", statement: "first-explicit", kind: "artifact" });
    expect(first.some((c) => c.statement === "callers keep working" && c.kind === "behavior")).toBe(true);
    expect(first.some((c) => c.statement === "no new deps" && c.kind === "constraint")).toBe(true);
    // Issue 1 (index > 0): only its own explicit criterion — hints/constraints are NOT duplicated onto it.
    expect(second).toEqual([{ id: "b", statement: "second-explicit", kind: "artifact" }]);
  });
});

describe("scoreTaskGraph — graph verdict is the least-favorable across issues", () => {
  function graphOf(...feas: ConstituentIssueDraft[]): TaskGraph {
    return buildTaskGraph(validIdea(), feas);
  }

  it("is go when every issue is go", () => {
    expect(scoreTaskGraph(graphOf({ key: "issue-1", title: "t", body: "b" })).verdict).toBe("go");
  });

  it("is avoid when any issue avoids, even alongside go issues", () => {
    const g = graphOf(
      { key: "issue-1", title: "t", body: "b" },
      { key: "issue-2", title: "t2", body: "b2", feasibility: { issueStatus: "invalid" } },
    );
    const s = scoreTaskGraph(g);
    expect(s.perIssue.find((x) => x.key === "issue-2")?.verdict).toBe("avoid");
    expect(s.verdict).toBe("avoid");
  });

  it("is raise when an issue raises but none avoids", () => {
    const g = graphOf({ key: "issue-1", title: "t", body: "b", feasibility: { duplicateClusterRisk: "medium" } });
    expect(scoreTaskGraph(g).verdict).toBe("raise");
  });

  it("keeps an avoid issue at avoid even when it also carries a dependsOn", () => {
    const g = graphOf(
      { key: "issue-1", title: "t", body: "b" },
      { key: "issue-2", title: "t2", body: "b2", dependsOn: ["issue-1"], feasibility: { issueStatus: "invalid" } },
    );
    expect(scoreTaskGraph(g).perIssue.find((x) => x.key === "issue-2")?.verdict).toBe("avoid");
  });
});

describe("buildClaimPlan — routes a scored task-graph into a loop claim plan (#4799)", () => {
  const idea = validIdea({ id: "idea-C" });

  it("accepts a bare repo string and an IdeaTarget, and carries \"\" for a not-yet-provisioned target", () => {
    const graph = buildTaskGraph(idea, [{ key: "issue-1", title: "Add widget", body: "new" }]);
    // bare string (historical shape), existing IdeaTarget, and a provision target all resolve correctly.
    expect(buildClaimPlan(graph, "acme/widgets").targetRepo).toBe("acme/widgets");
    expect(buildClaimPlan(graph, { kind: "existing", repo: "acme/widgets" }).targetRepo).toBe("acme/widgets");
    expect(buildClaimPlan(graph, { kind: "provision" }).targetRepo).toBe("");
  });

  it("puts a lone go issue in claimable, carrying the target repo", () => {
    const plan = buildClaimPlan(buildTaskGraph(idea, [{ key: "issue-1", title: "Add widget", body: "new" }]), idea.targetRepo);
    expect(plan.ideaId).toBe("idea-C");
    expect(plan.targetRepo).toBe("acme/widgets");
    expect(plan.graphVerdict).toBe("go");
    expect(plan.claimable.map((s) => s.key)).toEqual(["issue-1"]);
    expect(plan.claimable[0]?.targetRepo).toBe("acme/widgets");
    expect(plan.deferred).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it("splits go/raise/avoid across claimable/deferred/skipped in dependency order", () => {
    const graph = buildTaskGraph(idea, [
      { key: "issue-1", title: "Ready", body: "b" }, // go -> claimable
      { key: "issue-2", title: "Held", body: "b", dependsOn: ["issue-1"] }, // raise (dep not landed) -> deferred
      { key: "issue-3", title: "Unshippable", body: "b", feasibility: { issueStatus: "invalid" } }, // avoid -> skipped
    ]);
    const plan = buildClaimPlan(graph, idea.targetRepo);
    expect(plan.claimable.map((s) => s.key)).toEqual(["issue-1"]);
    expect(plan.deferred.map((s) => s.key)).toEqual(["issue-2"]);
    expect(plan.deferred[0]?.reasons).toContain("dependency_not_landed");
    expect(plan.skipped.map((s) => s.key)).toEqual(["issue-3"]);
    expect(plan.graphVerdict).toBe("avoid"); // least-favorable across the graph
  });
});
