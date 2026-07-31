import { describe, expect, it } from "vitest";

import { createApp } from "../../src/api/routes";
import { RETENTION_POLICY, retentionDaysForTable } from "../../src/db/retention";
import { loadServiceStatusSamples, recordServiceStatusSamples } from "../../src/selfhost/service-status-history";
import { createTestEnv } from "../helpers/d1";
import {
  buildComponentHistory,
  computeIncidents,
  computeUptimeWindow,
  isIncidentStatus,
  UPTIME_WINDOW_DAYS,
  type StatusSample,
} from "../../src/selfhost/service-status-history";

// #9985: uptime and incidents derived from status samples.
//
// Every test here is about a way a plausible implementation would publish something untrue:
//
//   • a 30-day figure computed over three days of data, presented as if it covered a month;
//   • `unknown` ticks — time we were BLIND — counted as uptime (inflates exactly when we could not see) or as
//     downtime (invents an outage nobody observed);
//   • an empty window rendering as 0% (reads as a total outage) or 100% (reads as perfect);
//   • an `unknown` tick splitting one outage into two incidents, manufacturing incidents from our blindness;
//   • an open incident silently closed at "now", asserting a recovery that was never observed.

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const sample = (status: StatusSample["status"], hoursAgo: number): StatusSample => ({ status, sampledAt: at(hoursAgo) });

describe("isIncidentStatus", () => {
  it("counts degraded and outage, and deliberately not unknown", () => {
    expect(isIncidentStatus("degraded")).toBe(true);
    expect(isIncidentStatus("outage")).toBe(true);
    // We did not observe a problem — we failed to look.
    expect(isIncidentStatus("unknown")).toBe(false);
    expect(isIncidentStatus("operational")).toBe(false);
  });
});

describe("computeUptimeWindow", () => {
  it("is the operational share of MEASURED samples", () => {
    const window = computeUptimeWindow([sample("operational", 1), sample("operational", 2), sample("outage", 3), sample("operational", 4)], 7, NOW);
    expect(window.uptime).toBe(0.75);
    expect(window.measured).toBe(4);
    expect(window.unmeasured).toBe(0);
  });

  it("REGRESSION: unknown ticks are excluded from the percentage and reported separately", () => {
    // Two operational, two blind. Counting the blind ticks as up gives 100% — a claim of perfect health over
    // a period half of which we could not see. Counting them as down gives 50%, inventing an outage.
    const window = computeUptimeWindow([sample("operational", 1), sample("unknown", 2), sample("unknown", 3), sample("operational", 4)], 7, NOW);
    expect(window.uptime).toBe(1);
    expect(window.measured).toBe(2);
    expect(window.unmeasured).toBe(2);
  });

  it("REGRESSION: an empty window is null, never 0% or 100%", () => {
    // 0% reads as a total outage and 100% reads as perfect. Both are claims; no data is not a claim.
    const window = computeUptimeWindow([], 30, NOW);
    expect(window.uptime).toBeNull();
    expect(window.measured).toBe(0);
    expect(window.since).toBeNull();
  });

  it("is null, not 100%, when every sample in the window was unmeasured", () => {
    const window = computeUptimeWindow([sample("unknown", 1), sample("unknown", 2)], 7, NOW);
    expect(window.uptime).toBeNull();
    expect(window.unmeasured).toBe(2);
  });

  it("REGRESSION: reports a window as PARTIAL when history does not reach back across it", () => {
    // The headline honesty field. Three days of samples cannot support a 30-day claim, and the reader has to
    // be able to tell.
    const samples = [sample("operational", 1), sample("operational", 48)];
    expect(computeUptimeWindow(samples, 30, NOW).partial).toBe(true);
    expect(computeUptimeWindow(samples, 30, NOW).since).toBe(at(48));
    // The SAME samples fully cover a 1-day window, because recording began 48h before now — well before that
    // window starts. This is the case a naive implementation gets wrong: partiality read off the oldest
    // IN-WINDOW sample marks every window partial forever, since in-window samples can never predate the
    // window start.
    const oneDay = computeUptimeWindow(samples, 1, NOW);
    expect(oneDay.partial).toBe(false);
    expect(oneDay.since).toBe(at(1));
  });

  it("treats an empty window as partial — it covers none of the period it names", () => {
    expect(computeUptimeWindow([], 7, NOW).partial).toBe(true);
  });

  it("ignores samples outside the window and unparseable timestamps", () => {
    const window = computeUptimeWindow(
      [sample("operational", 1), sample("outage", 24 * 40), { status: "outage", sampledAt: "not-a-date" }],
      7,
      NOW,
    );
    expect(window.measured).toBe(1);
    expect(window.uptime).toBe(1);
  });
});

describe("computeIncidents", () => {
  it("derives a closed incident from a contiguous run, with the recovery as its end", () => {
    const incidents = computeIncidents([sample("operational", 5), sample("outage", 4), sample("outage", 3), sample("operational", 2)], 30, NOW);
    expect(incidents).toEqual([{ status: "outage", startedAt: at(4), endedAt: at(2) }]);
  });

  it("REGRESSION: leaves an ongoing incident OPEN rather than closing it at now", () => {
    // Closing it at `now` would assert a recovery nobody observed.
    const incidents = computeIncidents([sample("operational", 5), sample("outage", 4), sample("outage", 1)], 30, NOW);
    expect(incidents).toEqual([{ status: "outage", startedAt: at(4), endedAt: null }]);
  });

  it("REGRESSION: an unknown tick does not split one incident into two", () => {
    // Our blindness is not a recovery. Splitting here would manufacture a second incident out of a failed
    // read, and double the incident count on any night the alerting source was flaky.
    const incidents = computeIncidents([sample("outage", 5), sample("unknown", 4), sample("outage", 3), sample("operational", 2)], 30, NOW);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ startedAt: at(5), endedAt: at(2) });
  });

  it("an unknown tick alone never starts an incident", () => {
    expect(computeIncidents([sample("operational", 3), sample("unknown", 2), sample("operational", 1)], 30, NOW)).toEqual([]);
  });

  it("takes the WORST status in a run, so an escalation is one incident and not two", () => {
    const incidents = computeIncidents([sample("degraded", 4), sample("outage", 3), sample("operational", 2)], 30, NOW);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.status).toBe("outage");
  });

  it("separates genuinely distinct incidents", () => {
    const incidents = computeIncidents(
      [sample("outage", 8), sample("operational", 7), sample("degraded", 4), sample("operational", 3)],
      30,
      NOW,
    );
    expect(incidents.map((incident) => incident.status)).toEqual(["outage", "degraded"]);
  });

  it("sorts unordered input before folding, so row order cannot change the answer", () => {
    const shuffled = [sample("operational", 2), sample("outage", 4), sample("operational", 5), sample("outage", 3)];
    expect(computeIncidents(shuffled, 30, NOW)).toEqual([{ status: "outage", startedAt: at(4), endedAt: at(2) }]);
  });

  it("returns nothing for an all-operational history", () => {
    expect(computeIncidents([sample("operational", 2), sample("operational", 1)], 30, NOW)).toEqual([]);
  });
});

describe("buildComponentHistory", () => {
  it("reports every declared window, and incidents over the widest one", () => {
    const history = buildComponentHistory([sample("operational", 1), sample("outage", 24 * 20), sample("operational", 24 * 19)], NOW);
    expect(history.uptime.map((w) => w.windowDays)).toEqual([...UPTIME_WINDOW_DAYS]);
    // The 20-day-old outage is outside 1d and 7d but inside 30d, so only the widest window sees it — and the
    // incident list is computed over that same widest window, so the two describe the same period.
    expect(history.uptime.find((w) => w.windowDays === 1)?.measured).toBe(1);
    expect(history.incidents).toHaveLength(1);
  });
});


describe("persistence, over a real migrated D1", () => {
  it("round-trips a sample per component", async () => {
    const env = createTestEnv();
    const now = new Date(NOW);
    await recordServiceStatusSamples(env, [{ component: "review", status: "operational" }, { component: "testing", status: "outage" }], now);

    const review = await loadServiceStatusSamples(env, "review", now);
    expect(review).toEqual([{ status: "operational", sampledAt: now.toISOString() }]);
    // Scoped per component: the testing outage must not appear in the review history.
    expect((await loadServiceStatusSamples(env, "testing", now))[0]?.status).toBe("outage");
  });

  it("stores `unknown` rather than skipping it, so blindness stays visible as unmeasured time", async () => {
    // Dropping these rows would silently shrink the window and let a period we could not see read as uptime.
    const env = createTestEnv();
    const now = new Date(NOW);
    await recordServiceStatusSamples(env, [{ component: "review", status: "unknown" }], now);
    const history = buildComponentHistory(await loadServiceStatusSamples(env, "review", now), NOW);
    const day = history.uptime.find((window) => window.windowDays === 1)!;
    expect(day.unmeasured).toBe(1);
    expect(day.uptime).toBeNull();
  });

  it("BEST EFFORT: a write failure never throws, because telemetry must not fail the tick carrying it", async () => {
    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    await expect(recordServiceStatusSamples(broken, [{ component: "review", status: "operational" }])).resolves.toBeUndefined();
  });

  it("FAIL-SAFE: a read failure yields no samples, which reports as unmeasured rather than as healthy", async () => {
    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    expect(await loadServiceStatusSamples(broken, "review")).toEqual([]);
    expect(buildComponentHistory([], NOW).uptime.every((window) => window.uptime === null && window.partial)).toBe(true);
  });

  it("excludes samples older than the widest reported window", async () => {
    const env = createTestEnv();
    const now = new Date(NOW);
    await recordServiceStatusSamples(env, [{ component: "review", status: "outage" }], new Date(NOW - 40 * 86_400_000));
    await recordServiceStatusSamples(env, [{ component: "review", status: "operational" }], now);
    expect(await loadServiceStatusSamples(env, "review", now)).toHaveLength(1);
  });
});

describe("retention", () => {
  it("INVARIANT: retention EXCEEDS the widest reported window, so the figure never loses its own tail", () => {
    // A retention equal to the window would make the oldest day of every month quietly unmeasured. This is
    // the inequality that lets the 30-day figure stay whole without a rollup -- and widening
    // UPTIME_WINDOW_DAYS past it would break it silently, so it is asserted rather than commented.
    const days = retentionDaysForTable("service_status_samples");
    expect(days).not.toBeNull();
    expect(days!).toBeGreaterThan(Math.max(...UPTIME_WINDOW_DAYS));
  });

  it("is registered in the policy at all", () => {
    expect(RETENTION_POLICY.some((rule) => rule.table === "service_status_samples")).toBe(true);
  });
});

describe("GET /v1/public/service-status with history", () => {
  it("attaches uptime and incidents per component", async () => {
    const env = createTestEnv({ LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093" } as Partial<Env>);
    await recordServiceStatusSamples(env, [{ component: "review", status: "operational" }], new Date());

    const response = await createApp().request("/v1/public/service-status", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { components: { component: string; uptime: unknown[]; incidents: unknown[] }[] };
    const review = body.components.find((entry) => entry.component === "review");
    expect(review?.uptime).toHaveLength(UPTIME_WINDOW_DAYS.length);
    expect(Array.isArray(review?.incidents)).toBe(true);
  });
});
