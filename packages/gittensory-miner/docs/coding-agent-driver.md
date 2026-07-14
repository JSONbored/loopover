# CodingAgentDriver — the miner's coding-agent seam

`CodingAgentDriver` is the single interface a Gittensory miner runs a coding agent through. It lets the miner drive
**either** a local CLI subprocess (e.g. `claude` / `codex`) **or** an in-process Agent SDK `query()` loop behind one
provider-agnostic contract, so the rest of the miner — planning, attempt logging, metering, gate polling — never
has to know which backend actually did the work.

The interface itself lives in `@loopover/engine`
([`packages/gittensory-engine/src/miner/coding-agent-driver.ts`](../../gittensory-engine/src/miner/coding-agent-driver.ts));
the orchestration around it (mode gating, invocation, the factory) lives in the sibling modules described below.

> **See also:** [Observing your miner](observability.md) — point Grafana at the miner's local SQLite ledgers
> (attempt log, prediction ledger) to see what the driver actually did.

## Why a seam, and why this shape

The design deliberately mirrors the review stack's `SelfHostAi` (`src/selfhost/ai.ts`) rather than inventing a new
pattern: a single `run()` method, provider-agnostic task/result types, and **injected dependencies** (spawn fn,
clock, filesystem) on the concrete implementations rather than hardcoded globals. That injection is what keeps every
driver unit-testable without real IO — the same reason `SelfHostAi` takes an injected `SpawnFn`.

The interface defines only the contract. Implementations MAY perform real IO; they never make GitHub writes or
autonomous continue/stop decisions — the task handed to a driver is already scoped.

## The contract

```ts
type CodingAgentDriverTask = {
  attemptId: string; // stable id for this attempt (keys the attempt log)
  workingDirectory: string; // the ONLY directory a driver may edit (see worktree isolation below)
  acceptanceCriteriaPath: string; // path to the immutable acceptance-criteria file written before the run
  instructions: string; // the metadata-only prompt (no source contents)
  maxTurns: number; // hard cap on agent iterations for this attempt
};

type CodingAgentDriverResult = {
  ok: boolean;
  changedFiles: readonly string[];
  summary: string;
  transcript?: string; // opaque provider transcript for operator inspection
  turnsUsed?: number;
  error?: string;
};

interface CodingAgentDriver {
  run(task: CodingAgentDriverTask): Promise<CodingAgentDriverResult>;
}
```

Two reference implementations ship today for tests: `createFakeCodingAgentDriver` (records the last task, no IO) and
`createNoopCodingAgentDriver` (default-OFF stub). The two real backends — a CLI-subprocess driver (#4266) and an
Agent-SDK driver (#4267) — register in `createCodingAgentDriver` as `claude-cli`, `codex-cli`, and `agent-sdk`
(`CODING_AGENT_DRIVER_NAMES`: `["noop", "claude-cli", "codex-cli", "agent-sdk"]`).

## The surrounding primitives

A driver never runs in isolation. The neighborhood it plugs into:

| Concern             | Module                        | What it provides                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution mode      | `coding-agent-mode.ts`        | `paused` / `dry_run` / `live` with deny-toward-safety precedence; `codingAgentModeExecutes(mode)` is the single "should this attempt actually spawn?" boolean. A `dry_run` is a pure no-op at the driver boundary.                                                                                                                             |
| Invocation          | `coding-agent-invoke.ts`      | `invokeCodingAgentDriver(driver, task, mode?, log?)` — gates on the mode, calls `driver.run`, and streams lifecycle events to an `AttemptLogSink`.                                                                                                                                                                                             |
| Factory             | `driver-factory.ts`           | `createCodingAgentDriver(options)` resolves a driver by configured name; `resolveConfiguredCodingAgentDriverNames` / `isConfiguredCodingAgentDriver` deny unknown names by default; `runCodingAgentAttempt(options)` is the top-level "resolve + invoke" convenience.                                                                          |
| Attempt log         | `attempt-log.ts` (#4294)      | `ATTEMPT_LOG_EVENT_TYPES` + `normalizeAttemptLogEvent` + `createAttemptLogBuffer` + `formatAttemptLogJsonl` — an append-only, JSONL-exportable event trace per attempt, independent of any driver's own transcript. Durable persistence: `packages/gittensory-miner/lib/attempt-log.js` (sibling SQLite store; imports the engine normalizer). |
| Metering            | `attempt-metering.ts` (#4311) | `accumulateAttemptUsage` / `meterAttemptUsage` / `evaluateAttemptBudget` over `AttemptBudgetAxis` (`tokens` / `turns` / `wallClockMs` / `costUsd`).                                                                                                                                                                                            |
| Acceptance criteria | (#4271)                       | The immutable criteria file at `task.acceptanceCriteriaPath`, written before the driver starts.                                                                                                                                                                                                                                                |
| Worktree isolation  | (#4269)                       | Each attempt's `task.workingDirectory` is a dedicated git worktree; a driver must never edit outside it.                                                                                                                                                                                                                                       |

## Authoring a third driver

To add a driver beyond the CLI-subprocess and Agent-SDK backends:

1. **Implement the interface.** Export a `create<Name>CodingAgentDriver(deps)` factory returning a `CodingAgentDriver`.
   Take every side-effecting dependency (spawn fn, `query()` client, clock, fs) as an **injected argument** — do not
   reach for globals — so the contract suite can drive it with fakes (mirrors `SpawnFn` injection in `SelfHostAi`).
2. **Honor the task scoping.** Only edit inside `task.workingDirectory`; stop at `task.maxTurns`; read the acceptance
   criteria from `task.acceptanceCriteriaPath`; never make a GitHub write.
3. **Return the result shape faithfully.** Set `ok` from whether acceptance was met, list `changedFiles`, and surface
   failures via `error` (a clean failure) rather than throwing — the invoker records either outcome.
4. **Register it in the factory.** Add the name to `CODING_AGENT_DRIVER_NAMES` and wire `createCodingAgentDriver`, so
   `resolveConfiguredCodingAgentDriverNames` can select it from config (unknown names stay denied by default).
5. **Get covered by the parity/contract suite** (#4296): the suite runs the same scenario fixtures — a clean success,
   a clean failure, a budget/timeout, and a malformed acceptance-criteria input — against every driver with an
   injected backend, asserting identical SHAPE and edge-case handling (not identical output, which is inherently
   non-deterministic across backends).

## A worked attempt lifecycle (the real production path)

`runCodingAgentAttempt`/`invokeCodingAgentDriver` (driver-factory.ts/coding-agent-invoke.ts) are real, tested,
and remain available as a lower-level composable, but **production does not call either of them today**. The
real construction + invocation path, as actually wired into `packages/gittensory-miner`, is:

```
constructProductionCodingAgentDriver(env)        (packages/gittensory-miner/lib/coding-agent-construction.js)
  └─ createCodingAgentDriver({ providerName, spawn, ... })   (driver-factory.ts) → the configured CodingAgentDriver
       │  (house-rule hooks attached by default for agent-sdk via buildHouseRulesAgentSdkHooks -- see below)
       └─ becomes IterateLoopDeps.driver, handed to runIterateLoop (iterate-loop.ts)

runIterateLoop(input, deps)                       (packages/gittensory-engine/src/miner/iterate-loop.ts)
  └─ per iteration, runDriverSafely(input, deps, task):
       ├─ if !codingAgentModeExecutes(input.mode):  → invokeCodingAgentDriver(deps.driver, mode, task, {...})
       │     (paused/dry_run only -- records a shadow/no-op attempt-log event, never spawns the real driver)
       └─ else (live):                              → deps.driver.run(task) directly, NOT via invokeCodingAgentDriver
              → edits inside task.workingDirectory only, ≤ task.maxTurns
       ├─ evaluateSelfReviewOutcome(...) → self-review the resulting diff
       ├─ decideNextActionWithReason(state) → continue | handoff | abandon
       └─ logDecision(...) records ONE attempt-log event per iteration (continue/handoff/abandon), not a
              raw driver-start/succeed/fail pair the way invokeCodingAgentDriver's own wrapper would
```

The attempt log (JSONL) is the durable, provider-independent record of what happened, independent of whichever
backend's own transcript, and the input to the miner's manage-phase and self-improve loops.

`packages/gittensory-miner/lib/coding-agent-house-rules.js`'s `runHouseRulesEnforcedCodingAgentAttempt` (a
drop-in wrapper over `runCodingAgentAttempt`) exists for a caller that wants the alternate, non-iterate-loop
path with house-rule enforcement built in by default -- no such caller exists in production today either; the
real house-rule enforcement for the live `agent-sdk` provider happens via `buildHouseRulesAgentSdkHooks`,
attached directly in `constructProductionCodingAgentDriver`.

**Metering:** `attempt-metering.ts`'s `accumulateAttemptUsage`/`evaluateAttemptBudget` are wired into
`iterate-loop.ts` for real ([#5395](https://github.com/JSONbored/gittensory/issues/5395)) -- every iteration
accumulates real `turns`/`costUsd`/`wallClockMs` (`tokens` stays an honest 0; no driver reports a real
per-iteration token count today) into a running `AttemptMeterTotals`, and `runIterateLoop`'s optional
`input.budget: AttemptBudget` is evaluated against it each iteration via the SAME `costCeilingReached` signal
`iterate-policy.ts` already exposed for the (now-removed) turns-only `maxTotalTurns` ceiling -- a genuine
mid-attempt abort, not just a between-cycle cap. `packages/gittensory-miner/lib/attempt-input-builder.js`'s
`buildAttemptLoopInput` sets `budget` from the SAME `AmsPolicySpec.capLimits` the Governor's cross-cycle
`GovernorCapUsage` already uses (`packages/gittensory-miner/lib/loop-cli.js`'s `governorState.saveCapUsage`
between loop cycles) -- one attempt can no longer burn through the entire cross-cycle budget before anything
reacts. `wallClockMs` uses a real injected clock (`IterateLoopDeps.nowMs`, defaulting to `Date.now`) measured
around each iteration's driver invocation. The result's `finalMeterTotals`/`budgetBreaches` fields surface
which axis (if any) triggered an abandon, for an operator reading the attempt log back.

## Related docs

- [`operations-runbook.md`](operations-runbook.md) — SQLite `busy_timeout` concurrency, corruption recovery, multi-process collisions, post-upgrade migration ([#4875](https://github.com/JSONbored/gittensory/issues/4875)).
- [`env-reference.md`](env-reference.md) — env vars including ledger path overrides.
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — laptop vs fleet deployment and state directory layout.
- [`miner-goal-spec.md`](miner-goal-spec.md) — per-repo `.gittensory-miner.yml` targeting policy.
- [`../README.md#mcp-server`](../README.md#mcp-server) — the `loopover-miner-mcp` read-only tool surface for querying this driver's resolved status (provider, model env-var name, CLI presence) and the rest of AMS's local state over MCP.
