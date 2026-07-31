// Host-registered `$ai_generation` sink for the miner's AMS surfaces (#10200, epic #8286 Phase 3).
//
// Every real model call this package drives -- a coding-agent driver attempt (driver-factory.ts) and a
// chat-grounding session (chat-grounding.ts) -- is spend that belongs in PostHog. The engine cannot capture it
// itself: it is the portable package, and `posthog-node` (or any other vendor client) is exactly the dependency
// it must not carry -- the same boundary cli-subprocess-driver.ts's and coding-agent-construction.ts's own
// headers already document.
//
// The previous shape solved that by attaching the capture at a HOST construction site instead
// (`withCodingAgentAiGenerationCapture`, applied inside `constructProductionCodingAgentDriver`), which made
// opting out silent: `runCodingAgentAttempt` builds its driver through `createCodingAgentDriver` DIRECTLY and
// never passes through that site, so every attempt it ran was uncaptured and nothing anywhere said so. A
// wrapper attached at one of N construction sites is precisely the "two or more places that must agree, with
// nothing enforcing it" shape #10170 catalogues, and #10127's fix for the same class is the precedent: make the
// bypass unrepresentable rather than documenting it.
//
// So the sink is registered ONCE by the host process and consumed inside the engine at the single chokepoint
// every real driver is constructed through. A future third construction site cannot silently opt out, because
// there is nothing left for it to forget to attach.

import type { CodingAgentDriver } from "./coding-agent-driver.js";

/**
 * One completed model call, in the host-neutral shape a `$ai_generation` capture needs. Metadata only: model and
 * provider ids, timing, token/cost accounting, and the raw caught value on the error path -- there is
 * deliberately no field for the prompt, the transcript, or any tool output, matching the ORB side's identical
 * policy (`PostHogAiGenerationEvent`, src/selfhost/posthog.ts).
 *
 * Every token/cost field is OPTIONAL and stays absent when the provider reported nothing (#10207): a fabricated
 * 0 is indistinguishable from a real 0 in an aggregate, so the sink must be able to tell "zero" from "unknown".
 */
export type MinerAiGenerationRecord = {
  provider: string;
  model: string;
  latencyMs: number;
  isError: boolean;
  totalTokens?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalCostUsd?: number | undefined;
  error?: unknown;
};

/** The host's capture function. Synchronous and fire-and-forget -- a sink that needs to do I/O queues it. */
export type MinerAiGenerationSink = (record: MinerAiGenerationRecord) => void;

let sink: MinerAiGenerationSink | undefined;

/**
 * Register (or, with `undefined`, clear) the process-wide sink. Called once by the host during startup --
 * `initMinerPostHog` (packages/loopover-miner/lib/posthog.ts) registers its own capture here when the operator
 * has opted in, and registers nothing when they have not, so the no-phone-home default (#6011) is preserved by
 * construction: with no sink registered, {@link emitMinerAiGeneration} is a no-op.
 *
 * Module-level rather than threaded through every call: the same shape posthog.ts's own `client`/`active` module
 * state already uses on the host side, and for the same reason -- a process has exactly one telemetry sink, and
 * an optional parameter threaded through N call sites is the opt-out this module exists to remove.
 */
export function setMinerAiGenerationSink(next: MinerAiGenerationSink | undefined): void {
  sink = next;
}

/** True when a host sink is registered. Exported for the host's own wiring assertions, not for gating a call. */
export function hasMinerAiGenerationSink(): boolean {
  return sink !== undefined;
}

/** Report one completed model call. No-op when no sink is registered, and never throws -- telemetry must never
 *  crash the AI call it is instrumenting, the same contract every capture function in the miner's posthog.ts
 *  already holds on its own side. */
export function emitMinerAiGeneration(record: MinerAiGenerationRecord): void {
  if (!sink) return;
  try {
    sink(record);
  } catch {
    /* A sink that throws is a telemetry bug, never the caller's problem. */
  }
}

/**
 * Wrap a real `CodingAgentDriver` so every attempt it runs reports a generation. Moved here from the miner's own
 * construction site (#10200) so the single engine-side factory can apply it to every driver it builds.
 *
 * `CodingAgentDriverResult` carries the blended `tokensUsed` plus the input/output split when the provider
 * reported one (#10198); all of it is forwarded verbatim, and a driver that knows no split simply leaves those
 * fields absent rather than having one fabricated. A driver failure is reported via `result.ok === false` (the
 * real, observed contract every shipped driver follows -- none of them throw for an ordinary task failure), with
 * a genuine thrown exception handled defensively on top.
 */
export function withCodingAgentGenerationCapture(provider: string, model: string, driver: CodingAgentDriver): CodingAgentDriver {
  return {
    async run(task) {
      const startedAtMs = Date.now();
      try {
        const result = await driver.run(task);
        emitMinerAiGeneration({
          provider,
          model,
          latencyMs: Date.now() - startedAtMs,
          isError: !result.ok,
          totalTokens: result.tokensUsed,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          totalCostUsd: result.costUsd,
          error: result.ok ? undefined : result.error,
        });
        return result;
      } catch (error) {
        emitMinerAiGeneration({ provider, model, latencyMs: Date.now() - startedAtMs, isError: true, error });
        throw error;
      }
    },
  };
}
