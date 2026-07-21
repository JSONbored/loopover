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
   - `--full-execution` — **dry-run** execution mode (#7634): clone each repo, run the
     discover→plan→code→test loop locally, and run the target repo's own tests. See below.

## Full execution mode (dry-run) (#7634)

`--full-execution` opts into a **dry-run** that goes one step past readiness: for every repo that already passes the
readiness gate above, it actually runs the discover→plan→code→test loop **locally** and reports pass/fail with
execution-specific categories. It is strictly **read/execute-locally-and-discard**:

1. **Clone / checkout** the repo locally (via `ensureRepoCloned`; a read-only local clone — never a write-back)
2. **Plan** — recompose the same (leak-free) coding-task spec used by readiness
3. **Code** — run the coding agent to produce a diff (the default is a **non-spawning shadow** that produces no
   diff and uses no credentials; inject `runCodingAgent` to drive a real/fake agent)
4. **Test** — run the **target repo's own** inferred test command locally against the produced change

The execution-specific failure categories extend (never replace) the readiness taxonomy:

| Category | Meaning |
| --- | --- |
| `exec_setup_gap` | Clone / checkout of the target repo failed before the loop could start |
| `plan_compile_gap` | Plan formed but the code phase did not produce a compiling change |
| `test_failure` | Change compiled but the target repo's own tests failed (or timed out) |
| `no_op_diff` | Tests passed but the coding agent produced an empty (no-op) diff |

The report gains one line, `dry-run full-execution: N/total entered the code+test loop`, and the readiness format is
otherwise unchanged. **Dry-run safety is structural:** there is no PR-open / forge-write / credential path anywhere
in the execution loop — the clone, coding-agent, and test-run steps are all injectable seams (`cloneRepo`,
`runCodingAgent`, `runTests`) that unit tests replace with fakes for zero real IO. No `gh pr create`, no forge API,
no third-party write ever runs.

## Library API

Pure functions live in [`lib/cross-repo-evaluation.js`](../lib/cross-repo-evaluation.js):

- `parseCrossRepoEvaluationManifest(content)`
- `evaluateRepoReadiness(entry, options)` — inject `existsSync`, `detectRepoStack`, etc. for unit tests
- `runCrossRepoEvaluation(parsed, options)`
- `evaluateRepoExecution(entry, options)` — dry-run full-execution (#7634); inject `cloneRepo`, `runCodingAgent`,
  `runTests` for unit tests
- `runCrossRepoExecution(parsed, options)` — full-execution across a parsed manifest
- `summarizeCrossRepoEvaluation(results)`
- `formatCrossRepoEvaluationReport(results, summary)`

## Wiring

By default this harness is **readiness-only**: it does not run the coding agent, open PRs, or call forge APIs. A
green report means the miner’s repo-agnostic stack-detection and coding-task-spec path is prepared for the benchmark
repo. `--full-execution` opts into a live-ish **dry-run** that additionally clones, runs the coding agent, and runs
the target repo's own tests locally — but still **never opens a PR or writes to the third-party repo**; a real
attempt that submits a PR still needs credentials, governor policy, and queue state as documented in
[`DEPLOYMENT.md`](../DEPLOYMENT.md).
