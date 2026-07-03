import type { EnqueueWebhookResult } from "../github/webhook";
import type { OrbRelayRegistrationState } from "../orb/broker-client";
import { incr } from "./metrics";
import { withSentryMonitor } from "./sentry";

export type OrbRelayEvent = {
  deliveryId: string;
  eventName: string;
  rawBody: string;
};

export type OrbRelayDrainState = {
  pendingAck: string[];
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
}): Promise<void> {
  await withSentryMonitor(
    "orb-relay-drain",
    { jobType: "orb-relay-drain", pendingAckCount: args.state.pendingAck.length },
    async () => {
      const events = await args.drain(args.relayEnv, args.state.pendingAck);
      args.state.pendingAck = [];
      incr("gittensory_orb_relay_drains_total", {
        result: events.length > 0 ? "events" : "empty",
      });
      for (const ev of events) {
        const result = await args.enqueue(
          args.env,
          ev.deliveryId,
          ev.eventName,
          ev.rawBody,
        );
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

/** Recurring wrapper around the retryable relay-registration attempt (#selfhost-runtime-drift): a bare
 *  one-shot boot-time call never recovers from a transient broker outage without a process restart. Called on
 *  a timer (state persists across calls), it observes + logs only the calls that actually attempted the
 *  network request (`registered` / `failed`) — `already_registered` / `backoff` / `skipped` are silent no-ops
 *  so a healthy or intentionally-idle container does not spam logs/Sentry every tick. */
export async function registerOrbRelayWithMonitor(args: {
  env: OrbRelayRegisterEnv;
  state: OrbRelayRegistrationState;
  register: (env: OrbRelayRegisterEnv, state: OrbRelayRegistrationState) => Promise<OrbRelayRegisterResult>;
  log?: (line: string) => void;
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
        log(JSON.stringify({ event: "selfhost_orb_relay_register_recovered", mode, attempts: args.state.attempts }));
      } else {
        log(JSON.stringify({ event: "selfhost_orb_relay_register", mode, attempts: args.state.attempts }));
      }
      return;
    }
    incr("gittensory_orb_relay_register_total", { mode, result: "failed" });
    // A failed registration is fatal for PUSH mode (the Orb can't reach our public relay URL → the container
    // looks alive but reviews NOTHING → error). In PULL mode the outbound drain loop delivers events once a
    // later attempt succeeds, so a failed announce is only degraded telemetry → warn (not paged as deaf).
    const pull = mode === "pull";
    (pull ? console.warn : console.error)(
      JSON.stringify({
        level: pull ? "warn" : "error",
        event: "selfhost_orb_relay_register_failed",
        mode,
        error: result.reason ?? "unknown",
        attempts: args.state.attempts,
      }),
    );
  });
}
