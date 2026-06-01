# Contributing

Gittensory is a Cloudflare Workers, TanStack Start, GitHub App, and MCP project for
Gittensor OSS contribution intelligence. Contributions need to protect that scope: private
signals stay private, public GitHub output stays sanitized, and production surfaces must stay
wired to real backend behavior.

This project is maintained with a high review bar. PRs that ignore these guidelines, mix
unrelated work, reintroduce retired architecture, or repeatedly fail the required gates may be
closed without an extended review cycle.

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
  OAuth; CLI/MCP auth is GitHub Device Flow.
- Large dependency major upgrades bundled with unrelated product changes.
- Changelog edits in ordinary feature/fix PRs. Changelogs are updated during release prep.
- Low-effort reward-farming changes, spam, generated bulk edits, or PRs that do not explain the
  product impact.

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

- A clear summary of what changed and why.
- A linked issue or a short explanation for why no issue is needed.
- The exact validation commands run from the repo root.
- Screenshots or a short screen recording for visible UI changes.
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
npm run typecheck
npm run test:coverage
npm run test:workers
npm run build:mcp
npm run test:mcp-pack
npm run ui:openapi:check
npm run ui:lint
npm run ui:typecheck
npm run ui:build
npm audit --audit-level=moderate
```

`npm run test:ci` runs the normal combined gate. Coverage must stay at or above 97% for
statements, branches, functions, and lines.

Maintainer/release smoke checks:

```sh
npm run test:smoke:production
npm run test:smoke:browser:install
npm run test:smoke:browser
```

The browser smoke path is manual until it is stable enough to make required on every PR.

## Test Expectations

Tests should prove behavior, not just exercise lines for coverage.

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

Cloudflare/deploy:

- Production UI deploys through the `gittensory-ui` Cloudflare Worker on
  `https://gittensory.aethereal.dev/`.
- Production API deploys through the `gittensory-api` Cloudflare Worker on
  `https://gittensory-api.aethereal.dev/`.
- Cloudflare Workers Builds owns automatic UI deployments from GitHub. GitHub Actions UI deploy is
  manual validation/fallback only.
- Do not re-add GitHub Pages or static-site deployment workflows.

MCP:

- Preserve backwards compatibility where practical.
- Keep CLI output stable and JSON output parseable.
- MCP package releases are prepared separately and published from protected `mcp-vX.Y.Z` tags.

Public GitHub surfaces:

- Keep public comments advisory, sanitized, and low-noise.
- Keep labels limited to configured labels for officially confirmed Gittensor miner PRs.
- Never publish private reviewability, scoring, wallet, hotkey, or reward/risk context.

## Commit And PR Titles

Use Conventional Commit style for PR titles and release-quality commit messages:

```text
feat(api): add maintainer queue signal
fix(ui): restore signed-out app empty state
test(mcp): cover compatibility fallback
docs(contributing): clarify review gates
```
