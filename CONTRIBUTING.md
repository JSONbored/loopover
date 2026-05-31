# Contributing

Gittensory is a backend-only project. Contributions should improve the API, GitHub App, MCP
surface, registry/backfill jobs, signal logic, tests, or operational safety.

## Scope

Accepted contribution areas:

- deterministic signal builders for contributors, maintainers, and repo owners
- GitHub App webhook, check-run, and sanitized comment behavior
- registry, bounty, issue, PR, label, queue, and collision ingestion
- Cloudflare Worker, D1, Queue, and scheduled job reliability
- MCP tools and the thin npm MCP wrapper
- test coverage, invariants, fixtures, OpenAPI/MCP contracts, and CI hardening

Out of scope:

- frontend UI work
- public leaderboards
- public wallet or raw trust-score exposure
- auto-closing, auto-merging, rewriting contributor work, or applying labels outside the explicit confirmed-miner GitHub App policy
- storing contributor PATs
- public text that implies compensation estimates or optimization tactics

## Quality Bar

- Run `npm run test:ci` before submitting changes.
- Run `npm run test:coverage` locally when you change behavior. CI enforces **95%** global coverage for lines, statements, functions, and branches.
- Aim for **96%+ branch coverage** locally so small CI variance does not fail near the threshold.
- Add or update tests for every behavior change: new branches, fallback paths, sanitizer rules, and regressions.
- Add invariant or property-style tests when behavior depends on sorting, gating, public/private boundaries, scoring, queue pressure, or source-upload safety.
- Keep changes backend-only.
- Tests must cover new behavior or regressions, including fallback paths and sanitizer boundaries when touched.
- Public GitHub comments must be tested against forbidden language when comment text changes (wallet, hotkey, raw trust score, payout, reward estimate, farming, private reviewability, public score estimate).
- Keep API and MCP responses structured and machine-readable.
- Keep public GitHub comments advisory, sanitized, and non-spammy.
- Keep GitHub App labels limited to configured labels for officially confirmed Gittensor miner PRs.
- Public surfaces must not expose secrets, wallet details, raw trust scores, or private rankings.
- Public text must avoid compensation-seeking or optimization-tactic language.
- OpenAPI and MCP schemas must stay aligned with behavior.
- Prefer deterministic, evidence-based rules over opaque scoring.
- Use Conventional Commit style for release-quality changelog output.
- Do not update changelogs unless you are explicitly preparing a release.
