# Contributor pipeline gardening — reference (gittensory / loopover)

## Product shape (so generated issues land in the right place)

Two products, self-host-first:

- **AMS (Autonomous Miner System)** — `packages/gittensory-miner` (npm: `@loopover/miner`) +
  `packages/gittensory-engine` (npm: `@loopover/engine`, shared core also used by ORB) +
  `apps/gittensory-miner-ui` + `apps/gittensory-miner-extension`. The contributor/miner side: finds
  issues, plans, writes code, opens PRs, autonomously. Self-host (a local Miner Node) is the only
  shipped deployment target; hosted AMS is a later phase (see "AMS/ORB Cloud Readiness" below).
- **ORB (Owner/One-shot Review Brain)** — `src/**` (the Worker app: `src/review`, `src/queue`,
  `src/signals`, etc). The maintainer side: automates PR review, merge/close disposition, summaries.
  Self-hosted only today (see `.claude/skills/contributing-to-loopover` / `gittensory-deployment-models`
  equivalent context) — no hosted Orb yet, deliberately, ~1-2 months out at the time of writing.
- Directory names under `packages/` still say `gittensory-*`; only the npm package **names** have
  moved to `@loopover/*` so far (as of 2026-07-14). Check both independently, don't assume one implies
  the other — the repo itself renames `gittensory` → `loopover` on ~2026-07-15; re-verify current
  naming before hardcoding either name into a new issue body.

**Standing priorities named by the maintainer (2026-07-14), not yet issue-backed:**
- **AMS selfhost hardening, round 2.** Miner Wave 4 ("AMS Hardening & Packaging") fully closed
  (151/151) on 2026-07-14 — that backlog is empty, not hiding more maintainer-only work. Getting more
  requires a fresh gap-audit (read the current `packages/gittensory-miner`/`-engine` code against what
  Wave 4 already covered — coverage gate, ledger races, MCP scaffolding — and find what's still
  genuinely thin), not relabeling existing issues.
- **Unified AMS+ORB self-host harness** — letting one operator install/run both products together in
  one system, to "close the loop" as both maintainer and contributor. Searched exhaustively
  (2026-07-14): no existing issue, open or closed, covers this — not verbatim, not conceptually. The
  closest real thread is #4878-#4884 (extracting ORB's core review logic into `gittensory-engine`,
  the same package AMS's miner logic already lives in) — that's the actual prerequisite plumbing, not
  the harness itself. This needs fresh scoping: read the current self-host `docker-compose.yml`
  (already supports optional profiles — `ollama`, `observability`, `postgres`, `rees`, etc.) and design
  how an AMS-miner profile/service could sit alongside it, then file a real epic + sub-issues.

## Milestone taxonomy (as of 2026-07-14 — re-check before trusting, this moves fast)

| Milestone | Nature | Contributor-open? |
|---|---|---|
| `Miner Wave N — <theme>` (no suffix) | A finished or active AMS-hardening-style wave | Mostly yes once released |
| `Miner Wave N — <theme> (maintainer)` | Business/legal/architecture track (currently Wave 5, Rent-a-Loop) | Mostly no — but check individual issues, some concrete implementation sub-tasks are deliberately carved out and unlocked even inside a `(maintainer)`-titled milestone |
| `AMS Cloud Readiness (maintainer)` | Hosted **multi-tenant SaaS** AMS — NOT the same thing as "AMS selfhost hardening" despite the name similarity | Mostly no (architecture/billing/SLA decisions) — a handful of pure research-spike/audit/load-test issues are deliberately contributor-eligible; check labels per-issue |
| `ORB Cloud Readiness (maintainer)` | Same shape, for ORB's hosted SaaS story | Mostly no, same caveat — the first several issues in this milestone (#4878-4884-style, "extract X into gittensory-engine") are often pure refactors miscategorized here, not actually tenant/business-specific — read the body, not just the milestone |
| `ORB - Long Term Features & Improvements` | Grab-bag: some genuine self-host feature/bug work, some product-design epics awaiting maintainer subjective calls | Mixed — read each body |
| `LoopOver Rebrand Migration (maintainer)` | Brand/infra cutover | No |
| Unmilestoned | Orphans | Usually fine to fold into the closest-fitting existing milestone above rather than leave adrift |

**Don't invent a new milestone reflexively.** Only create one when a new body of work genuinely
doesn't fit any existing bucket (the unified-harness epic, once scoped, likely needs its own).

## What's safe to unleash — the actual test

A concrete engineering task is safe to hand to a contributor when:
- It has a clear existing precedent to follow in the codebase (another file/module/pattern already
  does the analogous thing), so "how" isn't itself an open design question.
- It doesn't require a business/product decision (pricing, ToS, what to charge, whether to build a
  feature at all) — those stay `maintainer-only` regardless of how mechanical the code itself would be.
- It doesn't touch trust/safety-critical global state (kill-switches, blacklists/allowlists, the gate's
  own merge/close authority) without a maintainer-reviewed design first — audit/enumerate is fine to
  hand off, the actual fix usually isn't, on the first pass.
- It doesn't require access to something a contributor structurally can't have (a private dedicated
  server's gitignored config, live SaaS-dashboard clicking in a vendor's own UI like Sentry's
  integrations page) — those are maintainer-executed ops tasks, not GitHub issues at all, or need to
  be scoped as "wire the repo-side code that a maintainer will then configure," not "configure the
  live service."
- It doesn't presuppose an undecided architecture question (e.g., don't file 10 issues building out
  Kubernetes/Helm hosted-fleet tooling while "should we build hosted at all, and when" is still
  unresolved) — file the decision-scoping issue first, as `maintainer-only`, and only decompose into
  contributor work once the direction is real.

When genuinely unsure, default to `maintainer-only` — a wrongly-locked issue costs one manual unlock
later; a wrongly-unlocked one costs a contributor's wasted PR and possibly a bad precedent.

## Labels

- `gittensor:bug` — 0.05x multiplier. Bug fixes.
- `gittensor:feature` — 0.25x multiplier. New feature/functionality work, linked to a feature issue.
- `gittensor:priority` — 1.5x multiplier. **Scarce, by explicit convention** — reserved for
  mission-critical or time-sensitive work, applied sparingly (historically ~2 issues at a time out of
  dozens). This is a materially different norm than metagraphed's own convention (see that repo's
  reference doc) — don't cross-pollinate the two repos' label discipline without being asked.
- `help wanted` — always paired alongside a `gittensor:*` label on a newly-unlocked issue (confirmed
  2026-07-14: the maintainer wants this kept, it "enhances visibility" and isn't redundant with the
  points label).
- `maintainer-only` + `roadmap` (paired) — the "held" signal. Remove **both** together when unlocking
  an issue; adding only one without the other is inconsistent with this repo's own convention.
- Never add anything beyond the above to a gardening-generated issue (no `visual`, `orb`, `docker`,
  etc. unless the issue is unambiguously visual/UI, in which case pair `visual` + `gittensor:*` +
  `help wanted` exactly as the existing convention already does for visual bounties).

## Issue body template (Wave-4-batch house style — use for new feature/bug work)

```md
## Context
<what exists today, cite real file paths / function names, why this matters>

## Requirements
<concrete, testable requirements — no "TBD" or "explore options" for anything actually decidable now>

## Deliverables
- [ ] <concrete artifact 1>
- [ ] <concrete artifact 2>

## Test Coverage Requirements
<explicit 99%+ Codecov patch target / 100% target including invariants + a regression test for any
fix — note explicitly if the touched paths are outside coverage.include, e.g. apps/**, so a future
reader isn't confused about why Codecov doesn't gate it>

## Expected Outcome
<what's true after this ships that wasn't true before>

## Links & Resources
<related issues, the files to anchor on>
```

For pure architecture/design/spec issues (the kind that stay `maintainer-only`), use the lighter
Problem/Area/Proposal/Deliverables/Resources/Boundaries shape instead — see any `AMS Cloud Readiness`
issue (e.g. #5215-5230) for the exact pattern. Gardening-generated contributor issues should almost
always be the heavier template; the light one is for issues you're explicitly NOT unlocking.

## Native relationship linking (GraphQL — confirmed working on this repo, 2026-07-14)

Prefer these over a markdown checklist for any new tracker/epic:

```graphql
mutation { addSubIssue(input: { issueId: "<parent node id>", subIssueId: "<child node id>" }) { issue { number } } }
mutation { addBlockedBy(input: { issueId: "<blocked node id>", blockedById: "<blocker node id>" }) { issue { number } } }
```

Get an issue's GraphQL node ID via `gh api graphql -f query='query { repository(owner:"JSONbored", name:"gittensory") { issue(number: N) { id } } }'` (note: literal query strings without file interpolation are fine with `-f`; only the `@file` file-read syntax requires `-F`).

## gh CLI gotchas already hit doing this work

- `gh api graphql -f query=@file.txt` silently fails to read the file — use `-F query=@file.txt`.
- `gh issue close` has no `--comment-file` flag — use `-c "$(cat file.md)"` (double-quoted, so the
  command substitution's output — including any backticks in the comment text — is treated as one
  literal argument, not re-parsed by bash).
- Never embed a body/comment string containing backticks directly inside a `python3 -c "..."`
  double-quoted bash argument — bash attempts command substitution on the backticks before Python
  ever sees them. Write the content to a file with the Write tool first, then read it back via
  `$(cat file)` inside double quotes, or pass `--body-file`/`--comment` reading from that file.
