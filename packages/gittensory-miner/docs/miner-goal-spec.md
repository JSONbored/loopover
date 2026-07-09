# MinerGoalSpec (`.gittensory-miner.yml`)

Per-repo configuration telling an autonomous Gittensory miner what to look for and how to behave when targeting a repo. Parsed by `@jsonbored/gittensory-engine` (`parseMinerGoalSpec` / `parseMinerGoalSpecContent`); this document is the field reference. Machine-readable shape: [`../schema/miner-goal-spec.schema.json`](../schema/miner-goal-spec.schema.json). Copy [`.gittensory-miner.yml.example`](../../../.gittensory-miner.yml.example) to `.gittensory-miner.yml` and edit.

Discovery order (first match wins):

- `.gittensory-miner.yml`
- `.github/gittensory-miner.yml`
- `.gittensory-miner.json`
- `.github/gittensory-miner.json`

Every field is optional. Unknown keys are ignored; a malformed field falls back to its documented default with a warning — a broken file never hard-fails the miner.

## Relationship to `.gittensory.yml`

| File | Actor | Purpose |
|------|-------|---------|
| `.gittensory.yml` | Review stack | How a maintainer's repo **reviews** incoming PRs (focus manifest, gate, scoring knobs). |
| `.gittensory-miner.yml` | Miner runtime | How a miner **searches for and prioritizes** work in a target repo. |

They are read by different components and do not conflict. A miner should still treat a target repo's public `.gittensory.yml` `wantedPaths` / `blockedPaths` as a hard floor when both files exist.

## Fields

### `minerEnabled` (boolean, default: `true`)

Explicit opt-out: a public repo with no file remains minable. Set `false` to halt all miner targeting.

### `wantedPaths` (string list, default: `[]`)

Work areas the maintainer wants a miner to focus on. Glob list. Empty means no preference.

### `blockedPaths` (string list, default: `[]`)

Paths off-limits to a miner; candidates touching one should be skipped. Glob list. Mirrors `.gittensory.yml` `blockedPaths` semantics.

### `preferredLabels` (string list, default: `[]`)

Issue labels a miner should favor. Empty means no preference.

### `blockedLabels` (string list, default: `[]`)

Issue labels a miner must skip.

### `maxConcurrentClaims` (integer `>= 1`, default: `1`)

Maximum issues one miner may hold claimed on this repo at once.

### `issueDiscoveryPolicy` (`encouraged` | `neutral` | `discouraged`, default: `neutral`)

How strongly this repo encourages a miner to open discovery issues.

### `feasibilityGate` (mapping, default: inert)

Per-repo tuning for the miner's feasibility gate — how selective a miner is about which candidate issues it deems workable before spending effort. Additive and OFF by default: with the defaults below the gate never blocks, so a repo that omits this block behaves exactly as before.

| Sub-field | Type | Default | Meaning |
|-----------|------|---------|---------|
| `minFeasibilityScore` | number in `[0, 1]` | `0` | Minimum feasibility score a candidate must reach for a miner to pursue it. `0` means no floor. Out-of-range or non-finite values clamp into `[0, 1]` with a warning. |
| `suppressedAvoidReasons` | string list | `[]` | Feasibility "avoid" reason keys this repo downgrades from blocking to advisory ("that reason does not apply here"). Free-form; unknown keys are tolerated. |

```yaml
feasibilityGate:
  minFeasibilityScore: 0.4
  suppressedAvoidReasons:
    - missing_local_test_harness
```

The feasibility-gate composer (a separate change) is the consumer of this block; this is only the config surface a maintainer tunes.
