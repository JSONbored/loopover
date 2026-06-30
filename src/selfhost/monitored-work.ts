import type { EnqueueWebhookResult } from "../github/webhook";
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
