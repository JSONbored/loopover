// Mode-gated `CodingAgentDriver` invocation (#4313). Single call site that applies `CodingAgentExecutionMode`,
// writes attempt-log events (#4294), and never spawns the underlying agent unless mode is `live`.

import type { CodingAgentDriver, CodingAgentDriverResult, CodingAgentDriverTask } from "./coding-agent-driver.js";
import {
  codingAgentModeExecutes,
  type CodingAgentExecutionMode,
} from "./coding-agent-mode.js";
import type { AttemptLogEvent } from "./attempt-log.js";

export type AttemptLogSink = {
  append(event: AttemptLogEvent): void;
};

function shadowSummary(task: CodingAgentDriverTask): string {
  return `dry-run: would invoke coding agent in ${task.workingDirectory} (≤${task.maxTurns} turns, criteria ${task.acceptanceCriteriaPath})`;
}

/**
 * Invoke a driver under the resolved execution mode. `paused` and `dry_run` never call `driver.run()` — see
 * `coding-agent-mode.ts` for the dry-run tradeoff documentation.
 */
export async function invokeCodingAgentDriver(
  driver: CodingAgentDriver,
  mode: CodingAgentExecutionMode,
  task: CodingAgentDriverTask,
  log?: AttemptLogSink | undefined,
): Promise<CodingAgentDriverResult> {
  const base = { attemptId: task.attemptId, actionClass: "codegen", mode } as const;

  if (mode === "paused") {
    log?.append({
      eventType: "attempt_aborted",
      ...base,
      reason: "coding_agent_paused",
      payload: { workingDirectory: task.workingDirectory },
    });
    return {
      ok: false,
      changedFiles: [],
      summary: "coding agent paused",
      error: "coding_agent_paused",
    };
  }

  if (!codingAgentModeExecutes(mode)) {
    log?.append({
      eventType: "attempt_shadow",
      ...base,
      reason: "dry-run: would invoke coding agent without spawning underlying session",
      payload: {
        workingDirectory: task.workingDirectory,
        acceptanceCriteriaPath: task.acceptanceCriteriaPath,
        maxTurns: task.maxTurns,
      },
    });
    return {
      ok: true,
      changedFiles: [],
      summary: shadowSummary(task),
      turnsUsed: 0,
    };
  }

  log?.append({
    eventType: "attempt_started",
    ...base,
    reason: "live coding-agent invocation",
    payload: { workingDirectory: task.workingDirectory, maxTurns: task.maxTurns },
  });

  try {
    const result = await driver.run(task);
    log?.append({
      eventType: result.ok ? "attempt_succeeded" : "attempt_failed",
      ...base,
      reason: result.summary,
      payload: {
        changedFiles: [...result.changedFiles],
        turnsUsed: result.turnsUsed ?? null,
        error: result.error ?? null,
      },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    log?.append({
      eventType: "attempt_failed",
      ...base,
      reason: message,
      payload: { thrown: true },
    });
    return {
      ok: false,
      changedFiles: [],
      summary: "coding agent invocation failed",
      error: message,
    };
  }
}
