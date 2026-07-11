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

### `feasibilityGate` (object, default: `{ enabled: true, suppressedReasons: [] }`)

Per-repo tuning for the feasibility gate (`buildFeasibilityVerdict`) a miner consults before starting work. This is config-parsing surface only — a caller wiring the gate into a decision flow is responsible for reading and applying this policy.

- `enabled` (boolean, default: `true`) — whether the feasibility gate is consulted at all before a miner starts work.
- `suppressedReasons` (string list, default: `[]`) — specific avoid/raise reason codes (e.g. `duplicate_cluster_high`) this repo wants ignored.

### `selfPlagiarism` (object, default: `{ similarityThreshold: 0.85 }`)

Per-repo tuning for the Governor self-plagiarism throttle consulted before `open_pr` (#2345). Compares a prospective PR's diff fingerprint against the miner's own recent submission history.

- `similarityThreshold` (number in `[0, 1]`, default: `0.85`) — Jaccard similarity at/above which two fingerprints read as near-duplicates across repos.

### `killSwitch` (object, default: `{ paused: false }`)

Per-repo kill-switch consulted by the Governor chokepoint before every write action (#2341). Distinct from `minerEnabled`: `minerEnabled` is a discovery-time opt-out (a miner never even considers the repo), while `killSwitch.paused` is a runtime halt of an already-in-flight queue — un-pausing resumes exactly where the queue left off. A separate, operator-controlled GLOBAL kill-switch (env var `GITTENSORY_MINER_KILL_SWITCH`) halts every repo at once and always wins over this per-repo flag.

- `paused` (boolean, default: `false`) — halts all miner WRITE actions for this repo without deregistering it from targeting/discovery.
