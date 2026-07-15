# Cross-repo evaluation harness

The **cross-repo evaluation harness** (#4788) is a repeatable readiness check that asks whether the miner can
approach a diverse benchmark repo set **without gittensory-specific target-repo configuration** (no
`.loopover-miner.yml` required in the benchmark repos). It exercises the same offline path a real attempt uses
before the coding agent runs:

1. **Clone setup** — the repo exists under `LOOPOVER_MINER_REPO_CLONE_DIR`
2. **Stack auto-detection** (`detectRepoStack`, #4785)
3. **Coding-task spec composition** (`buildCodingTaskSpec`, #4786) including validation guidance derived from the
   detected stack
4. **Assumption scan** — agent instructions must not positively mandate LoopOver/gittensory CI conventions

Each benchmark repo receives a **pass/fail** line. Failures are categorized:

| Category | Meaning |
| --- | --- |
| `stack_detection_gap` | No recognized manifest / stack could not be inferred |
| `execution_gap` | Stack detected but the coding-task path is not ready (e.g. missing inferred test command when required) |
| `gittensory_assumption` | Agent instructions leak gittensory-specific CI assumptions |
| `clone_setup` | The repo has not been cloned to the expected cache path |
| `other` | Unexpected errors |

The run also reports whether a **strict majority** of repos passed and how many succeeded **without** a per-target
`.loopover-miner.yml` (the default goal spec is acceptable).

## Benchmark manifest

Committed at [`benchmarks/cross-repo/manifest.json`](../benchmarks/cross-repo/manifest.json). Each entry is either a
bare `"owner/repo"` string or an object:

- **`repoFullName`** — canonical `owner/repo`
- **`stackHint`** — documentation only (not used by the evaluator)
- **`requireTestCommand`** — when `true`, stack detection must infer a test command or the repo fails with
  `execution_gap`

Malformed manifest fields degrade to documented defaults with warnings (same tolerant-parser convention as the
fleet run-manifest).

## Running locally

1. Clone the benchmark repos into the miner clone cache (once per machine):

   ```bash
   export LOOPOVER_MINER_REPO_CLONE_DIR="${LOOPOVER_MINER_REPO_CLONE_DIR:-$HOME/.config/loopover-miner/repos}"
   mkdir -p "$LOOPOVER_MINER_REPO_CLONE_DIR"
   # Example for one entry — repeat for each repo in the manifest
   git clone --depth 1 https://github.com/sindresorhus/is.git "$LOOPOVER_MINER_REPO_CLONE_DIR/sindresorhus/is"
   ```

2. Run the harness from the repo root:

   ```bash
   node packages/loopover-miner/scripts/cross-repo-evaluation.mjs
   ```

   Useful flags:

   - `--json` — machine-readable `{ warnings, results, summary }` payload
   - `--repo owner/repo` — evaluate a single manifest entry
   - `--manifest path/to/manifest.json` — alternate benchmark set (e.g. a fixture manifest in tests)
   - `--require-majority` — exit `1` unless a strict majority of repos pass (for CI-style gating)

## Library API

Pure functions live in [`lib/cross-repo-evaluation.js`](../lib/cross-repo-evaluation.js):

- `parseCrossRepoEvaluationManifest(content)`
- `evaluateRepoReadiness(entry, options)` — inject `existsSync`, `detectRepoStack`, etc. for unit tests
- `runCrossRepoEvaluation(parsed, options)`
- `summarizeCrossRepoEvaluation(results)`
- `formatCrossRepoEvaluationReport(results, summary)`

## Wiring

This harness is **readiness-only**: it does not run the coding agent, open PRs, or call forge APIs. A green report
means the miner’s repo-agnostic stack-detection and coding-task-spec path is prepared for the benchmark repo; a live
attempt still needs credentials, governor policy, and queue state as documented in the
[AMS deployment guide](https://loopover.ai/docs/ams-deployment).
