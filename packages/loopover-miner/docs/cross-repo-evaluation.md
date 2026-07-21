# Cross-repo evaluation harness

The **cross-repo evaluation harness** (#4788) is a repeatable readiness check that asks whether the miner can
approach a diverse benchmark repo set **without loopover-specific target-repo configuration** (no
`.loopover-miner.yml` required in the benchmark repos). It exercises the same offline path a real attempt uses
before the coding agent runs:

1. **Clone setup** — the repo exists under `LOOPOVER_MINER_REPO_CLONE_DIR`
2. **Stack auto-detection** (`detectRepoStack`, #4785)
3. **Coding-task spec composition** (`buildCodingTaskSpec`, #4786) including validation guidance derived from the
   detected stack
4. **Assumption scan** — agent instructions must not positively mandate LoopOver's own CI conventions

Each benchmark repo receives a **pass/fail** line. Failures are categorized:

| Category | Meaning |
| --- | --- |
| `stack_detection_gap` | No recognized manifest / stack could not be inferred |
| `execution_gap` | Stack detected but the coding-task path is not ready (e.g. missing inferred test command when required) |
| `loopover_assumption` | Agent instructions leak loopover-specific CI assumptions |
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

## Full-execution mode (#7634)

Readiness answers *“can the miner form a plan for this repo?”*. **Full-execution** goes one step further and answers
*“does the miner actually produce working, correct code?”* by running the discover → plan → code → test loop against
each benchmark repo: it drives the configured coding agent to generate a **real diff**, then runs that target repo's
**own test suite** locally against the edited clone.

It is **dry-run only**. The agent really edits the local clone (that is the only way to produce a diff), but the
harness hard-resets the clone back to `HEAD` afterward — it **never opens a PR, never pushes, and never touches the
third-party repo remotely**. It needs nothing beyond a local clone and a configured coding-agent driver; no write
access or forge credentials are required.

### Running it

```bash
node packages/loopover-miner/scripts/cross-repo-evaluation.mjs --full-execution
```

Combinable with the readiness flags: `--repo owner/repo`, `--json`, `--manifest path/to/manifest.json`, and
`--require-majority`.

Prerequisites:

- **Cloned benchmark repos** in `LOOPOVER_MINER_REPO_CLONE_DIR` (same as readiness — see
  [Running locally](#running-locally)).
- **A configured coding-agent driver** via `MINER_CODING_AGENT_PROVIDER` plus that provider's credentials — the same
  requirement a real attempt has. Without a configured driver, each repo reports an `other` execution failure (no diff
  can be generated).

### Execution failure taxonomy

Failures are categorized under `CROSS_REPO_EXECUTION_CATEGORY`, extending the readiness taxonomy for the code + test
loop:

| Category | Meaning |
| --- | --- |
| `plan_not_formed` | Readiness failed — the miner couldn't even form a plan for the repo |
| `code_build_failed` | Plan formed and the agent produced a diff, but the code didn't compile/build |
| `tests_failed` | Code compiled but the target repo's own tests failed |
| `no_op_diff` | Tests passed but the agent's diff was empty (no real change — a trivial pass) |
| `clone_setup` | The repo isn't cloned to the expected path |
| `other` | Unexpected error (e.g. no coding-agent driver configured, no inferred test command, agent crashed) |

The stages run **in order** — plan → code → build → tests → no-op check — so a repo that fails an earlier stage is
reported against that stage (e.g. a repo that never forms a plan reports `plan_not_formed` and the build/test stages
never run).

## Library API

Pure functions live in [`lib/cross-repo-evaluation.js`](../lib/cross-repo-evaluation.js):

- `parseCrossRepoEvaluationManifest(content)`
- `evaluateRepoReadiness(entry, options)` — inject `existsSync`, `detectRepoStack`, etc. for unit tests
- `runCrossRepoEvaluation(parsed, options)`
- `summarizeCrossRepoEvaluation(results)`
- `formatCrossRepoEvaluationReport(results, summary)`

Full-execution mode (#7634) adds:

- `evaluateRepoFullExecution(entry, options)` — async; inject the `runAgentAttempt`, `buildRepo`, and `runRepoTests`
  seams for unit tests
- `runFullCrossRepoExecution(parsed, options)` — async
- `summarizeCrossRepoExecution(results)`
- `formatCrossRepoExecutionReport(results, summary)`

## Wiring

The harness has **two modes**, and **neither** opens a live PR or performs any forge writes:

- **Readiness-only** (default): it does not run the coding agent, open PRs, or call forge APIs. A green report means
  the miner’s repo-agnostic stack-detection and coding-task-spec path is prepared for the benchmark repo.
- **Dry-run full-execution** (`--full-execution`, #7634): it runs the coding agent and the target repo's own tests
  against a local clone, then hard-resets the clone — still no live PR and no forge writes.

A live attempt still needs credentials, governor policy, and queue state as documented in
[`DEPLOYMENT.md`](../DEPLOYMENT.md).
