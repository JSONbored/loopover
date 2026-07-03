# `.gittensory-miner.yml` — MinerGoalSpec reference

`.gittensory-miner.yml` is a per-repo config file that tells autonomous gittensory **miners** what work to
look for in a repo and how to behave when targeting it. It is the miner-facing sibling of `.gittensory.yml`.

- The machine-readable schema is [`schema/miner-goal-spec.schema.json`](../schema/miner-goal-spec.schema.json)
  (JSON Schema draft 2020-12).
- A ready-to-copy commented example lives at [`.gittensory-miner.yml.example`](../../../.gittensory-miner.yml.example) at the repo root.
- The parsed shape is the `MinerGoalSpec` type in
  [`packages/gittensory-engine/src/miner-goal-spec.ts`](../../gittensory-engine/src/miner-goal-spec.ts); this
  document tracks that type (the source of truth), not any earlier field sketch.

**Discovery order (first match wins):** `.gittensory-miner.yml` → `.github/gittensory-miner.yml` →
`.gittensory-miner.json` → `.github/gittensory-miner.json`. YAML or JSON are both accepted.

**Safe by default:** every field is optional and has a safe default. A public repo with no file is still minable
under quiet defaults. The file is parsed tolerantly — an unknown key is ignored and a single malformed field falls
back to its default with a warning, so a broken file never hard-fails a miner.

## Fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `minerEnabled` | boolean | `true` | Whether this repo permits autonomous miners at all. Explicit **opt-out**: set `false` to halt all miner targeting of this repo. |
| `wantedPaths` | glob list | `[]` | Work areas a miner should prefer; a candidate touching these is favored. |
| `blockedPaths` | glob list | `[]` | Paths off-limits to a miner; a candidate touching one of these should be skipped. |
| `preferredLabels` | string list | `[]` | Issue/PR labels a miner should prefer to target; a candidate carrying one is favored. |
| `blockedLabels` | string list | `[]` | Issue/PR labels a miner must not target; a candidate carrying one should be skipped. |
| `maxConcurrentClaims` | integer ≥ 1 | `1` | Maximum issues a single miner may hold claimed on this repo at once, so no one miner monopolizes the queue. A non-integer is floored toward zero and a value below 1 is rejected. |
| `issueDiscoveryPolicy` | `encouraged` \| `neutral` \| `discouraged` | `neutral` | How strongly this repo encourages a miner to open discovery issues. |

## Example

```yaml
minerEnabled: true
wantedPaths:
  - "src/**"
blockedPaths:
  - "vendor/**"
  - ".github/workflows/**"
preferredLabels:
  - bug
  - enhancement
blockedLabels:
  - wontfix
maxConcurrentClaims: 1
issueDiscoveryPolicy: neutral
```

## Relationship to `.gittensory.yml`

`.gittensory.yml` and `.gittensory-miner.yml` are read by **different actors** and never conflict:

- **`.gittensory.yml`** governs how a maintainer's repo **reviews** incoming PRs (the review focus-manifest parsed
  by `src/signals/focus-manifest.ts`) — how the *reviewer* behaves.
- **`.gittensory-miner.yml`** governs how a miner **searches for and prioritizes** work in a target repo — how the
  *miner* behaves.

They are independent, but a well-behaved miner should still treat a target repo's public `.gittensory.yml`
`wantedPaths` / `blockedPaths` as a hard floor: never work a path the repo's own review manifest blocks, regardless
of this file's preferences.
