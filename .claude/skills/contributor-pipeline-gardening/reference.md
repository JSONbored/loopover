# Contributor pipeline gardening — reference (gittensory / loopover)

## Docs architecture is mid-migration (as of 2026-07-15) — don't generate old-pattern docs issues

Both loopover and metagraphed are migrating their website docs from hand-built TanStack Router
route files (`docs.<slug>.tsx`, a full React component per page, manually-maintained nav array) to
a shared MDX pipeline: **`fumadocs-core`/`fumadocs-mdx` (headless — not `fumadocs-ui`'s component
shell) for content/structure/search, rendered through the existing ui-kit `<DocsPage>` primitives,
plus Scalar (`@scalar/api-reference`) for the API playground instead of `fumadocs-openapi`** (which
has documented compatibility issues in TanStack/Vite environments). Both apps share the identical
`@lovable.dev/vite-tanstack-config` Vite setup, so the integration is being proven once on loopover
(#6037, a bounded spike, `maintainer-only`) before porting to metagraphed as a shared package.

**Until #6037 lands with a proven pattern:**
- Every issue that would otherwise ask a contributor to hand-build a new `docs.*.tsx` route (in
  either repo) should stay `maintainer-only`, or better, not be filed at all — file it (or note it
  as a gap in the digest) but don't unlock it for contributors.
- The AMS-docs epic #6012 and its 11 sub-issues (#6022-#6032), plus metagraphed's open "Docs page: X"
  family (#3504/3505/3506/3507/3508/3509/3510/3511/3514/3516), were all deliberately paused this way
  on 2026-07-15 — they carry `maintainer-only` + a comment explaining why, not because the underlying
  work stopped being wanted. Don't "fix" this labeling in a future stale-sweep pass; check #6037's
  state first. Once it lands, these need their Requirements sections rewritten to target an `.mdx`
  content file instead of a hand-built route, then `maintainer-only` removed — that rewrite is real
  work for a future run/session, not a mechanical relabel.

## Product shape (so generated issues land in the right place)

Two products, self-host-first:

- **AMS (Autonomous Miner System)** — `packages/loopover-miner` (npm: `@loopover/miner`) +
  `packages/loopover-engine` (npm: `@loopover/engine`, shared core also used by ORB) +
  `apps/loopover-miner-ui` + `apps/loopover-miner-extension`. The contributor/miner side: finds
  issues, plans, writes code, opens PRs, autonomously. Self-host (a local Miner Node) is the only
  shipped deployment target; hosted AMS is a later phase (see "AMS/ORB Cloud Readiness" below).
- **ORB (Owner/One-shot Review Brain)** — `src/**` (the Worker app: `src/review`, `src/queue`,
  `src/signals`, etc). The maintainer side: automates PR review, merge/close disposition, summaries.
  Self-hosted only today (see `.claude/skills/contributing-to-loopover` / `gittensory-deployment-models`
  equivalent context) — no hosted Orb yet, deliberately, ~1-2 months out at the time of writing.
- Directory names under `packages/` and npm package names both moved to `loopover-*` / `@loopover/*`
  (the repo itself renamed `gittensory` → `loopover` on 2026-07-15). Some tables/audit-log values and
  historical GitHub content still legitimately reference the old name — re-verify current naming before
  hardcoding either name into a new issue body rather than assuming either direction.

**Standing priorities named by the maintainer (2026-07-14), not yet issue-backed:**
- **AMS selfhost hardening, round 2.** Miner Wave 4 ("AMS Hardening & Packaging") fully closed
  (151/151) on 2026-07-14 — that backlog is empty, not hiding more maintainer-only work. Getting more
  requires a fresh gap-audit (read the current `packages/loopover-miner`/`-engine` code against what
  Wave 4 already covered — coverage gate, ledger races, MCP scaffolding — and find what's still
  genuinely thin), not relabeling existing issues.
- **Unified AMS+ORB self-host harness** — now scoped and issue-backed as of 2026-07-15, don't
  re-discover it as unscoped in a future run. #5996 covers the combined ORB+AMS quickstart doc itself.
  A broader 2026-07-15 audit of every `.md` file in the repo found AMS's operator-facing docs
  (`packages/loopover-miner/DEPLOYMENT.md` + 10 files under `docs/`) exist only as raw markdown, never
  ported to the real docs website (`apps/loopover-ui/src/routes/docs.*.tsx`) the way ORB's
  self-hosting docs already are — filed as epic #6012 (milestone `ORB - Long Term Features &
  Improvements`, not its own milestone — see the milestone-discipline note above) with one sub-issue
  per source file. Check #6012's sub-issue completion state before assuming this work still needs
  scoping from scratch.

## Milestone taxonomy (as of 2026-07-14 — re-check before trusting, this moves fast)

| Milestone | Nature | Contributor-open? |
|---|---|---|
| `Miner Wave N — <theme>` (no suffix) | A finished or active AMS-hardening-style wave | Mostly yes once released |
| `Miner Wave N — <theme> (maintainer)` | Business/legal/architecture track (currently Wave 5, Rent-a-Loop) | Mostly no — but check individual issues, some concrete implementation sub-tasks are deliberately carved out and unlocked even inside a `(maintainer)`-titled milestone |
| `Miner Wave 4.5 — AMS Hardening Round 2` | **New, created 2026-07-15.** The home for recurring post-Wave-4 gap-audit findings in `packages/loopover-miner`/`packages/loopover-engine` — correctness bugs, unenforced documented contracts, stale comments, small hardening gaps. Every future "AMS selfhost hardening round N" audit files here, not a fresh milestone each time. | Yes — same shape as Wave 4's own contributor-open issues |
| `AMS Cloud Readiness (maintainer)` | Hosted **multi-tenant SaaS** AMS — NOT the same thing as "AMS selfhost hardening" despite the name similarity | Mostly no (architecture/billing/SLA decisions) — a handful of pure research-spike/audit/load-test issues are deliberately contributor-eligible; check labels per-issue |
| `ORB Cloud Readiness (maintainer)` | Same shape, for ORB's hosted SaaS story | Mostly no, same caveat — the first several issues in this milestone (#4878-4884-style, "extract X into loopover-engine") are often pure refactors miscategorized here, not actually tenant/business-specific — read the body, not just the milestone |
| `ORB - Long Term Features & Improvements` | Grab-bag: some genuine self-host feature/bug work, some product-design epics awaiting maintainer subjective calls | Mixed — read each body |
| `LoopOver Rebrand Migration (maintainer)` | Brand/infra cutover | No |
| Unmilestoned | Should be rare — every gardening-generated issue gets a real milestone (see below) | If you find one, fold it into the closest-fitting existing milestone rather than leave it adrift |

**Every gardening-generated issue gets a milestone — none ship unmilestoned.** Default to the
closest-fitting existing one. Creating a new milestone is a much higher bar than it sounds — confirmed
the hard way, 2026-07-15: when scoping the unified AMS+ORB harness epic (#6012) into an 11-issue
docs-porting body of work, a new milestone was created for it; the maintainer immediately reverted
this and folded the epic into the existing `ORB - Long Term Features & Improvements` grab-bag instead.
A new milestone is warranted only when nothing existing fits AND the work is either a genuinely major
initiative or a **recurring category that will keep needing a home** — the latter is why `Miner Wave
4.5 — AMS Hardening Round 2` (above) was created the same day as the #6012 revert, for the opposite
reason: this skill's own AMS-hardening gap-audits recur every run now (see the raised cadence in
`SKILL.md`), so a durable bucket is the correct call, not a one-off exception. A single one-off oddity
alone is not enough justification. When genuinely unsure and the call is high-stakes (a new milestone,
not routine label/relationship choices), it's fine to propose 1-2 options — but default to deciding and
documenting the reasoning (in the issue body or milestone description) rather than blocking a run on
confirmation, per the maintainer's own stated preference (2026-07-15): "figure it out yourself."

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

## The gate only enforces what the issue explicitly says — never rely on implied intent

**Confirmed by the maintainer, 2026-07-15:** the loopover-orb review agent (the gate) checks a PR
against whatever the linked issue **explicitly** states as fulfillment requirements. It does not
infer intent from narrative Context, from "obviously implied" scope, or from this skill's own
general conventions — none of that is visible to the gate at review time. Only the issue's own text
is.

**What this broke once already:** issue #5996 (a combined ORB+AMS self-host doc) explained in
Context that public-facing docs live on the website, not as repo markdown, and had one Requirements
bullet saying so. A contributor's PR (#6011, filed *after* that bullet was added) still added a new
root-level `.md` file plus edited three other markdown files as its "fix" — a plausible-looking wrong
interpretation the gate had nothing more explicit to check against, since the constraint wasn't
phrased as an unambiguous, standalone rule.

**How to apply, every time a deliverable's file type/path/format actually matters (not just docs —
also applies to "this must be a native GraphQL mutation not a markdown checklist," "this must reuse
the existing X pattern not invent a new one," etc.):**
- State the hard constraint as its own callout or leading Requirements bullet, not folded into
  prose Context.
- Name the exact file path/pattern the deliverable must match.
- Name the exact anti-patterns that do **not** satisfy the issue even if superficially on-topic (e.g.
  "adding a new `.md` file anywhere in the repo, including the root," "editing README.md to add this
  content instead of creating the route file").
- For anything doc-shaped, use language close to: `> ⚠️ Read this before starting. The deliverable
  is a website page at <exact path>. It is not a markdown file. A PR that adds/edits any .md file as
  the fix does NOT resolve this issue and will be closed.` — see #5996 or any of #6012's sub-issues
  for the exact wording already proven out.
- Assume the issue text is the *only* thing an AI-harness-driven contributor's agent will read before
  acting — don't assume it will also read this skill file, the repo's CLAUDE.md, or common sense
  about the file type.

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

**Check every new batch of issues for a real dependency before moving on — this is a required step,
not an optional nicety** (reinforced by the maintainer, 2026-07-15: relationship links "can be
valuable/important in guiding users to work on specific things in the correct order"). Most batches of
independent bug-fixes or parity additions (e.g. a set of REST/GraphQL-mirror issues, each adding one
unrelated field) genuinely have no dependency on each other — in that case the correct outcome of the
check is "no links needed," not a forced one. Reserve `addBlockedBy` for a real case where working an
issue out of order would waste a contributor's time or produce broken intermediate state, and
`addSubIssue` for anything that's genuinely a piece of a parent epic/tracker.

Prefer these over a markdown checklist for any new tracker/epic:

```graphql
mutation { addSubIssue(input: { issueId: "<parent node id>", subIssueId: "<child node id>" }) { issue { number } } }
mutation { addBlockedBy(input: { issueId: "<blocked node id>", blockingIssueId: "<blocker node id>" }) { issue { number } } }
```

Get an issue's GraphQL node ID via `gh api graphql -f query='query { repository(owner:"JSONbored", name:"loopover") { issue(number: N) { id } } }'` (note: literal query strings without file interpolation are fine with `-f`; only the `@file` file-read syntax requires `-F`).

## gh CLI gotchas already hit doing this work

- `gh api graphql -f query=@file.txt` silently fails to read the file — use `-F query=@file.txt`.
- `gh issue close` has no `--comment-file` flag — use `-c "$(cat file.md)"` (double-quoted, so the
  command substitution's output — including any backticks in the comment text — is treated as one
  literal argument, not re-parsed by bash).
- Never embed a body/comment string containing backticks directly inside a `python3 -c "..."`
  double-quoted bash argument — bash attempts command substitution on the backticks before Python
  ever sees them. Write the content to a file with the Write tool first, then read it back via
  `$(cat file)` inside double quotes, or pass `--body-file`/`--comment` reading from that file.
