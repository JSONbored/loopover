---
name: contributor-pipeline-gardening
description: >-
  Maintenance of the contributor issue pipeline for JSONbored/loopover —
  closing issues that are already done but not marked so, and keeping the contributor-available
  backlog at its 50-100+ steady-state floor with well-scoped new issues. Runs every ~8h via the
  scheduled task (raised from daily on 2026-07-15 so the floor is maintained continuously, not
  caught up once a day). Invoke for "run the issue gardening", "audit open issues for
  stale/complete ones", "generate new contributor issues", or any recurring/scheduled run of this
  process. `reference.md` (next to this file) has the exhaustive label/milestone/template detail —
  read it before doing real work, not just this file.
---

# Contributor pipeline gardening — loopover

This repo runs on a **steady stream of well-scoped, correctly-labeled issues** for contributors —
see `.claude/skills/contributing-to-loopover/`. Contributors can only open a PR that links a real,
open, non-`maintainer-only` issue carrying a `gittensor:*` label. If the pipeline runs dry or fills
up with stale duplicates, contributors have nothing real to do. This skill is the daily job that
keeps the pipeline honest: **close what's actually done, keep the backlog stocked with what
genuinely isn't.**

Every run does two independent passes. Do the stale sweep FIRST — it changes what "the backlog is
short" even means, so top-up sizing is only accurate after the sweep.

## Pass 1 — stale-issue sweep (do this first, every run)

**The failure mode this catches:** a PR merges and actually finishes an issue's work, but the PR
body says "Advances #NNNN" or just mentions "(#NNNN)" instead of "Closes #NNNN" — a deliberate
non-closing reference when real work remains, but sometimes just a missed keyword when the work
was actually finished. GitHub never auto-closes on a bare reference either way, so the issue sits
open indefinitely looking like backlog when it isn't. This has already happened repeatedly in this
repo (a whole "HELD tracker" milestone with 47/48 items silently done, several individual issues) —
assume it keeps happening, don't assume today's backlog is clean.

**Verify against synced upstream, not a stale local checkout.** Before treating any local grep/read
as evidence that an issue's described work does or doesn't exist, confirm the code you're reading
matches the default branch's current tip — fetch and fast-forward the checkout (or use a disposable
worktree off `origin/main` if the primary checkout is dirty or has unpushed work on another branch)
before doing any verification. A checkout that's merely _clean_ isn't the same as _current_ — a
stale-but-clean checkout silently produced false "already done"/"not done" conclusions here and in a
sibling repo's gardening run on 2026-07-17/18, causing duplicate issues to be filed for already-shipped
work. Confirm sync every run; never assume a previous run's freshness carried over.

**Method — GitHub's cross-reference timeline, not text search:**

1. Pull the full open-issue list: `gh issue list --repo JSONbored/loopover --state open --limit 1000 --json number,title,labels,milestone,createdAt`.
2. For every open issue, query which merged PRs ever referenced it, via GraphQL `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT])` → `source { ... on PullRequest { number state merged } }` and `willCloseTarget`. Batch in chunks of ~20 issues per query using aliases (`i1234: issue(number: 1234) { ... }`) to stay under complexity limits.
   - **Important CLI gotcha:** `gh api graphql -f query=@file` does NOT read from a file — `-f` treats `@file` as a literal string and the query fails with a cryptic parse error. Use **`-F query=@file`** (capital F) instead; only `-F`/`--field` supports the `@filename` file-read syntax.
3. Any issue where `willCloseTarget=true` on a merged PR but the issue is still open is worth a first look (should have auto-closed and didn't — check why, e.g. merged to a non-default branch). In practice this repo hasn't produced any of these yet; don't assume it stays that way.
4. Any issue with at least one merged-PR reference and `willCloseTarget=false` is the real target list. For each: **read the actual PR body**, not just its title. Three outcomes:
   - The PR body says or clearly implies the issue's full scope is done → close the issue (`gh issue close <n> --reason completed --comment "..."`) with a comment naming the PR(s) and, where possible, a direct code check (grep for the file/function/route the issue described) confirming it actually exists. Never close on title-similarity alone — verify against the real diff/body.
   - The PR body explicitly says it's a partial/narrower fix (look for phrasing like "narrower fix," "part 1 of," "does not build the full X," "Advances #N... not forgotten") → leave the issue open. If useful, add a short comment noting what's already shipped so a contributor doesn't duplicate it.
   - Ambiguous → default to leaving it open; a false-open costs nothing, a false-close wastes a contributor's time and erodes trust in the label.
5. If the issue is itself a "tracker" (a markdown checklist of child issue numbers — search open issues for "tracker" or a checklist body), check every child's real state and update the checkboxes to match reality. Only close the tracker itself if literally every child is done; otherwise just fix the checklist and leave it open.
6. **Migrate away from markdown-checklist trackers going forward.** This repo has native GitHub sub-issues and blocked-by relationships available (confirmed via GraphQL: `addSubIssue`, `addBlockedBy` mutations both work on this repo) — use those for any NEW tracker/epic instead of a hand-maintained checklist, so a child's close is reflected automatically instead of silently drifting. See `reference.md` for the exact mutations.

## Pass 2 — backlog top-up

**Target: keep this repo's own contributor-available count (unassigned, no `maintainer-only`, carries a `gittensor:*` label) at 50-100+, AT ALL TIMES, independently of metagraphed's count** — this is a steady-state floor to maintain continuously, not a one-time catch-up, and NOT a combined/shared pool across the two repos; each repo needs its own 50-100+ on its own goals. Compute it fresh: `gh issue list --state open --limit 1000 --json number,labels,assignees` and filter.

**If the count is meaningfully under floor, keep sourcing issues until it clears (or a pass genuinely turns up no more real, non-duplicate gaps) — don't stop at a modest first batch.** "Quality over volume" (point 6 below) means don't pad with weak/duplicate/vague issues, it does not mean stopping early once _a_ well-scoped batch is filed. When under floor: extend an already-proven, well-precedented vein first if one exists (e.g. a REST/GraphQL/MCP parity sweep with many remaining candidates — the fastest path to more verified, non-padded issues), then dispatch parallel subsystem-audit agents across distinct areas of the codebase once that's exhausted.

1. **Read `reference.md`'s "what's safe to unleash" framework first.** The single most common mistake is generating architecture/business-decision issues (hosted multi-tenant SaaS design, billing, SLAs, pricing) that must stay `maintainer-only` — this repo has ~90 such issues already correctly gated and the automation must not erode that boundary. Concrete engineering work with a clear existing precedent to follow is the target; open-ended product/business decisions are not. **Never remove `maintainer-only` from an existing issue as part of routine gardening** — see reference.md's "Never unlock an existing `maintainer-only` issue" section; this already happened once (2026-07-21) and let 3 contributor PRs merge into kill-switch/provisioning/tenant-billing surfaces before it was caught.
2. Pick real gaps to scope from, in priority order:
   - Existing open epics/roadmap issues in this repo that don't yet have enough decomposed child issues to be actionable (e.g. `ORB - Long Term Features & Improvements`, the review-comment-redesign family, any epic whose own body describes scope with no filed sub-issues yet).
   - Genuine gaps found by reading the current codebase against a shipped feature's own stated acceptance criteria (the same technique Pass 1 uses to verify closure — used here in reverse, to find what's NOT yet done).
   - AMS selfhost hardening is a named standing priority — see `reference.md`. The unified AMS+ORB selfhost harness is now scoped and issue-backed (#5996, epic #6012) as of 2026-07-15 — check its sub-issues' completion state before assuming this still needs fresh scoping.
3. **Every new issue gets a real milestone — no issue ships unmilestoned.** Default to the correct existing milestone (see `reference.md`'s milestone taxonomy). Creating a new one requires a genuinely-unfitting body of work AND is a much higher bar than it sounds — see `reference.md`'s milestone-discipline note; when in doubt, fold into the closest existing bucket and say so. A new milestone is justified when nothing existing fits AND the work is either a real major initiative or a recurring category that will keep needing a home (e.g. `Miner Wave 4.5 — AMS Hardening Round 2`, created 2026-07-15 for the recurring post-Wave-4 gap-audit rounds this skill files each run) — a one-off oddity alone isn't enough. Also apply a `gittensor:bug` (0.05x), `gittensor:feature` (0.25x), or `gittensor:priority` (1.5x, reserved for mission-critical/time-sensitive work only — this repo uses it sparingly, unlike metagraphed's looser convention, see `reference.md`) label, plus `help wanted` (the maintainer confirmed this stays as a visibility signal alongside the points label, not a replacement for one).
4. Every new issue body follows the template in `reference.md` — Context, Requirements, Deliverables, Test Coverage Requirements (this repo's Codecov patch gate is 99%+, hard — every new issue implicitly inherits this unless it's `apps/**`-only UI work), Expected Outcome. No "left to interpretation" scope — the maintainer's own stated preference is that thin/ambiguous issue bodies are worse than fewer, complete ones. **The review gate only enforces what the issue text explicitly says** — see `reference.md`'s dedicated section on this; any deliverable with a file-type/path/format constraint (docs as website pages vs. markdown, native relationships vs. checklists, etc.) needs that constraint stated as an explicit, standalone rule, not left implied by Context.
5. **Check every new batch for real relationships, then link them with GitHub's native features, not prose or a checklist:** `addSubIssue` to attach a new issue under its parent epic, `addBlockedBy` when an issue genuinely cannot start before another lands. The check itself is the discipline — most independent bug-fix/feature-parity issues (e.g. a batch of REST/GraphQL-mirror additions) genuinely have no dependency on each other, and forcing a link where none exists is worse than no link. Only connect issues where a contributor would actually be blocked or misled by working them out of order.
6. Quality over the number in what gets filed — don't pad with weak, duplicate, or vaguely-scoped issues just to hit a count. This is NOT license to stop early: if the repo is meaningfully under the 50-100 floor, keep sourcing real, well-scoped issues (see the "if under floor" note above) until it clears or a pass genuinely turns up nothing left to scope — only then note a shortfall in the digest.

## Pass 3 — Strategic epic/milestone health (once-per-day cadence)

Pass 1/2 above are the issue-level hygiene loop; Pass 3 is a once-per-day layer on top of it that
looks at whether the _epics and milestones themselves_ still make sense, and actively sources new
feature/milestone-level work from the product's own direction rather than only reacting to what's
already shipped. The scheduling automation gates it to at most once per day independent of the outer
job's own firing cadence (currently 8h) — an external cadence tracker in the scheduling layer handles
the actual gate, not this file.

**When it runs:**

1. Enumerate active epics/roadmap issues (the `roadmap` label, "Epic:" in the title, checklist-shaped
   issues, native sub-issue parents — e.g. `ORB - Long Term Features & Improvements`, the AMS+ORB
   self-host harness epic #6012). Verify every claimed child is actually filed and in the right state
   (GraphQL cross-reference, mirror Pass 1's method, not text search). Surface now-unblocked follow-on
   work when a previously-blocking issue closes.
2. **Source real forward-looking work, not just verify.** Read each active epic/milestone's own
   stated scope, the current codebase (`packages/loopover-miner`, `packages/loopover-engine`,
   `src/**`), and repo docs to find concrete, buildable feature or milestone-scoped work that hasn't
   been filed yet — grounded in the product as it exists and the milestone's documented direction, not
   speculative ideas untethered from evidence (the same gap-audit technique Pass 2 already uses, in
   reverse).
3. **Pass 3 shares Pass 2's own 50-100+ (push toward 100+) contributor-available target — one
   combined per-run volume goal, not a separate small quota** (revised 2026-07-17; an earlier version
   of this pass capped itself at "0-2 issues/day, zero is fine," which under-delivered). If Pass 2
   already reached the target, Pass 3 doesn't need to force more; if the count is still under-target
   after Pass 2, Pass 3 should actively help close the gap with real feature/milestone issues rather
   than sitting in verify-only mode. Quality still matters (don't pad with weak/duplicate/vague
   issues, and every new issue must still meet this repo's Codecov/test-coverage bar in its own
   Requirements) — but that's not license to under-deliver: a pass that can't find enough real work
   should say so explicitly in the digest (what was tried, why nothing else was fileable), not quietly
   file 1-2 and call it done.
4. Respect the same "what's safe to unleash" test as Pass 2 — pure business/product decisions
   (pricing, ToS, hosted multi-tenant architecture calls) stay `maintainer-only` regardless of how
   mechanical the underlying code would be. Anything that's genuinely competitive-strategy/
   monetization thinking rather than buildable product work stays out of public issues entirely — flag
   it in the digest for the maintainer's private roadmap instead of filing it.
5. Link every new issue as a native sub-issue of its parent epic via `addSubIssue` where a real parent
   exists; give it a real milestone (same milestone-discipline bar as Pass 2 — a new milestone needs a
   genuinely major initiative or recurring category, not a one-off).

## Daily digest

End every run with a short summary (issues closed with why, checklists fixed, new issues filed with
milestone/label — Pass 2 and Pass 3 combined, whether Pass 3 ran this cycle, current
contributor-available count before/after, anything ambiguous that was left alone on purpose). This is
the user's only visibility into a fully-autonomous run — make it readable in under a minute.
