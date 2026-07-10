# CodingAgentDriver — the miner's coding-agent seam

`CodingAgentDriver` is the single interface a Gittensory miner runs a coding agent through. It lets the miner drive
**either** a local CLI subprocess (e.g. `claude` / `codex`) **or** an in-process Agent SDK `query()` loop behind one
provider-agnostic contract, so the rest of the miner — planning, attempt logging, metering, gate polling — never
has to know which backend actually did the work.

The interface itself lives in `@jsonbored/gittensory-engine`
([`packages/gittensory-engine/src/miner/coding-agent-driver.ts`](../../gittensory-engine/src/miner/coding-agent-driver.ts));
the orchestration around it (mode gating, invocation, the factory) lives in the sibling modules described below.

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
  attemptId: string;            // stable id for this attempt (keys the attempt log)
  workingDirectory: string;     // the ONLY directory a driver may edit (see worktree isolation below)
  acceptanceCriteriaPath: string; // path to the immutable acceptance-criteria file written before the run
  instructions: string;         // the metadata-only prompt (no source contents)
  maxTurns: number;             // hard cap on agent iterations for this attempt
};

type CodingAgentDriverResult = {
  ok: boolean;
  changedFiles: readonly string[];
  summary: string;
  transcript?: string;          // opaque provider transcript for operator inspection
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

| Concern | Module | What it provides |
|---|---|---|
| Execution mode | `coding-agent-mode.ts` | `paused` / `dry_run` / `live` with deny-toward-safety precedence; `codingAgentModeExecutes(mode)` is the single "should this attempt actually spawn?" boolean. A `dry_run` is a pure no-op at the driver boundary. |
| Invocation | `coding-agent-invoke.ts` | `invokeCodingAgentDriver(driver, task, mode?, log?)` — gates on the mode, calls `driver.run`, and streams lifecycle events to an `AttemptLogSink`. |
| Factory | `driver-factory.ts` | `createCodingAgentDriver(options)` resolves a driver by configured name; `resolveConfiguredCodingAgentDriverNames` / `isConfiguredCodingAgentDriver` deny unknown names by default; `runCodingAgentAttempt(options)` is the top-level "resolve + invoke" convenience. |
| Attempt log | `attempt-log.ts` (#4294) | `ATTEMPT_LOG_EVENT_TYPES` + `normalizeAttemptLogEvent` + `createAttemptLogBuffer` + `formatAttemptLogJsonl` — an append-only, JSONL-exportable event trace per attempt, independent of any driver's own transcript. Durable persistence: `packages/gittensory-miner/lib/attempt-log.js` (sibling SQLite store; imports the engine normalizer). |
| Metering | `attempt-metering.ts` (#4311) | `accumulateAttemptUsage` / `meterAttemptUsage` / `evaluateAttemptBudget` over `AttemptBudgetAxis` (`tokens` / `turns` / `wallClockMs` / `costUsd`). |
| Acceptance criteria | (#4271) | The immutable criteria file at `task.acceptanceCriteriaPath`, written before the driver starts. |
| Worktree isolation | (#4269) | Each attempt's `task.workingDirectory` is a dedicated git worktree; a driver must never edit outside it. |

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

## A worked attempt lifecycle

```
runCodingAgentAttempt(options)
  ├─ resolveCodingAgentExecutionMode(...)         → paused | dry_run | live
  ├─ if !codingAgentModeExecutes(mode):           → record a shadow/no-op attempt-log event, return without spawning
  │     (uses the noop driver stand-in — CLI providers do NOT require spawn/query deps in this branch)
  ├─ createCodingAgentDriver({ name, ... })        → the configured driver
  └─ invokeCodingAgentDriver(driver, task, mode, log)
       ├─ log: attempt started
       ├─ driver.run(task)                          → edits inside task.workingDirectory only, ≤ task.maxTurns
       │      └─ (metering accumulates tokens/turns/wallClockMs/costUsd; evaluateAttemptBudget can abort)
       ├─ log: attempt succeeded | failed           (append-only; formatAttemptLogJsonl dumps the trace)
       └─ returns CodingAgentDriverResult { ok, changedFiles, summary, transcript?, turnsUsed? }
```

The attempt log (JSONL) and the metering totals are the durable, provider-independent record of what happened —
independent of whichever backend's own transcript, and the input to the miner's manage-phase and self-improve loops.
