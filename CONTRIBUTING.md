# Contributing

Gittensory is a Cloudflare Workers, TanStack Start, GitHub App, and MCP project for
Gittensor OSS contribution intelligence. Contributions need to protect that scope: private
signals stay private, public GitHub output stays sanitized, and production surfaces must stay
wired to real backend behavior.

This project is maintained with a high review bar. PRs that ignore these guidelines, mix
unrelated work, reintroduce retired architecture, or repeatedly fail the required gates may be
closed without an extended review cycle.

## What Happens to Your PR (reviewed and acted on automatically)

gittensory reviews every PR with an automated gate (a GitHub App) and **acts on the outcome within a
few minutes** — there is no extended human back-and-forth. For a contributor PR (you are not the repo
owner or an automation bot):

- **Auto-merged** when the gate passes, **all CI is green**, the branch is conflict-free, and any
  required approvals are satisfied.
- **Auto-closed (one-shot)** on a clear adverse signal: a failing CI check (including coverage,
  `codecov/patch`), a gate failure, a base/merge conflict, or a linked issue that is ineligible
  (assigned to someone else, maintainer-only, or missing a required label). To recover, fix the
  problem and open a **fresh** PR; **reopening** the closed PR is how you dispute the decision.
- **Held for a maintainer** (not closed) when CI is still running/unverified — e.g. a first-time fork
  PR whose Actions await maintainer approval — or when the PR touches a protected/crucial path.

So **get it green and correct before you push**: run the full local gate (`npm run test:ci`), keep your
branch current with `main` (a conflict closes the PR), and link an eligible issue. If you use Claude
Code or Codex, the `.claude/skills/contributing-to-gittensory` skill (and the root `AGENTS.md`) encode
the whole procedure step by step.

## How Reviews Work (timing, one-shot, and asking for review)

**Timing is typical, not an SLA.** When the gittensory maintainer agent is operating, most PRs are
reviewed and auto-merged or auto-closed within **~1 hour of CI finishing**. When the agent is paused or
under maintenance, manual review **typically takes 24–48 hours, depending on volume**. These are
observations, not commitments or a service-level guarantee — reviews happen when they happen.

**One-shot, merge-ready as-is.** We do not request changes or iterate on contributor PRs — a PR is
merged exactly as it stands or it is closed; there is no "changes requested" back-and-forth. Before CI
we rebase your branch onto `main` with a **merge commit**, then review **after** CI completes — so a
rebase conflict, or any red CI (including **99% patch coverage, branch-counted, enforced by Codecov**),
closes the PR. Recover by opening a **fresh, corrected PR**. PRs touching guarded paths (CI config, the
review engine, migrations, and similar — the set varies) are held for manual review rather than
auto-acted.

**If we close your PR by mistake, that's on us.** We may reopen or re-review at our discretion as time
permits — there is no fixed window, and opening a fresh PR is usually fastest.

**Don't ask for or chase reviews.** The queue is automated and best-effort, and every auto-merge or
auto-close comes with a detailed bot comment on your PR explaining exactly what passed or what was
wrong — read that first. Do **not** DM, @-mention, or comment asking for a review or status: it will
not speed anything up and **will deprioritize your PR — expect at least 5 days added to its place in
the manual queue.** Persistent pestering (here, Discord, or elsewhere) is a conduct violation and may
get the PR closed and the account blocked.

**Contributors are limited to 2 open PRs at a time.** Close or wait for one to resolve before opening
a third.

**Scoring and rewards are not ours to grant.** Contribution scoring and any Gittensor rewards are set by
the subnet's on-chain hyperparameters and validators, not by this repo. Merging a PR is not a promise of
score, ranking, or compensation, and all review decisions are at maintainer discretion and final.

**This repository is itself Gittensor-listed.** PRs merged here by registered miners may earn TAO
under the subnet's own rules — see the badge in `README.md` for a live, aggregate merged-PR/line-count
summary. That eligibility and scoring is Gittensor's, not ours, and does not change the bar above.

## What We Accept

Focused contributions are welcome in these areas:

- Backend API behavior, auth/session handling, OpenAPI contracts, and API error states.
- GitHub App webhook, check-run, command, sanitized comment, and installation-health behavior.
- Registry, bounty, issue, PR, label, queue, collision, and GitHub backfill ingestion.
- Deterministic signal builders for contributors, maintainers, repository owners, and operators.
- The Lovable/TanStack Start frontend under `apps/gittensory-ui`, as long as it preserves the
  current product structure and stays wired to live API data or honest empty/error states.
- Cloudflare Worker, D1, Queue, scheduled job, deploy, and production smoke reliability.
- MCP server/client behavior, CLI ergonomics, compatibility metadata, and npm package hygiene.
- Tests, fixtures, invariants, OpenAPI/MCP contract checks, CI hardening, docs, and developer
  experience improvements.

## What We Do Not Accept

Do not open PRs for:

- GitHub Pages, VitePress, `site/`, `CNAME`, or any old static-docs production surface.
- Broad rewrites, framework swaps, or redesigns without a maintainer-approved issue.
- Production mock/demo data, silent fallback data, or UI claims that are not backed by live API
  behavior.
- Public leaderboards, raw wallet details, raw trust scores, private rankings, or public reward
  estimates.
- Auto-closing, auto-merging, rewriting contributor work, or applying labels outside the explicit
  confirmed-miner GitHub App policy.
- Storing contributor GitHub PATs or adding non-GitHub identity providers. Browser auth is GitHub
  OAuth; CLI/MCP auth is GitHub Device Flow. (A maintainer's own optional AI-provider key for BYOK AI
  review is a different credential class — it is the repo owner's LLM-inference key, not a GitHub
  identity credential — and is allowed: it is opt-in, encrypted at rest, write-only, and never returned
  or logged.)
- Large dependency major upgrades bundled with unrelated product changes.
- Changelog edits in ordinary feature/fix PRs. Changelogs are updated during release prep.
- Low-effort reward-farming changes, spam, generated bulk edits, or PRs that do not explain the
  product impact.
- Plagiarized PRs — copying another contributor's PR, diff, or work and submitting it as your own,
  including lightly reworded or re-tested copies filed under a different account. Copying others to
  farm Gittensor rewards is a hard violation and results in a **permanent block from contributing
  across all of our repositories**. See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Filing your own issue and then opening a PR that resolves it is welcome — that is not farming. A
linked, currently open issue is required on every PR regardless; there is no exemption for opening
one yourself first. What is against policy is **using more than one account you control (alt /
sock-puppet accounts) — e.g. one account opening issues for another to "resolve" — to inflate
contribution credit**, along with manufacturing low-value/slop issues and bulk point-chasing PRs.
Farmed work earns no linked-issue bonus, and repeat or any confirmed multi-account farming is
closed on sight and blocked. Enforcement is proportional; the full ladder is in
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Before Opening A PR

- Search existing issues and PRs to avoid duplicate work.
- Open an issue first for risky changes, public behavior changes, auth/session changes, schema
  migrations, major dependency upgrades, deploy changes, or frontend architecture changes.
- Keep the PR narrow. If the change spans backend, UI, MCP, and deploy behavior, explain why it
  cannot be split safely.
- Do not include secrets, tokens, private keys, webhook payload secrets, wallet details, hotkeys,
  coldkeys, private maintainer evidence, local absolute paths, or private scoring output.

## Required PR Contents

Every PR should include:

- A Conventional Commit-style title in the form `type(scope): short summary`.
- A clear summary of what changed and why.
- A link to a currently open issue this PR resolves (e.g. `Closes #123`) — there is no exemption
  for explaining why an issue isn't needed.
- The exact validation commands run from the repo root.
- JPG/JPEG or PNG screenshot evidence for visible UI, frontend, docs, or extension changes,
  attached in the PR description as organized, captioned, clickable thumbnails. SVG screenshots
  are not accepted as review evidence, and recordings are supplemental rather than a replacement
  for screenshots. Do not commit review-only screenshots or recordings to the repository.
- API/OpenAPI/MCP contract notes for schema or behavior changes.
- Migration, deploy, secret, or Cloudflare configuration notes when relevant.
- Security/privacy notes for auth, cookies, CORS, GitHub App output, user identity, or contributor
  evidence changes.

## Required Gates

Run the full gate before asking for review unless the PR is docs-only and you clearly say which
checks were skipped and why:

```sh
git diff --check
npm run actionlint
npm run db:migrations:check
npm run typecheck
npm run test:coverage
npm run test:workers
npm run build:mcp
npm run test:mcp-pack
npm run ui:openapi:check
npm run ui:version-audit
npm run ui:lint
npm run ui:typecheck
npm run ui:test
npm run ui:build
npm audit --audit-level=moderate
```

`npm run test:ci` runs the normal combined gate. The coverage requirement is **patch coverage**:
every line your PR adds or changes must be **99%+ covered** (statements, branches, functions, lines).
This is enforced by Codecov's `codecov/patch` status check, which looks only at your diff — so it
depends solely on your own changes and is unaffected by what else merges. Run `npm run test:coverage`
locally when you change behavior and make sure your new branches, fallback paths, and sanitizer rules
are tested.

The repo total is tracked by Codecov as a trend (informational, non-blocking). The local vitest run
keeps a loose **90%** global backstop that only trips on a catastrophic drop (e.g. a deleted test
file); it is intentionally well below actual coverage so routine PRs never fail on it.

Maintainer/release smoke checks:

```sh
npm run test:smoke:production
npm run test:smoke:browser:install
npm run test:smoke:browser
```

The browser smoke path is manual until it is stable enough to make required on every PR.

## Test Expectations

Tests should prove behavior, not just exercise lines for coverage.

- Add or update tests for every behavior change: new branches, fallback paths, sanitizer rules,
  and regressions.
- Add invariant or property-style tests when behavior depends on sorting, gating, public/private
  boundaries, scoring, queue pressure, or source-upload safety.
- Public GitHub comments must be tested against forbidden language when comment text changes
  (wallet, hotkey, raw trust score, payout, reward estimate, farming, private reviewability,
  public score estimate).
- Backend/API tests should cover success, denied, invalid input, missing auth, scoped auth,
  rate-limit, persistence, and error-shaping paths.
- Auth tests should cover browser cookie sessions, bearer sessions, logout/revocation, GitHub
  OAuth callback failures, and Device Flow compatibility.
- CORS tests should prove trusted credentialed origins work and untrusted origins do not.
- OpenAPI tests should prove protected/public metadata matches actual middleware behavior.
- Frontend tests and build checks should prevent production mock fallbacks, broken route
  hydration, stale OpenAPI artifacts, and localStorage-only app login regressions.
- MCP tests should cover CLI behavior, package contents, compatibility metadata, fallback
  behavior, and machine-readable JSON output.
- Worker tests should cover runtime-specific behavior that Node-only tests cannot represent.

## Area-Specific Notes

Backend/API:

- Keep responses structured and machine-readable.
- Keep contributor-scoped endpoints scoped to the authenticated GitHub identity.
- Public `/openapi.json` is allowed; protected data endpoints must stay protected.

Frontend:

- The production frontend is the TanStack Start app in `apps/gittensory-ui`.
- Use the existing design system and route structure unless a maintainer explicitly approves a
  larger redesign.
- Signed-in app state comes from `GET /v1/auth/session`; do not restore app login through
  localStorage bearer tokens.
- API Try It may still support manual bearer-token testing.
- Visible UI changes need a `Screenshots` or `UI Evidence` section in the PR description. Use
  GitHub-hosted JPG/JPEG or PNG screenshots only; SVG screenshots are not accepted as review
  evidence. Recordings can be included as supplemental context, but screenshots are still expected
  for visual review.
- Arrange screenshots in a small table or grid with a short state/title such as "Loaded state",
  "Empty state", "Error state", "Mobile layout", or "PR sidebar". Each screenshot should be a small
  thumbnail that links to the full-size upload. Use HTML thumbnails like
  `<a href="FULL_URL.jpg"><img src="FULL_URL.jpg" alt="Loaded state" width="240"></a>` instead of
  large raw Markdown images.
- Prefer annotated screenshots with a colored box, outline, arrow, or highlighter showing the
  changed area. Do not commit review-only screenshots, recordings, or `docs/review-evidence/**`
  files unless they are real product assets.

Cloudflare/deploy:

- Production UI deploys through the `gittensory-ui` Cloudflare Worker on
  `https://gittensory.aethereal.dev/`.
- Production API deploys through the `gittensory-api` Cloudflare Worker on
  `https://gittensory-api.aethereal.dev/`.
- Cloudflare Workers Builds owns automatic deployments from GitHub for BOTH workers (one connection
  per worker, scoped by build-watch-paths). GitHub Actions are validation/fallback only — do not add
  deploy workflows.
  - `gittensory-api` deploy command: `npm run deploy:api` (applies pending D1 migrations, then
    `wrangler deploy`). `wrangler d1 migrations apply` is non-interactive in CI and only applies
    PENDING migrations, so schema + code stay in sync on every build. Recommended build-watch-paths —
    include: `src/**`, `wrangler.jsonc`, `migrations/**`, `package.json`, `package-lock.json`,
    `tsconfig*.json`, `drizzle.config.ts`; exclude: `apps/**`, `docs/**`, `**/*.md`.
  - `gittensory-ui` build command: `npm run build:cloudflare`. Scope its watch-paths to
    `apps/gittensory-ui/**` (note: the UI build runs `ui:openapi` off the API contract, so rebuild the
    UI after API OpenAPI changes).
- Do not re-add GitHub Pages or static-site deployment workflows.

MCP:

- Preserve backwards compatibility where practical.
- Keep CLI output stable and JSON output parseable.
- `gittensory-mcp init-client --print` supports `codex`, `claude`, `cursor`, and `mcp` (generic
  JSON hosts that use the `mcpServers` shape).
- MCP package releases are prepared separately and published from protected `mcp-vX.Y.Z` tags.

Public GitHub surfaces:

- Keep public comments advisory, sanitized, and low-noise.
- Keep labels limited to configured labels for officially confirmed Gittensor miner PRs.
- Never publish private reviewability, scoring, wallet, hotkey, or reward/risk context.
- The Gittensory Orb Review Agent blocks **only confirmed Gittensor contributors**; every other author (and any
  app/infra state) resolves to a neutral, non-blocking gate. Adding a blocker must keep it
  confirmed-contributor-gated through `evaluateGateCheck`.

Config as code (`.gittensory.yml`) — every repository setting is controllable from the config file:

- **`settings:`** is a partial of the repository settings: any behaviour a maintainer can toggle in the
  dashboard can be set here as code — `commentMode`, `publicAudienceMode`, `publicSurface`, `checkRunMode`,
  `gateCheckMode`, the gate-blocker modes, `autoLabelEnabled`, `gittensorLabel`, `requireLinkedIssue`,
  `backfillEnabled`, etc.
- **`gate:`** is a friendly typed alias for the gate subset — `enabled` (on/off), `linkedIssue`,
  `duplicates`, `readiness: { mode, minScore }` (each `off | advisory | block`).
- **`review:`** customizes the public review-panel CONTENT: `footer: { text }` (custom lead copy — the
  Gittensor register link + attribution are always appended), `note` (a custom intro line), and
  `fields: { <row>: false }` to show/hide individual panel rows (`linkedIssue`, `relatedWork`, `reviewLoad`,
  `validationEvidence`, `openPrQueue`, `contributorContext`, `gateResult`). Maintainer text that fails the
  public-safe filter (reward/score/wallet/hotkey/etc.) is dropped, never published.
- **`repoDocGeneration:`** opts a repo into the AGENTS.md/CLAUDE.md generation roadmap (#2993) — a
  `.gittensory.yml`-only surface with no dashboard/DB counterpart. `enabled` (default `false`) turns it on;
  `scope` (default `["agents"]`) picks which generated file types are in play (`"agents"` for
  AGENTS.md/CLAUDE.md, plus `"skills"` once skill-file generation lands); `allowOverwriteExisting` (default
  `false`) is a separate opt-in required before the engine proposes an overwrite for a repo that already has
  a hand-maintained AGENTS.md/CLAUDE.md — absent it, an existing hand-written file is left alone and
  generation is skipped.
- Precedence: `.gittensory.yml` `gate:` > `.gittensory.yml` `settings:` > dashboard repository settings >
  safe defaults; unset fields fall back to the next layer. The committed root `.gittensory.yml` is the
  worked example. Resolved once in `resolveRepositorySettings`, so the whole app honours the file.
- The config chooses **what** gittensory does (gate on/off, blockers, comments, labels, surface, panel
  content); it never changes **who** can be blocked — only confirmed Gittensor contributors are ever
  hard-blocked, and the footer's Gittensor attribution/register link always remains.

## Commit And PR Titles

Use Conventional Commit style for PR titles and release-quality commit messages:

```text
feat(api): add maintainer queue signal
fix(ui): restore signed-out app empty state
test(mcp): cover compatibility fallback
docs(contributing): clarify review gates
```

Use one of these types: `feat`, `fix`, `test`, `docs`, `refactor`, `build`, `ci`, `chore`, or
`revert`. Keep the scope lowercase and specific, such as `api`, `ui`, `mcp`, `extension`, `auth`,
`github`, `signals`, `data`, `docs`, or `release`. Avoid vague scopes or summaries such as
`misc`, `general`, `updates`, `update stuff`, or `small tweaks`. Do not end PR titles with a
trailing period. Release PR titles must use `chore(release): <version>`.
