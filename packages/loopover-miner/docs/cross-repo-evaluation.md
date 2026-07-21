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
- **`fullExecution`** — when `true`, this entry is part of the full-execution subset (#7634): a bare
  `--full-execution` run drives the live attempt against every entry flagged `true` (see below)

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
   - `--full-execution` — run the live attempt loop instead of the readiness check (see below)

## Full-execution mode (#7634)

Readiness answers *"can the miner form a plan for this repo."* **Full-execution mode** answers the real question
behind [#4810](https://github.com/JSONbored/loopover/issues/4810)'s launch-readiness bar — *"does the miner
actually produce working, correct code for this repo"* — by driving the live **discover → plan → code → test**
loop against a subset of the same benchmark repos:

```bash
# Runs every manifest entry flagged "fullExecution": true; --repo overrides and runs one entry.
MINER_CODING_AGENT_PROVIDER=... node packages/loopover-miner/scripts/cross-repo-evaluation.mjs --full-execution
```

It is **dry-run only**, the same read/execute-locally-and-discard posture as the readiness harness, one step
further: the coding agent edits a **throwaway local clone**, the harness captures the resulting diff with `git`
and runs the target repo's **own** build + test commands (from stack detection) locally. There is **no live
GitHub PR submission, no write access to the third-party repos, and no credentials beyond the local clone** — a
PR that adds real PR-submission against a benchmark repo does not satisfy this mode.

Each subset repo still receives one **pass/fail** line in the same report format. A repo **passes** only when the
agent produced a real (non-empty) diff, it built, and the target test suite passed. The failure taxonomy extends
the readiness categories with execution-specific ones:

| Category | Meaning |
| --- | --- |
| `execution_no_diff` | The agent ran (or could not be launched) but produced no usable diff |
| `execution_compile_gap` | The generated diff did not build |
| `execution_test_failure` | The diff built but the target repo's own test suite failed |
| `execution_noop_diff` | Tests passed only because the diff was a no-op (no file changes) |

Readiness-stage failures (`stack_detection_gap`, `clone_setup`, `loopover_assumption`, `execution_gap`) still
apply and short-circuit before the agent runs — a repo the miner cannot even plan for never reaches execution.

Library entry points: `executeRepoAttempt(entry, options)` and `runCrossRepoExecution(parsed, options)` classify
the outcome; the coding-agent step, build, and test runners are all injectable (the CLI wires the real
driver-backed executor; unit tests inject fakes).

## Library API

Pure functions live in [`lib/cross-repo-evaluation.js`](../lib/cross-repo-evaluation.js):

- `parseCrossRepoEvaluationManifest(content)`
- `evaluateRepoReadiness(entry, options)` — inject `existsSync`, `detectRepoStack`, etc. for unit tests
- `runCrossRepoEvaluation(parsed, options)`
- `summarizeCrossRepoEvaluation(results)`
- `formatCrossRepoEvaluationReport(results, summary)`

## Wiring

The default mode is **readiness-only**: it does not run the coding agent, open PRs, or call forge APIs. A green
report means the miner’s repo-agnostic stack-detection and coding-task-spec path is prepared for the benchmark
repo. `--full-execution` (#7634) goes one step further and runs the agent locally against a throwaway clone, but
still opens no PRs and performs no forge writes. A production attempt against a real target still needs
credentials, governor policy, and queue state as documented in [`DEPLOYMENT.md`](../DEPLOYMENT.md).
