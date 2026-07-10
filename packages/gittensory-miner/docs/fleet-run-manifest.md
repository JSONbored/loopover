# Fleet run-manifest

The **fleet run-manifest** is the top-level config a *fleet operator* authors to run the miner across many repos
at once: it declares which repos are in scope for a fleet run and how a finite worktree/concurrency budget is
split between them. It is parsed by `parseFleetRunManifestContent` / `parseFleetRunManifest` in
`@jsonbored/gittensory-engine` (`packages/gittensory-engine/src/fleet-run-manifest.ts`).

It is **not** the same file as `.gittensory-miner.yml` (see [`miner-goal-spec.md`](./miner-goal-spec.md)) — the
naming is easy to conflate. Same tolerant-parser convention (every field optional, unknown keys ignored, a
malformed field degrades to a documented default with a warning rather than throwing), but the opposite author
and the opposite direction of intent:

| | `.gittensory-miner.yml` (goal spec) | fleet run-manifest |
|---|---|---|
| **Author** | a target repo's maintainer | the miner (fleet) operator |
| **Lives in** | the target repo | the operator's fleet-run config |
| **Direction** | how this one repo wants to be approached | which repos to work across, and how to split the budget |
| **Scope** | one repo | many repos in one run |
| **Key fields** | `minerEnabled`, `wantedPaths`, `blockedPaths`, `preferredLabels`, `blockedLabels`, `maxConcurrentClaims`, `issueDiscoveryPolicy` | `repos` (each `owner/repo` + `maxConcurrentWorktrees`), `totalConcurrentWorktrees` |

## Schema

Every field is optional; unknown keys are ignored; a malformed field falls back to a documented default with a
warning rather than hard-failing the run.

- **`repos`** — a list of target repos. Each entry is either a bare `"owner/repo"` string (uses the default
  per-repo budget) or a `{ repoFullName, maxConcurrentWorktrees }` mapping. Invalid or duplicate entries are
  skipped with a warning. `repoFullName` is a canonical `owner/repo`, compatible with `opportunity-fanout.js`'s
  target list. Default: `[]`.
- **`repos[].maxConcurrentWorktrees`** — max concurrent worktrees (in-flight attempts) for that repo. A positive
  integer (floored; sub-1 falls back to the default). Default: `1`.
- **`totalConcurrentWorktrees`** — total concurrent worktrees across the whole fleet, regardless of per-repo
  budgets. A positive integer. Default: `1`.

## Wiring

This module produces only the parsed, typed manifest. Driving the fleet concurrency allocator from it is the
allocator's concern (sibling `feat(miner-concurrency): add git-worktree-per-attempt allocator` issue), and the
cross-repo `portfolio-queue.js` backlog reads the same repo list — both *consume* this manifest; neither wiring
lives here.

## Example (`fleet-run.yml`)

```yaml
totalConcurrentWorktrees: 4
repos:
  - owner/repo-a
  - repoFullName: owner/repo-b
    maxConcurrentWorktrees: 2
```
