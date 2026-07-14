# Idea-intake bridge schema

Product spec for **#4779**. Defines the interface that turns a freeform human idea into something the loop
mechanics can execute against, so a person renting a loop does not have to hand-translate their intent into a
well-formed, claimable issue. It is the input contract the feasibility scoring adapted in **#5671** reads, and
the upstream boundary for the Rent-a-Loop execution path.

This is a written spec only — no code is implemented here. It defines (1) the **idea submission schema**, (2) the
**translation rules** from an idea to a structured, claimable task-graph, (3) the **scoring rubric** the execution
loop evaluates its own output against, and (4) two worked examples traced end-to-end.

## Design constraints (why the shape below)

- **Reuse the existing feasibility gate, don't reinvent it.** `packages/loopover-engine/src/feasibility.ts`
  already reduces a candidate to a `go` / `raise` / `avoid` verdict over three discriminants
  (`claimStatus`, `duplicateClusterRisk`, `issueStatus`) with `avoid > raise > go` precedence. The idea bridge
  must produce, per constituent issue, exactly those discriminants so the adapted freeform scoring (#5671) can
  call the same `buildFeasibilityVerdict` without a parallel decision path.
- **Emit the shape the loop already runs on.** Each constituent issue must translate into the fields the coding
  loop already consumes — a title, a body, `labels`, `linkedIssues`, and an acceptance-criteria artifact — so the
  bridge output drops straight into the existing claim → analyze → execute flow.
- **Freeform in, structured out, human-auditable at the seam.** The idea is natural language; the task-graph is
  strict. The translation is the only fuzzy step, so it is explicit, bounded, and always reviewable before any
  loop claims work.

## 1. Idea submission schema

An `IdeaSubmission` is the raw input a renter provides.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Stable idea identifier (bridge-assigned). |
| `title` | string | yes | One-line intent. Bounded (≤ 120 chars). |
| `body` | string | yes | Freeform description of the desired outcome. Bounded + public-safe (no secrets). |
| `targetRepo` | string | yes | `owner/name` the loop will act on. Must be an installed, registered repo. |
| `constraints` | string[] | no | Renter-stated musts/must-nots (e.g. "no new dependencies", "keep the public API stable"). |
| `acceptanceHints` | string[] | no | Renter's own success signals, folded into per-issue acceptance criteria. |
| `priority` | `"normal" \| "high"` | no | Advisory only. Never maps to `gittensor:priority` (that label is maintainer-propagated, never renter-set). |

Rules:
- `title`/`body`/each `constraints[]` entry are length-bounded and stripped of anything non-public-safe at intake,
  mirroring the manifest text-slot handling in `focus-manifest.ts`.
- `targetRepo` that is not installed+registered is rejected at intake, not scored — an uninstallable repo can
  never produce a `go`.

## 2. Translation rules — idea → task-graph

The bridge deterministically expands one `IdeaSubmission` into a `TaskGraph`.

```
TaskGraph {
  ideaId: string
  issues: ConstituentIssue[]         // ≥ 1, topologically ordered by dependsOn
  rubric: ScoringRubric              // see §3
}

ConstituentIssue {
  key: string                        // stable within the graph, e.g. "issue-1"
  title: string                      // becomes the issue/PR title
  body: string                       // becomes the issue/PR body
  labels: string[]                   // gittensor:bug | gittensor:feature (type), never gittensor:priority
  dependsOn: string[]                // keys of issues that must land first
  acceptanceCriteria: AcceptanceCriterion[]   // ≥ 1
  feasibility: FeasibilityGateInput  // the discriminants §3 scores — { claimStatus, duplicateClusterRisk, issueStatus, found }
}

AcceptanceCriterion {
  id: string
  statement: string                  // testable, behavior-level ("uploads retry on 5xx"), not implementation-level
  kind: "behavior" | "artifact" | "constraint"
}
```

Translation rules:
1. **Decompose by independently-shippable outcome.** Each `ConstituentIssue` is a unit that can be claimed,
   executed, and merged on its own. A multi-step idea becomes several issues linked by `dependsOn`; a simple idea
   becomes exactly one.
2. **Every issue carries testable acceptance criteria.** Criteria are behavior-level and implementation-agnostic —
   they describe *what* is true when done, never *how*. Renter `acceptanceHints` and `constraints` fold in as
   `artifact`/`constraint` criteria.
3. **Type labels are inferred, priority is never.** An issue gets `gittensor:bug` or `gittensor:feature` from its
   outcome; `gittensor:priority` is never emitted by the bridge (it is maintainer-propagated only).
4. **Each issue is pre-scored for feasibility** by populating `feasibility` (§3), so the loop can gate before
   claiming rather than after wasting an attempt.
5. **Ordering respects `dependsOn`.** An issue whose dependency has not landed is held (`raise`), never claimed
   ahead of its prerequisite.

## 3. Scoring rubric

The rubric is the existing feasibility gate applied per constituent issue. The freeform-scoring work in #5671
maps idea/issue text onto the three discriminants; this spec fixes what those discriminants mean for an idea so
the mapping is stable:

| Discriminant | Idea-bridge meaning | Verdict effect (per `feasibility.ts`) |
|---|---|---|
| `issueStatus = ready` | criteria are testable, scope is a single shippable outcome, no blocking prerequisite open | eligible for `go` |
| `issueStatus = needs_proof` / `hold` | outcome under-specified, or a `dependsOn` prerequisite not yet landed | `raise` (`issue_quality_uncertain`) |
| `issueStatus = invalid` / `do_not_use` | not implementable as stated, or violates a hard constraint/guarded surface | `avoid` |
| `duplicateClusterRisk = high` | outcome duplicates an existing open issue/PR cluster | `avoid` (`duplicate_cluster_high`) |
| `duplicateClusterRisk = medium` | overlaps an existing effort but not identical | `raise` |
| `claimStatus = claimed` | an equivalent issue is already claimed by another loop | `raise` (`claim_status_claimed`) |
| `claimStatus = solved` | the outcome already exists on the default branch | `avoid` (`claim_status_solved`) |
| `found = false` | the bridge could not resolve a concrete target for this issue | `raise` (`target_not_found`) |

The graph-level disposition is the **least-favorable** verdict across its issues (`avoid` if any issue avoids,
else `raise` if any raises, else `go`) — a renter should not be told "go" while any constituent is unshippable.
Precedence (`avoid > raise > go`) is inherited unchanged from `buildFeasibilityVerdict`, so the bridge adds no
second decision surface.

## 4. Worked examples

### Example A — simple idea (single issue)

**Idea:** `{ title: "Retry flaky uploads", body: "Our upload client gives up on the first 5xx; it should retry a
few times before failing.", targetRepo: "acme/widgets", constraints: ["no new dependencies"] }`

**Task-graph:**
- `issue-1` — title *"Uploads should retry on 5xx"*, labels `[gittensor:bug]`, `dependsOn: []`
  - AC1 (behavior): a 5xx upload response triggers a bounded retry before surfacing an error
  - AC2 (behavior): a non-5xx (e.g. 4xx) failure is **not** retried
  - AC3 (constraint): no new runtime dependency is added
  - `feasibility`: `{ claimStatus: "unclaimed", duplicateClusterRisk: "none", issueStatus: "ready", found: true }`
- **rubric →** `buildFeasibilityVerdict(issue-1.feasibility)` = **`go`**. Graph verdict = `go`. One claimable issue
  drops straight into the loop.

### Example B — multi-step idea (dependency chain)

**Idea:** `{ title: "Add API key auth to the public endpoints", body: "Let callers authenticate the read API with
an API key instead of leaving it open.", targetRepo: "acme/widgets", acceptanceHints: ["existing callers keep
working during rollout"] }`

**Task-graph (ordered by `dependsOn`):**
- `issue-1` — *"Introduce API-key store + validation helper"*, labels `[gittensor:feature]`, `dependsOn: []`
  - AC1 (behavior): a valid key validates; an unknown/expired key is rejected
  - AC2 (artifact): keys are stored hashed, never in plaintext
  - `feasibility`: `{ claimStatus: "unclaimed", duplicateClusterRisk: "none", issueStatus: "ready", found: true }` → `go`
- `issue-2` — *"Gate the read endpoints behind key validation"*, labels `[gittensor:feature]`, `dependsOn: ["issue-1"]`
  - AC1 (behavior): a request with a valid key succeeds; without one is rejected
  - AC2 (constraint, from `acceptanceHints`): a documented grace/rollout path keeps existing callers working
  - `feasibility`: `{ claimStatus: "unclaimed", duplicateClusterRisk: "none", issueStatus: "hold", found: true }`
    — `hold` because `issue-1` has not landed → **`raise`** (`issue_quality_uncertain`)
- **rubric →** graph verdict = least-favorable = **`raise`**: `issue-1` is claimable now (`go`), `issue-2` is
  correctly held until its prerequisite lands, then re-scores to `go`.

## Acceptance-criteria checklist (per #4779)

- [x] Input schema for an idea submission — §1.
- [x] Translation rules idea → structured, claimable task-graph (constituent issues, per-issue acceptance
      criteria, scoring rubric) — §2, §3.
- [x] At least two fully worked examples (one simple, one multi-step) traced end-to-end — §4.
- [x] Concrete enough for the freeform feasibility scoring (#5671) to implement against — the rubric maps idea
      text onto the exact `FeasibilityGateInput` discriminants `buildFeasibilityVerdict` already consumes.
