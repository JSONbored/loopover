# For Maintainers

Gittensory is meant to make Gittensor-driven contribution flow less noisy.

## GitHub App Surface

The GitHub App creates the detailed maintainer surface:

- Gittensory check runs on PRs
- reviewability context
- linked issue and duplicate signals
- contributor role context
- queue and repo-lane context
- optional public-safe sticky PR comments

The check run is the canonical detailed report. Public comments are opt-in and sanitized.

## Reviewability Actions

Gittensory maps PRs to maintainer-friendly actions:

- `review_now`
- `needs_author`
- `likely_duplicate`
- `close_or_redirect`
- `watch`
- `maintainer_lane`

The point is not to shame contributors. The point is to identify the lowest-friction next step.

## Public Comments

Public comments stay off by default.

When enabled, comments can include:

- contribution context
- PR hygiene
- duplicate or WIP risk
- maintainer review notes
- contributor next steps

Comments must not include raw trust scores, wallet data, hotkeys, public reward estimates, or public score optimization language.

## Repo Owner Signals

Repo owners can use Gittensory to inspect:

- repo lane clarity
- label configuration
- maintainer cut readiness
- queue health
- contributor intake health
- GitHub App installation health
- stale or degraded backfill state
