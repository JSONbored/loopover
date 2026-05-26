# For Miners

Gittensory helps miners decide what to do next with evidence instead of guesswork.

## What It Answers

- Is this repo a direct-PR lane, issue-discovery lane, split lane, inactive lane, or unknown lane?
- Am I in a normal contributor lane or a maintainer lane for this repo?
- Does my current branch look reviewable?
- What blocks scoreability right now?
- Should I clean up open PRs before opening more work?
- Is there duplicate or WIP collision risk?
- What public-safe PR packet should I give a maintainer?

## Branch Analysis

Run from a Git repo:

```sh
gittensory-mcp analyze-branch --login YOUR_GITHUB_LOGIN --json
```

The response includes:

- lane context
- role context
- preflight findings
- private score blockers
- reward/risk reasoning
- maintainer-fit notes
- public-safe PR packet
- ranked next actions

## Preflight

```sh
gittensory-mcp preflight --login YOUR_GITHUB_LOGIN --json
```

Use this before opening a PR. It is especially useful when you need to know whether a branch is missing tests, missing a linked issue, colliding with active work, or likely to increase maintainer burden.

## How This Helps

Gittensory does not promise payouts. It explains scoreability and risk:

- open PR pressure
- credibility assumptions
- lane eligibility
- issue-discovery vs direct PR fit
- duplicate clusters
- stale work
- review friction

That makes recommendations actionable: land or withdraw blocked work, avoid direct PRs in issue-discovery-only repos, improve validation evidence, or pick a repo where your history and the lane actually fit.
