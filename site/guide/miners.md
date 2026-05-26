# For Miners

Gittensory helps miners choose work with evidence: lane fit, score blockers, queue pressure, local diff quality, and realistic scenario projections.

## Branch Analysis Flow

Run this before opening or updating a PR:

```sh
gittensory-mcp analyze-branch --login YOUR_GITHUB_LOGIN --json
```

The response explains:

- repo lane and role context
- current scoreability and blocker gates
- open PR pressure and cleanup-first guidance
- duplicate or WIP collision risk
- stale-base warnings when the local diff looks inflated
- validation evidence from changed test paths and command summaries
- a public-safe PR packet for maintainers

## Scenario Flags

When approved PRs are expected to land soon, pass the assumption explicitly:

```sh
gittensory-mcp analyze-branch --login YOUR_GITHUB_LOGIN \
  --pending-merged-prs 3 \
  --expected-open-prs 0 \
  --projected-credibility 0.8 \
  --scenario-note "approved PRs expected to merge" \
  --json
```

Gittensory labels this as a user-supplied scenario. It separates the current effective score, the underlying potential score, and what changes if open-PR and credibility gates clear.

::: tip No source upload by default
Local branch analysis sends metadata only. File contents are not uploaded.
:::

## Preflight

```sh
gittensory-mcp preflight --login YOUR_GITHUB_LOGIN --json
```

Use preflight when you need a quick answer on linked issues, tests, duplicate risk, lane fit, and maintainer review friction.

## When To Use Gittensory

- before opening a PR
- after PR approvals but before rerunning score projections
- when deciding whether to clean up existing PRs first
- when choosing between direct PR work and issue-discovery flow

Gittensory does not promise payouts. It explains scoreability, risk, and what actions make the work more likely to be reviewable and scoreable.
