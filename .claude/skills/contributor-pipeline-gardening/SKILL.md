---
name: contributor-pipeline-gardening
description: >-
  Daily maintenance of the contributor issue pipeline for JSONbored/gittensory (renaming to
  loopover) — closing issues that are already done but not marked so, and topping up the
  contributor-available backlog with well-scoped new issues. Invoke for "run the daily issue
  gardening", "audit open issues for stale/complete ones", "generate new contributor issues",
  or any recurring/scheduled run of this process. `reference.md` (next to this file) has the
  exhaustive label/milestone/template detail — read it before doing real work, not just this file.
---

# Contributor pipeline gardening — gittensory / loopover

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

**Method — GitHub's cross-reference timeline, not text search:**

1. Pull the full open-issue list: `gh issue list --repo JSONbored/gittensory --state open --limit 1000 --json number,title,labels,milestone,createdAt`.
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

**Target: keep the repo-wide contributor-available count (unassigned, no `maintainer-only`, carries a `gittensor:*` label) at roughly 30-50, combined with metagraphed's own count** — check the combined total across both repos before deciding how many to add here; don't generate a fixed number blind. Compute it fresh: `gh issue list --state open --limit 1000 --json number,labels,assignees` and filter.

1. **Read `reference.md`'s "what's safe to unleash" framework first.** The single most common mistake is generating architecture/business-decision issues (hosted multi-tenant SaaS design, billing, SLAs, pricing) that must stay `maintainer-only` — this repo has ~90 such issues already correctly gated and the automation must not erode that boundary. Concrete engineering work with a clear existing precedent to follow is the target; open-ended product/business decisions are not.
2. Pick real gaps to scope from, in priority order:
   - Existing open epics/roadmap issues in this repo that don't yet have enough decomposed child issues to be actionable (e.g. `ORB - Long Term Features & Improvements`, the review-comment-redesign family, any epic whose own body describes scope with no filed sub-issues yet).
   - Genuine gaps found by reading the current codebase against a shipped feature's own stated acceptance criteria (the same technique Pass 1 uses to verify closure — used here in reverse, to find what's NOT yet done).
   - AMS selfhost hardening and the unified AMS+ORB selfhost harness are named standing priorities — see `reference.md` for what's already been investigated there (as of 2026-07-14, no existing issue covers "install both products together"; it needs fresh scoping, not relabeling).
3. Every new issue gets: the correct existing milestone (create a new one only if none fits — don't dump unrelated work into an ill-fitting bucket), a `gittensor:bug` (0.05x), `gittensor:feature` (0.25x), or `gittensor:priority` (1.5x, reserved for mission-critical/time-sensitive work only — this repo uses it sparingly, unlike metagraphed's looser convention, see `reference.md`) label, plus `help wanted` (the maintainer confirmed this stays as a visibility signal alongside the points label, not a replacement for one).
4. Every new issue body follows the template in `reference.md` — Context, Requirements, Deliverables, Test Coverage Requirements (this repo's Codecov patch gate is 99%+, hard — every new issue implicitly inherits this unless it's `apps/**`-only UI work), Expected Outcome. No "left to interpretation" scope — the maintainer's own stated preference is that thin/ambiguous issue bodies are worse than fewer, complete ones.
5. Link relationships using GitHub's native features, not prose: `addSubIssue` to attach a new issue under its parent epic, `addBlockedBy` when an issue genuinely cannot start before another lands. Only use these where a real dependency exists — don't chain issues into an artificial order to look organized.
6. Quality over the number. If a scan doesn't turn up 30-50 genuinely well-scoped, non-redundant, correctly-boundaried issues combined across both repos on a given day, file fewer rather than pad with weak ones — note the shortfall in the daily digest instead.

## Daily digest

End every run with a short summary (issues closed with why, checklists fixed, new issues filed with
milestone/label, current contributor-available count before/after, anything ambiguous that was left
alone on purpose). This is the user's only visibility into a fully-autonomous run — make it
readable in under a minute.
