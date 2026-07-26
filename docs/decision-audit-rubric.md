# Decision-audit rubric — version 1

This rubric governs human adjudication of the weekly decision-audit sample (#8830, epic #8828).
Adjudications are comparable **only within a rubric version**: any change to the criteria below requires
bumping `DECISION_AUDIT_RUBRIC_VERSION` in `src/review/decision-audit.ts` in the same PR, so estimates never
silently mix incompatible labels.

## What is being judged

One question per sampled PR: **was the gate's decision (merge or close) the decision a careful maintainer
would have made, given only what was knowable at decision time?**

- Judge the decision, not the outcome. A merge that later broke something the gate could not have seen is
  still `correct`; a merge that shipped a defect visible in the diff at review time is `incorrect` even if
  nobody noticed.
- Ignore reversal state. "Nobody reversed it" is not evidence of correctness — that bias is exactly what
  this audit exists to measure.
- Use `uncertain` honestly. A genuine judgment call where reasonable maintainers would split is `uncertain`,
  not a coin flip. Uncertain labels are excluded from the accuracy numerator AND denominator and tracked as
  their own rate (a rising uncertain rate is a signal the gate is operating in territory that needs a human).

## Labels

| label | meaning |
|---|---|
| `correct` | The decision was right given decision-time information. |
| `incorrect` | The decision was wrong given decision-time information. |
| `uncertain` | Reasonable maintainers would disagree; no defensible single answer. |

## Reason categories (for `incorrect`, optional otherwise)

- `missed_defect` — merged with a defect visible in the diff.
- `false_block` — closed a PR that met the bar.
- `stale_signal` — decided on out-of-date CI/conflict/issue state.
- `scope_misread` — misjudged linked-issue scope or requirements.
- `policy_misapplied` — an enforcement rule fired on a case it should not cover.
- `salvageable_close` — the defect was real but the PR was salvageable (fixable class, responsive author);
  closing denied a contribution a hold-with-guidance would have landed (#8962). Additive category — the
  correct/incorrect question is unchanged, so rubric version 1 labels remain comparable.
- `other` — anything else; describe in the adjudication notes if used.

## Workflow

1. `GET /v1/internal/audit-labels?status=pending` lists the week's sample.
2. Review each PR **as of its decision time** (the decision record pins head SHA and inputs).
3. `POST /v1/internal/audit-labels/adjudicate` with `{ id, adjudication, reasonCategory? }`.
4. A second adjudication of the same label is rejected (409). Corrections require a new rubric version —
   deliberate, never silent.
