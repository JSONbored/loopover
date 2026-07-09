// `CodingAgentDriver` interface seam (#4262). Mirrors `SelfHostAi` (`src/selfhost/ai.ts:60-63`): a single `run()`
// method, provider-agnostic task/result types, and injectable deps on concrete implementations (spawn fn, clock,
// filesystem) rather than hardcoded globals. Implementations MAY perform real IO; this file defines only the
// contract — orchestration (mode gating, attempt logging, factory selection) lives in sibling miner modules.

/** Scoped local task handed to every driver implementation — no GitHub writes, no autonomous continue/stop. */
export type CodingAgentDriverTask = {
  attemptId: string;
  workingDirectory: string;
  acceptanceCriteriaPath: string;
  instructions: string;
  maxTurns: number;
};

/** Provider-agnostic result — nothing here assumes a subprocess CLI vs. an Agent SDK `query()` loop. */
export type CodingAgentDriverResult = {
  ok: boolean;
  changedFiles: readonly string[];
  summary: string;
  /** Opaque provider transcript for operator inspection; absent when the driver did not run. */
  transcript?: string | undefined;
  turnsUsed?: number | undefined;
  error?: string | undefined;
};

export interface CodingAgentDriver {
  run(task: CodingAgentDriverTask): Promise<CodingAgentDriverResult>;
}

/** Minimal in-memory fake for contract/parity tests — records the last task without IO. */
export function createFakeCodingAgentDriver(
  impl: Partial<{
    run: CodingAgentDriver["run"];
    lastTask: CodingAgentDriverTask | null;
  }> = {},
): CodingAgentDriver & { lastTask: CodingAgentDriverTask | null } {
  const state = { lastTask: impl.lastTask ?? null };
  return {
    get lastTask() {
      return state.lastTask;
    },
    run:
      impl.run ??
      (async (task) => {
        state.lastTask = task;
        return {
          ok: true,
          changedFiles: [],
          summary: `fake driver ran ${task.attemptId}`,
          turnsUsed: 0,
        };
      }),
  };
}

/** Default-OFF stub driver for factory resolution tests — never touches the filesystem. */
export function createNoopCodingAgentDriver(): CodingAgentDriver {
  return {
    async run(task) {
      return {
        ok: true,
        changedFiles: [],
        summary: `noop driver acknowledged ${task.attemptId}`,
        turnsUsed: 0,
      };
    },
  };
}
