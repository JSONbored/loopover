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
  /** Real dollar cost of this driver run, when the provider reports one. Absent (not zero) when the provider
   *  never got far enough to have a cost, or reports no cost signal at all -- never fabricated. */
  costUsd?: number | undefined;
  /** Real token count (input + output) of this driver run, when the provider reports one (#5653). Absent (not
   *  zero) when the provider never got far enough, or reports no token signal at all -- never fabricated,
   *  mirroring `costUsd`'s own convention. */
  tokensUsed?: number | undefined;
  /** The input/output split behind `tokensUsed`, when the provider reports the two sides separately (#10198).
   *  Both drivers already read them individually and then summed them away, which left the miner unable to
   *  populate PostHog's own `$ai_input_tokens`/`$ai_output_tokens` -- the properties its cost views read --
   *  so miner spend was invisible there. Same never-fabricated convention as the two fields above: a provider
   *  that reports only a blended total leaves these absent, and the blended `tokensUsed` still stands alone. */
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  error?: string | undefined;
};

/** The token fields a driver contributes to its result (#10198) -- spread into the result at each return site
 *  so a driver can never report a split that disagrees with its own blended total. */
export type CodingAgentTokenUsage = Pick<CodingAgentDriverResult, "tokensUsed" | "inputTokens" | "outputTokens">;

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
