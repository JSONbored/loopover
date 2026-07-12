import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPagerDutyEnabled,
  resolvePagerDutyCooldownMinutes,
  resolvePagerDutyMinSeverity,
  resolvePagerDutyRoutingKey,
  triggerPagerDutyIncident,
} from "../../src/services/notify-pagerduty";
import { recordAuditEvent } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const VALID_KEY = "a".repeat(32);
const REPO_KEY = "b".repeat(32);
const ORIG = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIG)) delete process.env[key];
  }
  Object.assign(process.env, ORIG);
  vi.unstubAllGlobals();
});

function stubFetch(status = 202): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    return new Response(null, { status });
  });
  return calls;
}

const withEnv = (over: Record<string, string> = {}): Env => Object.assign(createTestEnv(), over) as Env;
const enabledEnv = (over: Record<string, string> = {}): Env => withEnv({ GITTENSORY_ENABLE_PAGERDUTY: "1", PAGERDUTY_ROUTING_KEY: VALID_KEY, ...over });

async function pagerDutyAudit(env: Env): Promise<Array<{ outcome: string; detail: string; target_key: string; metadata_json: string }>> {
  const rows = await env.DB.prepare("select outcome, detail, target_key, metadata_json from audit_events where event_type = ? order by created_at").bind("external_notification.pagerduty").all<{
    outcome: string;
    detail: string;
    target_key: string;
    metadata_json: string;
  }>();
  return rows.results ?? [];
}

function trigger(env: Env, over: Partial<{ repoFullName: string; summary: string; severity: "critical" | "error" | "warning" | "info"; dedupKey: string; customDetails: Record<string, unknown> }> = {}): Promise<void> {
  return triggerPagerDutyIncident(env, {
    repoFullName: "acme/widgets",
    summary: "ops anomaly detected",
    severity: "error",
    dedupKey: "ops_anomaly:acme/widgets",
    ...over,
  });
}

describe("isPagerDutyEnabled", () => {
  it("accepts the codebase-standard truthy strings, case-insensitively", () => {
    for (const value of ["1", "true", "YES", "On"]) expect(isPagerDutyEnabled({ GITTENSORY_ENABLE_PAGERDUTY: value })).toBe(true);
  });
  it("treats anything else (including unset) as disabled", () => {
    for (const value of [undefined, "", "0", "false", "nah"]) expect(isPagerDutyEnabled({ GITTENSORY_ENABLE_PAGERDUTY: value })).toBe(false);
  });
});

describe("resolvePagerDutyRoutingKey", () => {
  it("flag off → disabled/flag_off, even with a valid global key set", () => {
    expect(resolvePagerDutyRoutingKey(withEnv({ PAGERDUTY_ROUTING_KEY: VALID_KEY }), "acme/widgets")).toEqual({ status: "disabled", reason: "flag_off" });
  });

  it("resolves a repo-specific PAGERDUTY_REPO_ROUTING_KEYS entry case-insensitively, over the global key", () => {
    const env = enabledEnv({ PAGERDUTY_REPO_ROUTING_KEYS: JSON.stringify({ "acme/widgets": REPO_KEY }) });
    expect(resolvePagerDutyRoutingKey(env, "ACME/Widgets")).toEqual({ status: "configured", routingKey: REPO_KEY, source: "repo_map" });
  });

  it("REGRESSION: an invalid repo-specific key suppresses instead of falling back to the global key", () => {
    const env = enabledEnv({ PAGERDUTY_REPO_ROUTING_KEYS: JSON.stringify({ "acme/widgets": "not-hex" }) });
    expect(resolvePagerDutyRoutingKey(env, "acme/widgets")).toEqual({ status: "disabled", reason: "invalid_repo_key" });
  });

  it("REGRESSION: a non-string or blank repo-map entry fails closed", () => {
    const env = enabledEnv({ PAGERDUTY_REPO_ROUTING_KEYS: JSON.stringify({ "acme/widgets": 123, "acme/blank": "   " }) });
    expect(resolvePagerDutyRoutingKey(env, "acme/widgets")).toEqual({ status: "disabled", reason: "invalid_repo_key" });
    expect(resolvePagerDutyRoutingKey(env, "acme/blank")).toEqual({ status: "disabled", reason: "invalid_repo_key" });
  });

  it("ignores malformed or non-object PAGERDUTY_REPO_ROUTING_KEYS values and falls back to the global key", () => {
    expect(resolvePagerDutyRoutingKey(enabledEnv({ PAGERDUTY_REPO_ROUTING_KEYS: "{not json" }), "acme/widgets")).toEqual({ status: "configured", routingKey: VALID_KEY, source: "global" });
    expect(resolvePagerDutyRoutingKey(enabledEnv({ PAGERDUTY_REPO_ROUTING_KEYS: "null" }), "acme/widgets")).toEqual({ status: "configured", routingKey: VALID_KEY, source: "global" });
    expect(resolvePagerDutyRoutingKey(enabledEnv({ PAGERDUTY_REPO_ROUTING_KEYS: "123" }), "acme/widgets")).toEqual({ status: "configured", routingKey: VALID_KEY, source: "global" });
    expect(resolvePagerDutyRoutingKey(enabledEnv({ PAGERDUTY_REPO_ROUTING_KEYS: "[]" }), "acme/widgets")).toEqual({ status: "configured", routingKey: VALID_KEY, source: "global" });
  });

  it("unmapped repo + no global key → disabled/missing_global_key", () => {
    expect(resolvePagerDutyRoutingKey(withEnv({ GITTENSORY_ENABLE_PAGERDUTY: "1" }), "acme/widgets")).toEqual({ status: "disabled", reason: "missing_global_key" });
  });

  it("unmapped repo + invalid global key → disabled/invalid_global_key", () => {
    expect(resolvePagerDutyRoutingKey(enabledEnv({ PAGERDUTY_ROUTING_KEY: "not-hex" }), "acme/widgets")).toEqual({ status: "disabled", reason: "invalid_global_key" });
  });

  it("uses process.env as a self-host fallback for the routing key when the runtime Env object does not carry it", () => {
    process.env.PAGERDUTY_ROUTING_KEY = VALID_KEY;
    expect(resolvePagerDutyRoutingKey(withEnv({ GITTENSORY_ENABLE_PAGERDUTY: "1" }), "acme/widgets")).toEqual({ status: "configured", routingKey: VALID_KEY, source: "global" });
  });
});

describe("resolvePagerDutyMinSeverity", () => {
  it("a valid repo-map entry wins over the global default", () => {
    const env = withEnv({ PAGERDUTY_REPO_MIN_SEVERITY: JSON.stringify({ "acme/widgets": "warning" }), PAGERDUTY_MIN_SEVERITY: "critical" });
    expect(resolvePagerDutyMinSeverity(env, "acme/widgets")).toBe("warning");
  });

  it("an invalid/absent repo entry falls back to a valid global override", () => {
    expect(resolvePagerDutyMinSeverity(withEnv({ PAGERDUTY_MIN_SEVERITY: "info" }), "acme/widgets")).toBe("info");
    const env = withEnv({ PAGERDUTY_REPO_MIN_SEVERITY: JSON.stringify({ "acme/widgets": "not-a-severity" }), PAGERDUTY_MIN_SEVERITY: "critical" });
    expect(resolvePagerDutyMinSeverity(env, "acme/widgets")).toBe("critical");
  });

  it("no repo entry + no/invalid global → defaults to error (the quietest safe default)", () => {
    expect(resolvePagerDutyMinSeverity(withEnv(), "acme/widgets")).toBe("error");
    expect(resolvePagerDutyMinSeverity(withEnv({ PAGERDUTY_MIN_SEVERITY: "not-a-severity" }), "acme/widgets")).toBe("error");
  });
});

describe("resolvePagerDutyCooldownMinutes", () => {
  it("a valid repo-map entry (number or numeric string) wins over the global default", () => {
    expect(resolvePagerDutyCooldownMinutes(withEnv({ PAGERDUTY_REPO_COOLDOWN_MINUTES: JSON.stringify({ "acme/widgets": 15 }), PAGERDUTY_COOLDOWN_MINUTES: "120" }), "acme/widgets")).toBe(15);
    expect(resolvePagerDutyCooldownMinutes(withEnv({ PAGERDUTY_REPO_COOLDOWN_MINUTES: JSON.stringify({ "acme/widgets": "30" }) }), "acme/widgets")).toBe(30);
  });

  it("a zero/negative/non-numeric repo entry falls back to a valid global override", () => {
    expect(resolvePagerDutyCooldownMinutes(withEnv({ PAGERDUTY_COOLDOWN_MINUTES: "45" }), "acme/widgets")).toBe(45);
    for (const bad of [0, -5, "nope"]) {
      const env = withEnv({ PAGERDUTY_REPO_COOLDOWN_MINUTES: JSON.stringify({ "acme/widgets": bad }), PAGERDUTY_COOLDOWN_MINUTES: "45" });
      expect(resolvePagerDutyCooldownMinutes(env, "acme/widgets")).toBe(45);
    }
  });

  it("no repo entry + no/invalid global → defaults to 60 minutes", () => {
    expect(resolvePagerDutyCooldownMinutes(withEnv(), "acme/widgets")).toBe(60);
    expect(resolvePagerDutyCooldownMinutes(withEnv({ PAGERDUTY_COOLDOWN_MINUTES: "not-a-number" }), "acme/widgets")).toBe(60);
  });
});

describe("triggerPagerDutyIncident — flag/routing gate", () => {
  it("flag off → no fetch and no audit row (silent, no log noise for repos that never opted in)", async () => {
    const calls = stubFetch();
    const env = withEnv();
    await trigger(env);
    expect(calls).toEqual([]);
    expect(await pagerDutyAudit(env)).toEqual([]);
  });

  it("flag on, no routing key resolves → no fetch, audited denied/missing_global_key", async () => {
    const calls = stubFetch();
    const env = withEnv({ GITTENSORY_ENABLE_PAGERDUTY: "1" });
    await trigger(env);
    expect(calls).toEqual([]);
    expect(await pagerDutyAudit(env)).toEqual([expect.objectContaining({ outcome: "denied", detail: "missing_global_key" })]);
  });

  it("audit failures are best-effort and never throw", async () => {
    const calls = stubFetch();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(trigger({ GITTENSORY_ENABLE_PAGERDUTY: "1" } as Env)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pagerduty_notify_audit_failed"));
    warn.mockRestore();
  });
});

describe("triggerPagerDutyIncident — min-severity gate (alert fatigue control #1)", () => {
  it("a severity below the default min (error) never pages", async () => {
    const calls = stubFetch();
    const env = enabledEnv();
    await trigger(env, { severity: "warning" });
    expect(calls).toEqual([]);
    expect(await pagerDutyAudit(env)).toEqual([expect.objectContaining({ outcome: "denied", detail: "below_min_severity" })]);
  });

  it("a severity meeting the default min (error) pages", async () => {
    const calls = stubFetch();
    await trigger(enabledEnv(), { severity: "error" });
    expect(calls).toHaveLength(1);
  });

  it("a per-repo override lowers the floor so a warning-severity anomaly pages", async () => {
    const calls = stubFetch();
    const env = enabledEnv({ PAGERDUTY_REPO_MIN_SEVERITY: JSON.stringify({ "acme/widgets": "warning" }) });
    await trigger(env, { severity: "warning" });
    expect(calls).toHaveLength(1);
  });
});

describe("triggerPagerDutyIncident — cooldown gate (alert fatigue control #2)", () => {
  it("a repeat trigger for the same dedupKey within the cooldown window is suppressed", async () => {
    const calls = stubFetch();
    const env = enabledEnv();
    await trigger(env);
    await trigger(env);
    expect(calls).toHaveLength(1);
    const rows = await pagerDutyAudit(env);
    expect(rows.map((r) => r.outcome)).toEqual(["completed", "denied"]);
    expect(rows[1]).toEqual(expect.objectContaining({ detail: "cooldown_active" }));
  });

  it("a page for a DIFFERENT dedupKey on the same repo is not suppressed by the first one's cooldown", async () => {
    const calls = stubFetch();
    const env = enabledEnv();
    await trigger(env, { dedupKey: "ops_anomaly:acme/widgets" });
    await trigger(env, { dedupKey: "some_other_condition:acme/widgets" });
    expect(calls).toHaveLength(2);
  });

  it("a page whose only prior trigger is OLDER than the cooldown window is not suppressed", async () => {
    const calls = stubFetch();
    const env = enabledEnv();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await recordAuditEvent(env, {
      eventType: "external_notification.pagerduty",
      actor: "loopover",
      targetKey: "ops_anomaly:acme/widgets",
      outcome: "completed",
      detail: "triggered",
      metadata: {},
      createdAt: twoHoursAgo,
    });
    await trigger(env); // default cooldown is 60 minutes; the seeded row is 2 hours old
    expect(calls).toHaveLength(1);
  });

  it("REGRESSION: a recent page recorded under the pre-rebrand 'gittensory' actor still suppresses a duplicate within the cooldown window", async () => {
    const calls = stubFetch();
    const env = enabledEnv();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await recordAuditEvent(env, {
      eventType: "external_notification.pagerduty",
      actor: "gittensory",
      targetKey: "ops_anomaly:acme/widgets",
      outcome: "completed",
      detail: "triggered",
      metadata: {},
      createdAt: tenMinutesAgo,
    });
    await trigger(env); // default cooldown is 60 minutes; the legacy-actor row is only 10 minutes old
    expect(calls).toHaveLength(0);
    const rows = await pagerDutyAudit(env);
    expect(rows[rows.length - 1]).toEqual(expect.objectContaining({ outcome: "denied", detail: "cooldown_active" }));
  });
});

describe("triggerPagerDutyIncident — HTTP delivery", () => {
  it("posts the PagerDuty Events API v2 payload and audits completed on success", async () => {
    const calls = stubFetch(202);
    const env = enabledEnv();
    await trigger(env, { severity: "critical", summary: "review burst on acme/widgets", customDetails: { anomalies: ["a", "b"] } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(calls[0]?.body).toMatchObject({
      routing_key: VALID_KEY,
      event_action: "trigger",
      dedup_key: "ops_anomaly:acme/widgets",
      payload: { summary: "review burst on acme/widgets", source: "loopover", severity: "critical", component: "acme/widgets", custom_details: { anomalies: ["a", "b"] } },
    });
    expect(await pagerDutyAudit(env)).toEqual([expect.objectContaining({ outcome: "completed", detail: "triggered" })]);
  });

  it("a non-ok response is audited as an error and never throws", async () => {
    stubFetch(500);
    const env = enabledEnv();
    await expect(trigger(env)).resolves.toBeUndefined();
    expect(await pagerDutyAudit(env)).toEqual([expect.objectContaining({ outcome: "error" })]);
  });

  it("a network failure is audited as an error and never throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = enabledEnv();
    await expect(trigger(env)).resolves.toBeUndefined();
    expect(await pagerDutyAudit(env)).toEqual([expect.objectContaining({ outcome: "error", detail: expect.stringContaining("network down") })]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pagerduty_trigger_failed"));
    warn.mockRestore();
  });
});
