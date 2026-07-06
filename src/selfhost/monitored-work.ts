import type { EnqueueWebhookResult } from "../github/webhook";
import { ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK, type OrbRelayRegistrationState } from "../orb/broker-client";
import { incr } from "./metrics";
import { withSentryMonitor } from "./sentry";

export type OrbRelayEvent = {
  deliveryId: string;
  eventName: string;
  rawBody: string;
};

export type OrbRelayDrainState = {
  pendingAck: string[];
  // Set on every drain call that completes WITHOUT throwing, regardless of whether it returned events --
  // an empty poll still proves the broker round-trip itself is alive. Read by
  // isOrbRelayRegistrationAlerting so a registration failure streak below the alert threshold can still
  // be judged against real evidence the relay connection is (or isn't) making progress.
  lastDrainAtMs: number | null;
};

type OrbRelayEnv = {
  ORB_ENROLLMENT_SECRET?: string | undefined;
  ORB_BROKER_URL?: string | undefined;
};

const ORB_RELAY_METRIC_EVENTS = new Set([
  "check_suite",
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
]);

function orbRelayMetricEvent(eventName: string): string {
  return ORB_RELAY_METRIC_EVENTS.has(eventName) ? eventName : "other";
}

export async function runScheduledLoopWithMonitor<T>(
  cron: string,
  scheduled: () => T | Promise<T>,
): Promise<T> {
  return withSentryMonitor(
    "scheduled-loop",
    { jobType: "scheduled-loop", cron },
    () => Promise.resolve(scheduled()),
  );
}

export async function runOrbExportWithMonitor(
  exportBatch: () => Promise<number>,
  log: (line: string) => void = console.log,
): Promise<void> {
  await withSentryMonitor("orb-export", { jobType: "orb-export" }, async () => {
    const exported = await exportBatch();
    if (exported > 0)
      log(JSON.stringify({ event: "selfhost_orb_export", exported }));
  });
}

export async function drainOrbRelayWithMonitor(args: {
  state: OrbRelayDrainState;
  relayEnv: OrbRelayEnv;
  env: Env;
  drain: (env: OrbRelayEnv, ack: string[]) => Promise<OrbRelayEvent[]>;
  enqueue: (
    env: Env,
    deliveryId: string,
    eventName: string,
    rawBody: string,
  ) => Promise<EnqueueWebhookResult>;
  log?: (line: string) => void;
  nowMs?: number;
}): Promise<void> {
  await withSentryMonitor(
    "orb-relay-drain",
    { jobType: "orb-relay-drain", pendingAckCount: args.state.pendingAck.length },
    async () => {
      const events = await args.drain(args.relayEnv, args.state.pendingAck);
      args.state.pendingAck = [];
      // A successful round-trip (even zero events) proves the broker link itself is alive -- stamped
      // BEFORE the per-event enqueue loop so a downstream enqueue failure still counts as drain progress
      // (the relay connection, not the local queue, is what registration-alerting cares about).
      args.state.lastDrainAtMs = args.nowMs ?? Date.now();
      incr("gittensory_orb_relay_drains_total", {
        result: events.length > 0 ? "events" : "empty",
      });
      for (const ev of events) {
        // #audit-orb-relay-enqueue-isolation: an enqueue can throw uncaught (e.g. a D1/Postgres write failure
        // inside recordWebhookEvent, not just the anticipated failures enqueueWebhookByEnv already returns as a
        // string result) -- that must not abort the REST of this batch, or every event after the failing one
        // is silently never attempted this tick. Isolate per event and treat a throw exactly like the existing
        // non-throwing "enqueue_failed" result: don't ack (the relay redelivers it next drain) and keep going.
        let result: EnqueueWebhookResult;
        try {
          result = await args.enqueue(
            args.env,
            ev.deliveryId,
            ev.eventName,
            ev.rawBody,
          );
        } catch (error) {
          incr("gittensory_orb_webhook_total", {
            event: orbRelayMetricEvent(ev.eventName),
            result: "enqueue_failed",
          });
          console.error(
            JSON.stringify({
              level: "error",
              event: "orb_relay_enqueue_threw",
              eventName: ev.eventName,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          continue;
        }
        incr("gittensory_orb_webhook_total", {
          event: orbRelayMetricEvent(ev.eventName),
          result,
        });
        if (result !== "enqueue_failed") args.state.pendingAck.push(ev.deliveryId);
      }
      if (events.length > 0)
        (args.log ?? console.log)(
          JSON.stringify({ event: "orb_relay_drained", count: events.length }),
        );
    },
  );
}

type OrbRelayRegisterEnv = {
  ORB_ENROLLMENT_SECRET?: string | undefined;
  ORB_BROKER_URL?: string | undefined;
  PUBLIC_API_ORIGIN?: string | undefined;
  ORB_RELAY_MODE?: string | undefined;
};
type OrbRelayRegisterResult = { status: "registered" | "already_registered" | "skipped" | "backoff" | "failed"; reason?: string };

// Pull mode has no inbound endpoint, so a stuck registration doesn't outright silence delivery the way a
// push-mode failure does -- events still arrive as long as drainOrbRelayWithMonitor keeps succeeding. But
// that grace period isn't unlimited: a container that hasn't drained in this long, on top of a failing
// registration, is presumptively stuck rather than just quiet, even if the failure streak itself never
// individually crossed ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK (e.g. it flaps just under the threshold
// forever).
export const ORB_RELAY_DRAIN_NO_PROGRESS_WINDOW_MS = 30 * 60_000;

/** Pull-mode registration alert gate (#selfhost-runtime-drift follow-up): a lone registration timeout is
 *  routine degraded telemetry, NOT an error, as long as the drain loop is still making progress -- so this
 *  only reports "actually stuck" (as opposed to "one hiccup") when EITHER the failure streak has crossed
 *  {@link ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK}, OR a KNOWN prior drain has gone stale for over
 *  {@link ORB_RELAY_DRAIN_NO_PROGRESS_WINDOW_MS}. `drainLastAtMs` is `null` when there is no drain-progress
 *  evidence to judge yet (push mode has no drain loop at all; a pull-mode container may simply not have
 *  reached its first drain tick) -- treated as "insufficient signal to escalate on this basis", not as
 *  "stuck", so a lone registration hiccup at boot can't alert before the drain loop has had a chance to
 *  prove itself either way. */
export function isOrbRelayRegistrationAlerting(args: {
  consecutiveFailures: number;
  drainLastAtMs: number | null;
  nowMs?: number;
}): boolean {
  if (args.consecutiveFailures >= ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK) return true;
  if (args.drainLastAtMs === null) return false;
  const nowMs = args.nowMs ?? Date.now();
  return nowMs - args.drainLastAtMs > ORB_RELAY_DRAIN_NO_PROGRESS_WINDOW_MS;
}

/** Recurring wrapper around the retryable relay-registration attempt (#selfhost-runtime-drift): a bare
 *  one-shot boot-time call never recovers from a transient broker outage without a process restart. Called on
 *  a timer (state persists across calls), it observes + logs only the calls that actually attempted the
 *  network request (`registered` / `failed`) — `already_registered` / `backoff` / `skipped` are silent no-ops
 *  so a healthy or intentionally-idle container does not spam logs/Sentry every tick. `drainState` is the
 *  pull-mode drain loop's shared state (omitted/undefined in push mode, where there is no drain loop) -- its
 *  `lastDrainAtMs` feeds the no-progress-window half of {@link isOrbRelayRegistrationAlerting}. */
export async function registerOrbRelayWithMonitor(args: {
  env: OrbRelayRegisterEnv;
  state: OrbRelayRegistrationState;
  register: (env: OrbRelayRegisterEnv, state: OrbRelayRegistrationState) => Promise<OrbRelayRegisterResult>;
  drainState?: OrbRelayDrainState;
  log?: (line: string) => void;
  nowMs?: number;
}): Promise<void> {
  await withSentryMonitor("orb-relay-register", { jobType: "orb-relay-register" }, async () => {
    const result = await args.register(args.env, args.state);
    if (result.status === "skipped" || result.status === "already_registered" || result.status === "backoff") return;
    const mode = args.env.ORB_RELAY_MODE === "pull" ? "pull" : "push";
    const log = args.log ?? console.log;
    if (result.status === "registered") {
      incr("gittensory_orb_relay_register_total", { mode, result: "registered" });
      // attempts === 1 means this succeeded on the very first try (parity with the original boot-only log);
      // a higher count means it recovered after one or more prior failures -- a distinct, more alertable event.
      if (args.state.attempts > 1) {
        incr("gittensory_orb_relay_register_total", { mode, result: "recovered" });
        log(JSON.stringify({ event: "selfhost_orb_relay_register_recovered", mode, attempts: args.state.attempts }));
      } else {
        log(JSON.stringify({ event: "selfhost_orb_relay_register", mode, attempts: args.state.attempts }));
      }
      return;
    }
    incr("gittensory_orb_relay_register_total", { mode, result: "failed" });
    // A failed registration is fatal for PUSH mode (the Orb can't reach our public relay URL → the container
    // looks alive but reviews NOTHING → error). In PULL mode the outbound drain loop delivers events once a
    // later attempt succeeds, so a failed announce is only degraded telemetry -- UNLESS the streak/no-progress
    // gate below says the relay link is actually stuck, not just having hiccuped once.
    const pull = mode === "pull";
    const alerting =
      !pull ||
      isOrbRelayRegistrationAlerting({
        consecutiveFailures: args.state.consecutiveFailures,
        drainLastAtMs: args.drainState?.lastDrainAtMs ?? null,
        ...(args.nowMs !== undefined ? { nowMs: args.nowMs } : {}),
      });
    (alerting ? console.error : console.warn)(
      JSON.stringify({
        level: alerting ? "error" : "warn",
        event: "selfhost_orb_relay_register_failed",
        mode,
        error: result.reason ?? "unknown",
        attempts: args.state.attempts,
        consecutiveFailures: args.state.consecutiveFailures,
      }),
    );
  });
}
