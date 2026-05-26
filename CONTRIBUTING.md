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

- Run `npm run test:ci` before opening a PR.
- Add or update tests for behavior changes.
- Keep API and MCP responses structured and machine-readable.
- Keep public GitHub comments advisory, sanitized, and non-spammy.
- Keep GitHub App labels limited to configured labels for officially confirmed Gittensor miner PRs.
- Prefer deterministic, evidence-based rules over opaque scoring.
- Use Conventional Commit style for release-quality changelog output.

## Pull Request Checklist

- The change is backend-only.
- Tests cover the new behavior or regression.
- Public surfaces do not expose secrets, wallet details, raw trust scores, or private rankings.
- Public text avoids compensation-seeking or optimization-tactic language.
- OpenAPI and MCP schemas stay aligned with behavior.
