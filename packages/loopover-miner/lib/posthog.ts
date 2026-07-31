/** Opt-in PostHog error tracking for the miner CLI (#8292, epic #8286 Phase 1). Complete no-op unless
 * LOOPOVER_MINER_POSTHOG_API_KEY is set -- an operator points this at their OWN PostHog project, mirroring
 * sentry.ts's identical no-phone-home posture (#6011): this is a published, independently-installed CLI
 * (@loopover/miner), so nothing here is ever auto-enabled or phones home by default. `posthog-node` is
 * lazy-imported only inside `initMinerPostHog()` so a miner invocation that never opts in pays zero
 * module-load cost -- this CLI runs very frequently under an unattended loop (lib/loop-cli.js).
 *
 * Runs ALONGSIDE sentry.ts during the epic's parallel-run window (both capture when both configured) --
 * this is a new sink, not a replacement, until a gated Sentry-decommission sub-issue lands.
 *
 * Short-lived-process flush semantics (`flushAt: 1, flushInterval: 0`): the miner CLI runs frequently and
 * exits quickly, so posthog-node's default batching would likely lose events to process exit before a
 * batched flush ever fires -- the exact pattern packages/loopover-mcp/lib/telemetry.ts (#6238) already
 * proves for opt-in CLI telemetry.
 */
import { randomUUID } from "node:crypto";

type PostHogNs = typeof import("posthog-node");
type PostHogClient = InstanceType<PostHogNs["PostHog"]>;

let client: PostHogClient | undefined;
let active = false;

/** PostHog US-cloud ingestion host -- the default when LOOPOVER_MINER_POSTHOG_HOST isn't set. */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** No per-user identity is tracked by this sink (operational error events, not user analytics) -- every
 *  event shares one anonymous, constant distinct id, mirroring src/mcp/telemetry.ts's/src/selfhost/posthog.ts's
 *  identical choice for the same reason. */
const MINER_POSTHOG_DISTINCT_ID = "loopover-miner";

/** Property-key names that must never leave this process as-is -- a small, self-contained denylist (this
 *  package cannot import src/selfhost/redaction-scrub.ts: it's a separately published npm package with no
 *  dependency on the main app's src/, the same "no cross-package import" convention
 *  cli-subprocess-driver.ts's own header documents). Real `captureMinerError` call sites today only ever
 *  pass flat, non-secret context (kind/repoFullName/attemptId/branchId/scope) -- this is defense-in-depth
 *  for a future call site, not a response to an actual observed leak. */
const SECRET_CONTEXT_KEY = /token|secret|password|passwd|dsn|credential|api[_-]?key|coldkey|hotkey|wallet/i;
const REDACTED = "[redacted]";

/** Drop any context value whose KEY looks secret-shaped; every other scalar passes through unchanged. Not
 *  recursive -- every real call site passes a flat object (see this file's header comment), and PostHog's
 *  own `properties` bag is itself flat by convention. */
function scrubMinerContext(context: Record<string, unknown>): Record<string, unknown> {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    scrubbed[key] = SECRET_CONTEXT_KEY.test(key) ? REDACTED : value;
  }
  return scrubbed;
}

/** Initialize PostHog from `env` (default `process.env`). Returns whether it activated. Call once, as early
 *  as possible in a bin's startup -- after `loadMinerFileSecrets()` (so a `_FILE`-mounted key resolves
 *  first via that function's own generic `<NAME>_FILE` scan, with no code change needed here) and before
 *  `installCliSignalHandlers()` (so a startup crash is still captured). */
export async function initMinerPostHog(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const apiKey = env.LOOPOVER_MINER_POSTHOG_API_KEY;
  if (!apiKey) return false;
  const { PostHog } = await import("posthog-node");
  const host = env.LOOPOVER_MINER_POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST;
  client = new PostHog(apiKey, { host, flushAt: 1, flushInterval: 0 });
  active = true;
  return true;
}

/** Capture an error with optional structured context. No-op when PostHog is off. Never throws --
 *  `captureMinerError`'s own signature and never-throws contract, preserved so call sites don't churn. */
export function captureMinerPostHogError(error: unknown, context?: Record<string, unknown>): void {
  if (!active || !client) return;
  try {
    client.captureException(
      error instanceof Error ? error : new Error(String(error)),
      MINER_POSTHOG_DISTINCT_ID,
      context ? scrubMinerContext(context) : undefined,
    );
  } catch {
    /* PostHog capture must never crash the caller it's instrumenting. */
  }
}

/** Flush buffered events before the process exits. No-op when off. Never throws. */
export async function flushMinerPostHog(): Promise<void> {
  if (!active || !client) return;
  try {
    await client.flush();
  } catch {
    /* Best-effort -- a flush failure must never block process exit. */
  }
}

/** Capture AND flush before returning -- the crash-path convenience wrapper, mirroring
 *  `captureMinerErrorAndFlush`'s identical rationale: a bare `captureMinerPostHogError()` only QUEUES the
 *  event, and `process.exit()` tears the process down immediately afterward without waiting for any
 *  pending delivery. */
export async function captureMinerPostHogErrorAndFlush(error: unknown, context?: Record<string, unknown>): Promise<void> {
  captureMinerPostHogError(error, context);
  await flushMinerPostHog();
}

/**
 * Capture one arbitrary, already-built event (#9525).
 *
 * The MCP dispatch chokepoint composes its own properties from @loopover/contract so all three
 * servers emit the same shape; this is the thin send. No-op when PostHog is off, never throws --
 * same contract as every other capture function in this file. The properties are scrubbed by the
 * same key denylist, so a future caller cannot leak a secret-shaped field through here either.
 */
export function captureMinerPostHogEvent(event: string, properties: Record<string, unknown>): void {
  if (!active || !client) return;
  try {
    client.capture({ distinctId: MINER_POSTHOG_DISTINCT_ID, event, properties: scrubMinerContext(properties), disableGeoip: true });
  } catch {
    /* Capture must never crash the caller it is instrumenting. */
  }
}

/** One AMS coding-agent driver attempt (#8296 AMS follow-up, epic #8286 track 3).
 *
 *  #10198: `inputTokens`/`outputTokens` are the REAL split, now that `CodingAgentDriverResult` carries it.
 *  Both engine drivers already read the two sides from their provider and then summed them away, so this
 *  event could only report a blended `tokens_used` -- a property PostHog's own cost views do not read, which
 *  made every miner generation register as 0 input and 0 output tokens there. The split is still never
 *  FABRICATED: a provider that reports only a blended total leaves both absent, and the blended figure keeps
 *  riding in `tokens_used` on its own. `$ai_total_cost_usd` is one of PostHog's recognized properties and
 *  needs no split, so it is populated directly when known. No field here ever carries prompt/diff/transcript
 *  content -- metadata only, same policy as the ORB side. */
export type MinerAiGenerationEvent = {
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

/** Capture one AMS coding-agent attempt as PostHog's `$ai_generation` event. No-op when PostHog is off --
 *  same contract as every other capture function in this file. */
export function captureMinerPostHogAiGeneration(event: MinerAiGenerationEvent): void {
  if (!active || !client) return;
  const properties: Record<string, unknown> = {
    $ai_trace_id: randomUUID(),
    $ai_model: event.model.trim() || "unknown",
    $ai_provider: event.provider.trim() || "unknown",
    // PostHog's own $ai_generation schema reports latency in SECONDS, not ms.
    $ai_latency: event.latencyMs / 1000,
    $ai_http_status: event.isError ? 500 : 200,
    // #10198: the provider's real split when it reported one. 0 remains the honest fallback for a provider
    // that only ever reports a blended total -- it means "no split known", and `tokens_used` below still
    // carries the figure that IS known.
    $ai_input_tokens: Number.isFinite(event.inputTokens) ? event.inputTokens : 0,
    $ai_output_tokens: Number.isFinite(event.outputTokens) ? event.outputTokens : 0,
    $ai_is_error: event.isError,
  };
  if (Number.isFinite(event.totalTokens)) properties.tokens_used = event.totalTokens;
  if (Number.isFinite(event.totalCostUsd)) properties.$ai_total_cost_usd = event.totalCostUsd;
  if (event.isError) {
    const error = event.error instanceof Error ? event.error : new Error(String(event.error));
    properties.$ai_error = error.message.slice(0, 500);
  }
  try {
    client.capture({ distinctId: MINER_POSTHOG_DISTINCT_ID, event: "$ai_generation", properties });
  } catch {
    /* PostHog capture must never crash the caller it's instrumenting. */
  }
}

/** Test-only: reset module state so one test's activation can't leak into the next. */
export function resetMinerPostHogForTesting(): void {
  client = undefined;
  active = false;
}
