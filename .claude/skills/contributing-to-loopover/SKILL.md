---
name: contributing-to-loopover
description: >-
  Use when writing, testing, or preparing ANY code contribution or pull request to the
  JSONbored/gittensory repo — picking/validating an issue, implementing a change, writing tests
  that pass Codecov, running the local CI gate, predicting the loopover gate, and formatting the
  commit + PR. loopover reviews PRs ONE-SHOT via the loopover gate (a GitHub App / CI) plus a
  strict CI suite with Codecov (99% patch coverage, hard); there is no review back-and-forth, so a
  PR must be correct, fully tested, house-style-compliant, and green before it is pushed. Invoke
  for any "contribute to / open a PR against / fix a bug in / add a feature to loopover" task.
---

# Contributing to LoopOver — the one-shot PR playbook

LoopOver merges through an **automated, one-shot review**: the loopover gate (a GitHub App that
posts a check run + a single review verdict) and a **strict CI suite gated by Codecov**. There is no
human ping-pong and no "fix it in review" — **the PR must be perfect before you push.** This skill is
the end-to-end procedure to make that happen with AI tools (Claude Code / Codex).

Work through the phases **in order**. Do not skip the verification phases. If you cannot get the full
local gate green, **do not push** — an incomplete PR will be auto-closed or held, not coached.

`reference.md` (next to this file) has the exhaustive tables (every CI job, the full Codecov rules,
the gate config, the MCP tools, test helpers, the commit/PR rubric). Read it when a phase says to.

---

## What the gate does to your PR — it merges and closes, automatically

LoopOver's review engine has **real autonomy** here — it is **not advisory**. Within ~2 minutes of
your PR's checks settling, for a **contributor** PR (you are not the repo owner or an automation bot)
it takes a one-shot disposition:

| Situation | Engine action |
|---|---|
| Review-agent check passes **and** every CI check green **and** mergeable-clean (+ approvals) | **auto-approve → MERGE** |
| **Any** CI check failed — required or not, **`codecov/patch` included** | **CLOSE** (one-shot) |
| Gate **failure**, or base **conflict** (needs rebase), or a linked-issue **hard-rule** violation | **CLOSE** (one-shot) |
| CI still **pending** | no action — waits for checks to finish |
| CI **unverified** (e.g. a fork whose Actions await approval) | **held** for review |
| PR touches a **crucial/guarded path** (CI config, the review engine, visual) | **held** for the owner |

So a flawed contributor PR is **closed, not coached** — recovery means resolving the problem and
opening a **fresh** PR. This is the entire reason to get it right before you push:
**green CI + passing gate + clean mergeable + a valid linked issue ⇒ merged; any adverse signal ⇒ closed.**
(Owner and automation-bot PRs are never auto-closed — but you should assume you are a contributor.)

---

## The non-negotiables (read once, hold throughout)

1. **99% patch coverage is a HARD wall.** Codecov `codecov/patch` has `target: 99%, threshold: 0%`
   — *zero slack* — and it counts **BRANCH** coverage, not just lines. **Aim for 100% on every line
   you change, including invariants and a regression test for any bug you fix.** Only `src/**` counts;
   `apps/**`, `test/**`, `scripts/**`, and `src/env.d.ts` are ignored by Codecov. (So a UI-only change
   has no coverage obligation — but a backend change does, on *every changed line and branch*.)
2. **No CI check may fail.** One command runs the whole gate locally: **`npm run test:ci`** (plus
   `npm audit --audit-level=moderate` for the dependency-review job). If that is not green, the PR is
   not ready. Period.
3. **Anchor on existing code.** Before writing anything, find **≥2 existing analogues** in the repo
   (cite them as `file:line`) and **trace the closest one end-to-end**. Match its structure, naming,
   error handling, and comment density. The repo has a strong house style — imitate, don't invent.
4. **Build for the class, not the one case.** If a change only handles your single scenario, it is
   probably a special-case hack. Prefer the general, data-driven shape the codebase already uses.
5. **Honesty clause.** Never open a WIP/partial PR. Never weaken or delete a test to make coverage
   pass. Never mask a failing check. If a test legitimately can't be written, that means the code
   needs restructuring — fix the code, don't fake the test.
6. **Regenerate generated artifacts and commit them.** Stale generated files fail CI even when your
   code is correct: `ui:openapi` (API/schema changes), `cf-typegen` (wrangler binding/var changes),
   migrations (DB changes). See Phase 4.
7. **Respect the hard boundaries** (from `CONTRIBUTING.md`): never put secrets, tokens, wallets,
   hotkeys/coldkeys, raw trust scores, reward/payout values, or private scoring in code, comments,
   tests, or PR text. Don't touch `site/`, `CNAME`, `**/lovable/**`. Don't edit the changelog in a
   normal PR. **No AI/Claude/agent attribution** anywhere in commits or PR text.

---

## Phase 0 — Bootstrap your working tree + the MCP

**Get a working tree — every local command in this skill needs it:**

```sh
# External contributor? Fork JSONbored/gittensory on GitHub first, then clone YOUR fork:
git clone https://github.com/<you>/gittensory && cd gittensory
git remote add upstream https://github.com/JSONbored/gittensory   # to sync main later
nvm use            # Node 22 (.nvmrc)
npm ci             # installs the whole workspace, incl. apps/gittensory-ui — required before any check
```

All `npm run …` commands run from the **repo root**. As an external contributor you **push to your
fork** and open the PR from it. On your **first** fork PR, GitHub Actions wait for a maintainer to
approve the run, so the checks sit *unverified* for a bit — that is **expected**: the engine **holds**
an unverified-CI PR (it does **not** close it). Don't open a duplicate; wait for the run to be
approved, then confirm it's green.

**Install the loopover MCP** — your pre-submit oracle that predicts the gate before you push:

```sh
npm install -g @jsonbored/gittensory-mcp@latest
gittensory-mcp login                       # GitHub device flow (for the auth'd preflight tools)
gittensory-mcp init-client --print codex   # prints TOML for ~/.codex/config.toml ([mcp_servers.gittensory])
gittensory-mcp init-client --print claude  # or --print cursor — prints the correct config per tool
```

Use that generator instead of hand-writing config (**Codex uses TOML, Claude/Cursor use JSON** — a
pasted JSON block will not work in Codex). You'll use these tools in Phases 1 and 6 (inputs in
`reference.md`): `gittensory_check_before_start`, `gittensory_validate_linked_issue`,
`gittensory_check_slop_risk`, `gittensory_lint_pr_text`, `gittensory_predict_gate` — all metadata-only
(no source upload, no secrets).

---

## Phase 1 — Pick and validate the work

- **Search first.** Check open issues AND open PRs for duplicates — a duplicate PR is a close-worthy
  signal. And only link an issue that is **open, not assigned to someone else, not maintainer-only,
  and (on scored repos) carries a point label**: linking an owner-assigned / maintainer-only /
  ineligible issue trips a **deterministic linked-issue hard rule that auto-closes your PR**. Verify
  with `gittensory_check_before_start` + `gittensory_validate_linked_issue`.
- **A linked, currently-open, unassigned, eligible issue is always required before opening a PR** —
  there is no "small enough to skip it" exemption, no matter how self-evident the fix looks. This
  holds regardless of what the committed root `.gittensory.yml`'s `linkedIssuePolicy` says: that
  file is a non-representative **example** checked into the repo, not the live enforced rule. If no
  suitable open issue exists, open one yourself first, then link it from the PR.
- **Run the pre-start checks** via MCP: `gittensory_check_before_start` (is it claimed / a duplicate
  cluster / already solved?) and, if linking an issue, `gittensory_validate_linked_issue`.
- **Stay in scope.** The gate's `wantedPaths` are `src/`, `packages/`, `test/`, `migrations/`,
  `scripts/`, `review-enrichment/`, `.github/workflows/`, `wrangler.jsonc`, `apps/gittensory-ui/`. Avoid `blockedPaths`
  (`site/`, `CNAME`, `**/lovable/**`). Keep the PR narrow — one coherent change.

---

## Phase 2 — Implement (match the house style)

1. **Trace the closest analogue end-to-end** before editing. Open the most similar existing
   feature/route/signal and follow it through every file it touches.
2. **Follow the conventions** (details + examples in `reference.md`):
   - File naming: `kebab-case.ts`. Component pure helpers/types go in a sibling `*-model.ts` so the
     component file only exports components (ESLint `react-refresh/only-export-components`).
   - `*-wire.ts` = a flag-gated feature's guard + init. New capabilities are **flag-gated and OFF by
     default** (truthy-string env flag in `wrangler.jsonc` `vars`), so the deploy is byte-identical
     until the flag is set — mirror this for anything new and risky.
   - DB: core tables use Drizzle (`src/db/schema.ts`); feature/aggregate tables use raw-SQL migrations.
   - Comments: sparse but dense; explain *why*, anchor non-obvious logic to an issue number
     (`(#1234)`). Don't narrate the obvious.
   - **Config-as-code parity:** a new per-repo gate/setting field must be wired in *every* site
     (DB migration + Drizzle/types + the settings resolver + OpenAPI + the `.gittensory.yml` schema)
     in the **same** PR — partial wiring fails review. (See the per-repo-setting checklist in
     `reference.md`.)
   - UI: use design tokens (`text-token-*`, `rounded-token`, `border-hairline`, …) in
     `src/components/site/**` and `src/routes/**` — raw Tailwind size/radius classes are ESLint
     errors. Never import `server-only`.
3. **Don't break the public/private boundary.** Public PR comments, check output, and any
   contributor-facing surface must never leak wallet/hotkey/trust-score/reward/private-scoring terms;
   the sanitizer drops them, and tests assert their absence — keep it that way.

---

## Phase 3 — Test to (effectively) 100%, including invariants + regressions

This is where most PRs fail Codecov. The bar is **every changed line AND every changed branch covered**.

- **Where tests go:** `test/unit/` (pure logic), `test/integration/` (API routes + D1 via
  `createTestEnv()`), `test/workers/` (Cloudflare pool, separate config), plus `test/contract/`.
  Use the `createTestEnv()` / `TestD1Database` helpers (in-memory SQLite, applies all migrations) and
  `vi.stubGlobal("fetch", …)` for GitHub calls. Patterns + snippets in `reference.md`.
- **Branch coverage is the trap.** Every `if/else`, ternary `? :`, `&&`/`||`, and especially every
  nullish fallback `?? 0` / `?? []` is **two branches** — you must exercise *both* sides. The classic
  miss: a `SUM(...)` over an empty set returns **NULL**, so `count ?? 0` needs a test where the value
  is actually null/absent, not just present. A line at 100% line-coverage can still be a partial
  *branch* and sink your patch %.
  - For each new `??`/ternary/`&&`: write one case for the truthy/present side and one for the
    nullish/absent/false side.
  - Test fail-safe paths too: if a function swallows a thrown D1/fetch error and degrades, add a
    test that makes it throw and asserts the degraded result.
- **Invariants:** for anything with a public/private boundary, a state→tone/verdict mapping, sorting,
  or gating, add an invariant test (table of states; assert the right output AND that no competing
  state leaks). Mirror existing invariant suites.
- **Regression test for every bug fix:** add a test named for the bug that reproduces it and pins the
  fix. A fix without a regression test is incomplete.
- **Iterate fast, then measure honestly.** While writing tests, scope to one file:
  `npx vitest run test/unit/<file>.test.ts` (or `-t "<name>"`), or run `npm run test:changed` to let
  Vitest select every test whose real import graph is affected by your diff against `main` — faster
  than guessing which files matter, and more accurate than a path glob. It is a local-only convenience;
  it is not wired into CI or the Codecov gate. Before pushing, run the whole suite
  **unsharded** — `npm run test:coverage` — the only faithful local coverage signal (CI shards + merges,
  so a single shard under-reports).
- **Find the uncovered branch.** In the v8 text report, read the **% Branch** column and the
  **Uncovered Line #s** for your changed file — a line at 100% lines but <100% branch has an un-taken
  `??`/ternary/`&&` side; add that case. Aim for **100% branch on your diff locally** so normal CI
  variance never drops you under the 99% wall.

---

## Phase 4 — Regenerate what your change invalidates (then commit it)

Run the matching command(s) and **commit the regenerated file(s)** — CI fails on staleness:

| You changed… | Run | Commit |
|---|---|---|
| API routes or OpenAPI schemas (`src/`) | `npm run ui:openapi` | `apps/gittensory-ui/public/openapi.json` |
| A Cloudflare binding/var in `wrangler.jsonc` | `npm run cf-typegen` | `worker-configuration.d.ts` |
| Drizzle schema (`src/db/schema.ts`) | `npm run drizzle:generate` | the new `migrations/NNNN_*.sql` |
| Added a raw-SQL migration | (none — just author it) | next **contiguous** `migrations/NNNN_snake.sql` |
| `src/selfhost/**` (or a few other scanned files — see `scripts/gen-selfhost-env-reference.mjs`'s `DEFAULT_SOURCE_ROOTS`) adding/removing an `env.SOMETHING` read | `npm run selfhost:env-reference` | `apps/gittensory-ui/src/lib/selfhost-env-reference.ts` — the doc cites the file only (not `file:line`, deliberately, so an unrelated line shift elsewhere in the file never makes this go stale) |
| CLI command surface | `npm run command-reference` | the generated command-reference doc |
| UI files (`apps/gittensory-ui/**`) | `npm --workspace @jsonbored/gittensory-ui run format` | formatted files |

Migrations must use the **next free number** (contiguous, no gaps, no reuse) and match
`NNNN_snake_case.sql`; `db:migrations:check` enforces it.

---

## Phase 5 — Run the FULL local gate (must be 100% green)

```sh
git diff --check                          # no trailing whitespace / conflict markers
npm run test:ci                           # the entire CI gate, in one command (see below)
npm audit --audit-level=moderate          # the dependency-review job's local equivalent
```

`npm run test:ci` runs, and must pass, **all of**: `actionlint`, `db:migrations:check`,
`db:schema-drift:check`, `selfhost:env-reference:check`, `selfhost:validate-observability`,
`cf-typegen:check`, `typecheck`, `test:coverage`, `test:engine-parity`, `test:live-gate-parity`, `test:driver-parity`, the
`@jsonbored/gittensory-engine` workspace's own test run, `test:workers`, `build:mcp`, `test:mcp-pack`,
`build:miner`, `test:miner-pack`, `rees:test`, `ui:openapi:check`, `ui:openapi:settings-parity`,
`ui:version-audit`, `docs:drift-check`, `manifest:drift-check`, `engine-parity:drift-check`,
`command-reference:check`, `ui:lint`, `ui:typecheck`, `ui:test`, `ui:build`. If any step fails, fix it
and re-run — do not push a red tree. (Full per-check table in `reference.md`; check `package.json`'s
own `test:ci` script if this list and that script ever disagree — the script is the source of truth.)

If `ui:lint` fails on formatting, run `npm --workspace @jsonbored/gittensory-ui run format`. If
`ui:openapi:check` fails, you forgot Phase 4's `ui:openapi`.

**Sync with `main` before you push if it moved** — a base conflict auto-closes a contributor PR:
`git fetch upstream && git rebase upstream/main`, resolve, re-run the gate, then push. On the PR, the
required status check is **`validate`** (it aggregates the CI jobs) and the engine posts a check run
named **`Gittensory Orb Review Agent`** — watch both go green/passing.

---

## Phase 6 — Predict the loopover gate before you push

Run the MCP predictor with your actual PR shape:

- `gittensory_check_slop_risk` — keep slop **low**: fill the PR description, include tests, keep the
  diff focused (no lockfile/docs/generated noise dominating), real source ratio.
- `gittensory_lint_pr_text` — your commit + PR body must read as **strong**: Conventional Commit
  subject, traceability (a linked, currently-open, eligible issue — no no-issue rationale accepted),
  and a body that says what changed, why, and how it was validated.
- `gittensory_predict_gate` — simulate the repo's public `.gittensory.yml` gate. Resolve any
  predicted blocker (the duplicate-PR blocker is the one that hard-fails here) before opening.

Resolve **every** finding before you push. The engine MERGES only a clean + green + gate-passing PR
and **CLOSES** a contributor PR on any adverse signal (red CI, gate failure, base conflict, or an
ineligible linked issue). A clean prediction plus a green `npm run test:ci` is what earns the one-shot
merge instead of a one-shot close.

---

## Phase 7 — Commit and write the PR

**Capturing and hosting visual evidence (any visible UI/frontend change).** The `## UI Evidence` table
below needs real, clickable thumbnail URLs — here's how to get them when you can't drag-and-drop into
GitHub's web editor (which needs a human browser session an AI coding tool can't drive end-to-end):

1. **Local dev server:** `npm --prefix apps/gittensory-ui run dev` (Vite forces port **8080** regardless
   of what you request — use that port in any launch config, or `preview_screenshot`-style tooling just
   hangs waiting for the server). For an auth-gated page, use the sanctioned local-preview escape hatch
   instead of real GitHub OAuth: `useSession().signInPreview()` (`apps/gittensory-ui/src/lib/api/session.ts`),
   gated on `import.meta.env.DEV` — it sets a synthetic session client-side with no network write. Click
   the "Continue with local preview" button in the sign-in wall rather than calling the hook indirectly
   (the real `fetchBrowserSession()` call can race in afterward and silently overwrite it back to `null`);
   overriding `window.fetch` for `/v1/auth/session` to return the same authenticated shape closes that
   race either way.
2. **Fixed viewport, never a full-page/`fullPage: true` capture.** gittensory-ui is a **dark-mode-only
   build** (`apps/gittensory-ui/src/components/site/theme-toggle.tsx` — the toggle was removed; there is
   no light theme left to force), so there's no theme dimension to multiply out. Capture at whichever
   viewport(s) your change actually affects — mobile (375×812) and desktop (1280×800) cover most cases;
   add a caption per state either way (`"Loaded state"`, `"Mobile layout"`, etc., matching the existing
   caption convention below).
3. **Host the images on a dedicated branch in your own fork** — never commit them to your feature
   branch, and never rely on drag-and-drop:
   ```sh
   git worktree add ../gittensory-screenshots main
   cd ../gittensory-screenshots
   git checkout --orphan screenshots       # first time; `git checkout screenshots` if you already have one
   git rm -rf . 2>/dev/null
   cp /path/to/your/*.jpg .                # JPG/PNG only -- SVG is never accepted as review evidence
   git add *.jpg && git commit -m "screenshots for PR"
   git push origin screenshots
   cd -    # your feature branch's working directory was never touched
   ```
   Reference each file as `https://raw.githubusercontent.com/<your-fork-owner>/gittensory/screenshots/<file>.jpg`,
   then embed it with the existing `<a href="URL"><img src="URL" alt="Loaded state" width="240"></a>`
   thumbnail convention.
4. **Animated evidence — for effects no static screenshot can show** (a hover-triggered element, a
   scroll-linked effect, a CSS transition, a drag interaction): record the interaction (an OS screen
   recording or a Playwright video), convert it to a GIF —
   ```sh
   ffmpeg -i recording.mov -vf "fps=12,scale=480:-1:flags=lanczos" -loop 0 hover-before.gif
   ```
   (keep it small: a few seconds, ~12fps, ≤480px wide) — and host it the same way as step 3 above; `.gif`
   is an accepted screenshot-evidence extension the same as `.jpg`/`.png`. This is *additional* evidence
   for the interaction itself when the change also has an at-rest visual difference worth a static
   screenshot too — it doesn't replace step 2 for a change that has both kinds of difference, only for a
   change where the "before"/"after" genuinely cannot be told apart without the motion.

**Commit subject** — Conventional Commit, lowercase scope, specific, no trailing period, ≥15 chars
and ≥2 real words, **no AI/Claude attribution**:

```
feat(api): add cursor pagination to the labels endpoint
fix(review): pin comment tone to the gate conclusion (#1066)
test(stats): cover the nullish SUM fallbacks in public-stats (#1059)
```

Allowed types: `feat fix test docs refactor build ci chore revert`. Avoid bare generic words
(`update`, `fix`, `wip`, `cleanup`, `misc`).

**PR body** — GitHub pre-fills `.github/pull_request_template.md`. **Fill it out; do not replace it.**
Write a real `## Summary`, then honestly check every box in `## Scope`, `## Validation` (the exact
command list — only check what you actually ran), and `## Safety` (especially the auth/CORS
**negative-path tests** box and the no-secrets box). For any visible UI/frontend/docs change, fill the
**`## UI Evidence`** table with captioned, clickable **JPG/PNG** thumbnails (`<a href><img></a>`) —
SVG is not accepted, and review-only screenshots are never committed to the repo. A filled Summary +
the Validation evidence + a linked, currently-open issue is exactly what makes `lint_pr_text` read
*strong* — there is no no-issue-rationale substitute.

---

## Phase 8 — Final pre-push checklist

- [ ] Traced ≥2 existing analogues; the change matches house style and is general, not a special case.
- [ ] In scope (`wantedPaths`), narrow, no `blockedPaths`, no secrets/private terms anywhere.
- [ ] **Every changed line and branch is tested** (both sides of each `??`/ternary/`&&`); invariants +
      a regression test for any fix; `npm run test:coverage` shows no uncovered/partial changed lines.
- [ ] Regenerated + committed: OpenAPI / `cf-typegen` / migrations as applicable (Phase 4).
- [ ] Branch current with `main` (no base conflict): `git fetch upstream && git rebase upstream/main`.
- [ ] `git diff --check` clean · **`npm run test:ci` fully green** · `npm audit --audit-level=moderate` clean.
- [ ] MCP: `predict_gate` = pass, `check_slop_risk` = low, `lint_pr_text` = strong; no advisory findings left.
- [ ] Conventional Commit subject (no AI attribution); `.github/pull_request_template.md` filled honestly —
      the Scope + Validation + Safety boxes, and the UI Evidence table for any visual change.
- [ ] If the change is only visible in motion (hover/scroll/transition): a before/after GIF alongside the
      static screenshots, per Phase 7's "Animated evidence" step.
- [ ] No changelog edit; no `site/`/`CNAME`/`lovable` changes.

If every box is checked, the PR has the best possible chance of a one-shot approve-and-merge. If any
box can't be checked, **keep working — don't push.**

---

When you need the exhaustive detail behind any phase, read **`reference.md`** in this skill directory.
