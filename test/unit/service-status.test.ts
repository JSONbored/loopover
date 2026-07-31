import { describe, expect, it } from "vitest";

import { createApp } from "../../src/api/routes";
import {
  buildServiceStatus,
  isFiring,
  isServiceStatusEnabled,
  loadServiceStatus,
  SERVICE_STATUS_COMPONENTS,
  statusForSeverity,
  unknownServiceStatus,
  worseStatus,
  type AlertmanagerAlert,
} from "../../src/selfhost/service-status";
import { createTestEnv } from "../helpers/d1";

// #9983 (slice of #9747): the public status board.
//
// The correctness content here is almost entirely about NOT reporting green. A status page that renders
// "operational" because it could not reach its source is worse than no status page: it tells people the thing
// is fine at exactly the moment nobody can confirm it. So the failure paths are tested harder than the happy
// one, and the second concern -- that no host, instance or capacity detail escapes into a public payload --
// is asserted over the serialized response rather than field by field.

const NOW = new Date("2026-07-31T12:00:00.000Z");
const alert = (over: Partial<AlertmanagerAlert> & { service?: string; severity?: string } = {}): AlertmanagerAlert => ({
  labels: { service: over.service ?? "loopover", severity: over.severity ?? "warning" },
  startsAt: "2026-07-31T11:00:00.000Z",
  status: { state: "active" },
  ...over,
});

describe("worseStatus", () => {
  it("REGRESSION: unknown outranks operational, so an unreadable component is never averaged away", () => {
    // The single most important ordering in the module. If `operational` won, one healthy component would
    // mask one we could not read.
    expect(worseStatus("operational", "unknown")).toBe("unknown");
    expect(worseStatus("unknown", "operational")).toBe("unknown");
  });

  it("ranks outage above degraded above unknown", () => {
    expect(worseStatus("degraded", "outage")).toBe("outage");
    expect(worseStatus("unknown", "degraded")).toBe("degraded");
    expect(worseStatus("outage", "degraded")).toBe("outage");
  });
});

describe("statusForSeverity", () => {
  it("maps critical to outage and everything else to degraded", () => {
    expect(statusForSeverity("critical")).toBe("outage");
    expect(statusForSeverity("CRITICAL")).toBe("outage");
    expect(statusForSeverity("warning")).toBe("degraded");
  });

  it("REGRESSION: an unrecognised or missing severity rounds UP to degraded, never down to operational", () => {
    // A firing alert with a severity we do not recognise is still firing. Rounding it down would hide it.
    expect(statusForSeverity("catastrophe")).toBe("degraded");
    expect(statusForSeverity(undefined)).toBe("degraded");
    expect(statusForSeverity(42)).toBe("degraded");
  });
});

describe("isFiring", () => {
  it("excludes suppressed alerts, which are deliberately paging nobody", () => {
    expect(isFiring({ status: { state: "suppressed" } })).toBe(false);
    expect(isFiring({ status: { state: "active" } })).toBe(true);
  });

  it("treats a missing state as firing, since an alert we cannot classify is still an alert", () => {
    expect(isFiring({})).toBe(true);
  });
});

describe("buildServiceStatus", () => {
  it("reports every component as operational when nothing is firing", () => {
    const payload = buildServiceStatus([], NOW.toISOString());
    expect(payload.overall).toBe("operational");
    expect(payload.components.map((c) => c.component)).toEqual([...SERVICE_STATUS_COMPONENTS]);
    expect(payload.components.every((c) => c.status === "operational" && c.since === null)).toBe(true);
  });

  it("INVARIANT: a healthy component still appears -- omitting it is indistinguishable from not checking it", () => {
    const payload = buildServiceStatus([alert({ service: "ams", severity: "critical" })], NOW.toISOString());
    expect(payload.components).toHaveLength(SERVICE_STATUS_COMPONENTS.length);
    expect(payload.components.find((c) => c.component === "review")?.status).toBe("operational");
  });

  it("maps an alert onto its component and raises overall to match", () => {
    const payload = buildServiceStatus([alert({ service: "ams", severity: "critical" })], NOW.toISOString());
    const testing = payload.components.find((c) => c.component === "testing");
    expect(testing).toMatchObject({ status: "outage", since: "2026-07-31T11:00:00.000Z" });
    expect(payload.overall).toBe("outage");
  });

  it("takes the WORST severity when a component has several alerts firing", () => {
    const payload = buildServiceStatus([alert({ severity: "warning" }), alert({ severity: "critical" })], NOW.toISOString());
    expect(payload.components.find((c) => c.component === "review")?.status).toBe("outage");
  });

  it("dates the incident from the EARLIEST alert, not the most recent", () => {
    // The incident began when the first alert fired. Reporting the latest would keep resetting `since` as an
    // ongoing outage generates more alerts, making a long incident look perpetually new.
    const payload = buildServiceStatus(
      [alert({ startsAt: "2026-07-31T11:30:00.000Z" }), alert({ startsAt: "2026-07-31T10:00:00.000Z" })],
      NOW.toISOString(),
    );
    expect(payload.components.find((c) => c.component === "review")?.since).toBe("2026-07-31T10:00:00.000Z");
  });

  it("ignores suppressed alerts", () => {
    const payload = buildServiceStatus([alert({ severity: "critical", status: { state: "suppressed" } })], NOW.toISOString());
    expect(payload.overall).toBe("operational");
  });

  it("REGRESSION: an UNMAPPED service label is ignored, never published as a component", () => {
    // Alert labels are internal topology. Publishing an unrecognised one verbatim is the leak the fixed
    // component vocabulary exists to prevent.
    const payload = buildServiceStatus([alert({ service: "postgres-primary-node-3", severity: "critical" })], NOW.toISOString());
    expect(payload.overall).toBe("operational");
    expect(payload.components.map((c) => c.component)).toEqual([...SERVICE_STATUS_COMPONENTS]);
  });

  it("clears `since` for a component that is operational", () => {
    expect(buildServiceStatus([], NOW.toISOString()).components.every((c) => c.since === null)).toBe(true);
  });
});

describe("loadServiceStatus — every failure path lands on unknown, never operational", () => {
  const cases: { name: string; env: { LOOPOVER_ALERTMANAGER_URL?: string }; fetchImpl: typeof fetch; reason: RegExp }[] = [
    {
      name: "the alerting source is not configured",
      env: {},
      fetchImpl: (() => Promise.reject(new Error("should not be called"))) as unknown as typeof fetch,
      reason: /not configured/,
    },
    {
      name: "the request throws (network error or timeout)",
      env: { LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093" },
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
      reason: /unreachable/,
    },
    {
      name: "the source answers non-200",
      env: { LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093" },
      fetchImpl: (() => Promise.resolve(new Response("nope", { status: 503 }))) as unknown as typeof fetch,
      reason: /returned an error/,
    },
    {
      name: "the body is not JSON",
      env: { LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093" },
      fetchImpl: (() => Promise.resolve(new Response("<html/>", { status: 200 }))) as unknown as typeof fetch,
      reason: /unreadable/,
    },
    {
      name: "the body parses but is not an array",
      // The subtlest one: `{}` is valid JSON with no alerts in it, and treating that as "nothing firing"
      // would publish green off a payload we failed to understand.
      env: { LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093" },
      fetchImpl: (() => Promise.resolve(Response.json({ status: "success" }))) as unknown as typeof fetch,
      reason: /unexpected shape/,
    },
  ];

  for (const testCase of cases) {
    it(`reports unknown when ${testCase.name}`, async () => {
      const payload = await loadServiceStatus(testCase.env, { now: NOW, fetchImpl: testCase.fetchImpl });
      expect(payload.overall).toBe("unknown");
      expect(payload.components.every((c) => c.status === "unknown")).toBe(true);
      expect(payload.components[0]?.reason).toMatch(testCase.reason);
    });
  }

  it("INVARIANT: no failure reason leaks the configured URL", async () => {
    // The reason is a category, not a connection string -- the Alertmanager address is internal topology.
    const payload = await loadServiceStatus(
      { LOOPOVER_ALERTMANAGER_URL: "http://alertmanager.internal.example:9093" },
      { now: NOW, fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch },
    );
    expect(JSON.stringify(payload)).not.toMatch(/alertmanager\.internal|9093/);
  });

  it("reads the real shape Alertmanager returns and reports operational for an empty list", async () => {
    // `[]` is exactly what the live Orb returns today.
    const payload = await loadServiceStatus(
      { LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093" },
      { now: NOW, fetchImpl: (() => Promise.resolve(Response.json([]))) as unknown as typeof fetch },
    );
    expect(payload.overall).toBe("operational");
  });

  it("requests the v2 alerts endpoint under the configured base, tolerating a trailing slash", async () => {
    const seen: string[] = [];
    const capture = ((url: string) => {
      seen.push(String(url));
      return Promise.resolve(Response.json([]));
    }) as unknown as typeof fetch;
    await loadServiceStatus({ LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093/" }, { now: NOW, fetchImpl: capture });
    expect(seen[0]).toBe("http://alertmanager:9093/api/v2/alerts");
  });
});

describe("isServiceStatusEnabled", () => {
  it("is off when unset or blank, so the hosted Worker never serves an all-unknown board", () => {
    expect(isServiceStatusEnabled({})).toBe(false);
    expect(isServiceStatusEnabled({ LOOPOVER_ALERTMANAGER_URL: "   " })).toBe(false);
  });

  it("is on when a source is configured", () => {
    expect(isServiceStatusEnabled({ LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093" })).toBe(true);
  });
});

describe("unknownServiceStatus", () => {
  it("covers every component, so a degraded read never silently drops one", () => {
    const payload = unknownServiceStatus(NOW.toISOString(), "because");
    expect(payload.components.map((c) => c.component)).toEqual([...SERVICE_STATUS_COMPONENTS]);
  });
});

describe("GET /v1/public/service-status", () => {
  const get = (env: Env) => createApp().request("/v1/public/service-status", {}, env);

  it("404s where no alerting source is configured", async () => {
    const response = await get(createTestEnv());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("serves the board where one is, without requiring any credential", async () => {
    const env = createTestEnv({ LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093" } as Partial<Env>);
    const response = await get(env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { overall: string; components: unknown[] };
    // Alertmanager is unreachable from the test process, so this exercises the honest-degradation path end
    // to end: a 200 that says "unknown", not a 500 and not a green board.
    expect(body.overall).toBe("unknown");
    expect(body.components).toHaveLength(SERVICE_STATUS_COMPONENTS.length);
  });

  it("INVARIANT: the payload carries no host, instance, capacity or alert-label detail", async () => {
    const env = createTestEnv({ LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093" } as Partial<Env>);
    const serialized = await (await get(env)).text();
    for (const forbidden of ["alertmanager", "9093", "instance", "job", "pod", "localhost", "cpu", "memory", "disk"]) {
      expect(serialized.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("caches briefly -- this is the endpoint people refresh during an incident", async () => {
    const env = createTestEnv({ LOOPOVER_ALERTMANAGER_URL: "http://alertmanager:9093" } as Partial<Env>);
    expect((await get(env)).headers.get("Cache-Control")).toBe("public, max-age=15, stale-while-revalidate=30");
  });
});
