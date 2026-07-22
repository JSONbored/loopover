import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as repositories from "../../src/db/repositories";
import {
  clearLoopEscalationManifestOverrideCacheForTest,
  isLoopEscalationSweepEnabled,
  loadActiveLoopsFromEnv,
  parseActiveLoopFacts,
  resolveLoopEscalationManifestOverride,
  runLoopEscalationSweep,
} from "../../src/review/loop-escalation-wire";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

const SELF_REPO = "JSONbored/loopover";

describe("isLoopEscalationSweepEnabled (#6349)", () => {
  it("defaults OFF and accepts the standard truthy env forms", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) {
      expect(isLoopEscalationSweepEnabled({ LOOPOVER_LOOP_ESCALATION: off })).toBe(false);
    }
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) {
      expect(isLoopEscalationSweepEnabled({ LOOPOVER_LOOP_ESCALATION: on })).toBe(true);
    }
  });

  it("a present manifest override wins outright over the env flag, in both directions (#8018)", () => {
    expect(isLoopEscalationSweepEnabled({ LOOPOVER_LOOP_ESCALATION: "false" }, { present: true, enabled: true })).toBe(true);
    expect(isLoopEscalationSweepEnabled({ LOOPOVER_LOOP_ESCALATION: "true" }, { present: true, enabled: false })).toBe(false);
  });

  it("falls back to the env flag when the manifest override is not present", () => {
    expect(isLoopEscalationSweepEnabled({ LOOPOVER_LOOP_ESCALATION: "true" }, { present: false, enabled: false })).toBe(true);
    expect(isLoopEscalationSweepEnabled({ LOOPOVER_LOOP_ESCALATION: "false" }, undefined)).toBe(false);
  });
});

describe("resolveLoopEscalationManifestOverride — config-as-code lookup (#8018)", () => {
  beforeEach(() => {
    clearLoopEscalationManifestOverrideCacheForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the self-repo's configured loopEscalation block when present", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { loopEscalation: { enabled: true } });

    expect(await resolveLoopEscalationManifestOverride(env)).toEqual({ present: true, enabled: true });
  });

  it("returns present: false when the self-repo has no loopEscalation block configured", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { wantedPaths: ["src/"] });

    expect(await resolveLoopEscalationManifestOverride(env)).toEqual({ present: false, enabled: false });
  });

  it("degrades to present: false (never throws) when the manifest load itself fails", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/"signal_snapshots"|signal_snapshots/i.test(sql)) throw new Error("poisoned query");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await resolveLoopEscalationManifestOverride(env)).toEqual({ present: false, enabled: false });
    expect(warnings.mock.calls.map((c) => String(c[0])).some((line) => line.includes("loop_escalation_manifest_override_error"))).toBe(true);
  });

  it("within the 60s TTL, reuses the cached override instead of re-reading the manifest", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { loopEscalation: { enabled: true } });
    const t0 = Date.parse("2026-07-22T00:00:00Z");
    expect(await resolveLoopEscalationManifestOverride(env, t0)).toEqual({ present: true, enabled: true });

    env.DB.prepare = (() => {
      throw new Error("should not be queried on a cache hit");
    }) as typeof env.DB.prepare;
    expect(await resolveLoopEscalationManifestOverride(env, t0 + 30_000)).toEqual({ present: true, enabled: true });
  });

  it("re-reads the manifest once the 60s TTL has elapsed", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { loopEscalation: { enabled: true } });
    const t0 = Date.parse("2026-07-22T00:00:00Z");
    expect(await resolveLoopEscalationManifestOverride(env, t0)).toEqual({ present: true, enabled: true });

    await upsertRepoFocusManifest(env, SELF_REPO, { loopEscalation: { enabled: false } });
    expect(await resolveLoopEscalationManifestOverride(env, t0 + 60_001)).toEqual({ present: true, enabled: false });
  });
});

describe("parseActiveLoopFacts / loadActiveLoopsFromEnv (#6349)", () => {
  it("accepts a well-formed row including optional killRequested and every health tier", () => {
    expect(
      parseActiveLoopFacts({
        loopId: "loop-1",
        tenantId: "acme",
        runStatus: "running",
        healthStatus: "critical",
        customerFlagged: true,
        killRequested: true,
      }),
    ).toEqual({
      loopId: "loop-1",
      tenantId: "acme",
      runStatus: "running",
      healthStatus: "critical",
      customerFlagged: true,
      killRequested: true,
    });
    expect(parseActiveLoopFacts({ loopId: "a", tenantId: "t", runStatus: "converged", healthStatus: "healthy" })).toMatchObject({
      runStatus: "converged",
      healthStatus: "healthy",
    });
    expect(parseActiveLoopFacts({ loopId: "a", tenantId: "t", runStatus: "error", healthStatus: "degraded" })).toMatchObject({
      runStatus: "error",
      healthStatus: "degraded",
    });
  });

  it("drops malformed rows (null, array, blank ids, invalid status)", () => {
    expect(parseActiveLoopFacts(null)).toBeNull();
    expect(parseActiveLoopFacts([])).toBeNull();
    expect(parseActiveLoopFacts({ loopId: "  ", tenantId: "t", runStatus: "running" })).toBeNull();
    expect(parseActiveLoopFacts({ loopId: "x", tenantId: "  ", runStatus: "running" })).toBeNull();
    expect(parseActiveLoopFacts({ loopId: "x", tenantId: "t", runStatus: "nope" })).toBeNull();
    expect(parseActiveLoopFacts({ loopId: "x" })).toBeNull();
  });

  it("loads LOOPOVER_ACTIVE_LOOPS_JSON and degrades empty on malformed input", () => {
    const env = createTestEnv({
      LOOPOVER_ACTIVE_LOOPS_JSON: JSON.stringify([
        { loopId: "good", tenantId: "t", runStatus: "abandoned" },
        { loopId: "bad" },
      ]),
    });
    expect(loadActiveLoopsFromEnv(env)).toEqual([{ loopId: "good", tenantId: "t", runStatus: "abandoned" }]);
    expect(loadActiveLoopsFromEnv(createTestEnv({ LOOPOVER_ACTIVE_LOOPS_JSON: "{not-json" }))).toEqual([]);
    expect(loadActiveLoopsFromEnv(createTestEnv({ LOOPOVER_ACTIVE_LOOPS_JSON: '{"no":"array"}' }))).toEqual([]);
    expect(loadActiveLoopsFromEnv(createTestEnv({ LOOPOVER_ACTIVE_LOOPS_JSON: "   " }))).toEqual([]);
    expect(loadActiveLoopsFromEnv(createTestEnv())).toEqual([]);
  });
});

describe("runLoopEscalationSweep (#6349)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("no-ops when nothing needs attention", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runLoopEscalationSweep(createTestEnv(), {
      loadActiveLoops: () => [{ loopId: "ok", tenantId: "t", runStatus: "running", healthStatus: "healthy" }],
    });
    expect(result.notified).toBe(false);
    expect(result.reason).toBe("nothing_needs_attention");
    expect(result.summary.needingAttention).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("uses the env JSON loader when no loadActiveLoops override is injected", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = createTestEnv({
      LOOPOVER_ACTIVE_LOOPS_JSON: JSON.stringify([{ loopId: "from-env", tenantId: "acme", runStatus: "abandoned" }]),
    });
    const result = await runLoopEscalationSweep(env);
    expect(result.summary.needingAttention.map((r) => r.loopId)).toEqual(["from-env"]);
    expect(result.reason).toBe("missing_global_webhook");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("notifies Discord when a simulated escalation-worthy loop needs attention", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let posted: { url: string; body: string } | undefined;
    const env = createTestEnv({
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
    });
    const result = await runLoopEscalationSweep(env, {
      loadActiveLoops: () => [{ loopId: "broken", tenantId: "acme", runStatus: "abandoned", healthStatus: "critical" }],
      fetchImpl: (async (url, init) => {
        posted = { url: String(url), body: String(init?.body ?? "") };
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      nowMs: () => Date.parse("2026-07-16T12:00:00.000Z"),
    });
    expect(result.notified).toBe(true);
    expect(result.summary.needingAttention.map((r) => r.loopId)).toEqual(["broken"]);
    expect(posted?.url).toBe("https://discord.com/api/webhooks/123/abc");
    expect(posted?.body).toContain("broken");
    expect(errorSpy).toHaveBeenCalled();
    const logged = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
    expect(logged.event).toBe("loop_escalation_needs_attention");
    expect(logged.needingAttention).toEqual(["broken"]);
  });

  it("falls back to global fetch when fetchImpl is not injected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let called = false;
    vi.stubGlobal(
      "fetch",
      (async () => {
        called = true;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    );
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" });
    const result = await runLoopEscalationSweep(env, {
      loadActiveLoops: () => [{ loopId: "broken", tenantId: "acme", runStatus: "abandoned" }],
    });
    expect(result.notified).toBe(true);
    expect(called).toBe(true);
  });

  it("suppresses a repeat Discord notify within the cooldown window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = createTestEnv({
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
    });
    const load = () => [{ loopId: "broken", tenantId: "acme", runStatus: "abandoned" as const }];
    let posts = 0;
    const fetchImpl = (async () => {
      posts += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const first = await runLoopEscalationSweep(env, { loadActiveLoops: load, fetchImpl, nowMs: () => 1_000_000 });
    const second = await runLoopEscalationSweep(env, { loadActiveLoops: load, fetchImpl, nowMs: () => 1_000_000 + 60_000 });
    expect(first.notified).toBe(true);
    expect(second.notified).toBe(false);
    expect(second.reason).toBe("cooldown");
    expect(posts).toBe(1);
  });

  it("still logs when Discord is unset, without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runLoopEscalationSweep(createTestEnv(), {
      loadActiveLoops: () => [{ loopId: "broken", tenantId: "acme", runStatus: "error" }],
    });
    expect(result.notified).toBe(false);
    expect(result.reason).toBe("missing_global_webhook");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("rejects an invalid Discord webhook URL", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runLoopEscalationSweep(createTestEnv({ DISCORD_WEBHOOK_URL: "https://example.com/not-discord" }), {
      loadActiveLoops: () => [{ loopId: "broken", tenantId: "acme", runStatus: "abandoned" }],
    });
    expect(result.notified).toBe(false);
    expect(result.reason).toBe("invalid_global_webhook");
  });

  it("records an error when Discord returns a non-OK status", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await runLoopEscalationSweep(createTestEnv({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" }), {
      loadActiveLoops: () => [{ loopId: "broken", tenantId: "acme", runStatus: "abandoned" }],
      fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    expect(result.notified).toBe(false);
    expect(result.reason).toContain("discord_webhook_http_500");
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("loop_escalation_discord_failed"))).toBe(true);
  });

  it("continues when the cooldown audit lookup throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(repositories, "countRecentAuditEventsForActorAndTarget").mockRejectedValueOnce(new Error("db down"));
    const result = await runLoopEscalationSweep(createTestEnv({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" }), {
      loadActiveLoops: () => [{ loopId: "broken", tenantId: "acme", runStatus: "abandoned" }],
      fetchImpl: (async () => new Response(null, { status: 204 })) as typeof fetch,
    });
    expect(result.notified).toBe(true);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("loop_escalation_cooldown_check_failed"))).toBe(true);
  });

  it("rejects http Discord webhooks and unknown hosts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = () => [{ loopId: "broken", tenantId: "acme", runStatus: "abandoned" as const }];
    await expect(
      runLoopEscalationSweep(createTestEnv({ DISCORD_WEBHOOK_URL: "http://discord.com/api/webhooks/123/abc" }), { loadActiveLoops: load }),
    ).resolves.toMatchObject({ notified: false, reason: "invalid_global_webhook" });
    await expect(
      runLoopEscalationSweep(createTestEnv({ DISCORD_WEBHOOK_URL: "https://evil.example/api/webhooks/123/abc" }), { loadActiveLoops: load }),
    ).resolves.toMatchObject({ notified: false, reason: "invalid_global_webhook" });
    await expect(
      runLoopEscalationSweep(createTestEnv({ DISCORD_WEBHOOK_URL: "https://discord.com/api/elsewhere" }), { loadActiveLoops: load }),
    ).resolves.toMatchObject({ notified: false, reason: "invalid_global_webhook" });
    await expect(
      runLoopEscalationSweep(createTestEnv({ DISCORD_WEBHOOK_URL: "not-a-url" }), { loadActiveLoops: load }),
    ).resolves.toMatchObject({ notified: false, reason: "invalid_global_webhook" });
  });

  it("honors an explicit cooldownMinutes override", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" });
    const load = () => [{ loopId: "broken", tenantId: "acme", runStatus: "abandoned" as const }];
    const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const first = await runLoopEscalationSweep(env, {
      loadActiveLoops: load,
      fetchImpl,
      cooldownMinutes: 10,
      nowMs: () => 5_000_000,
    });
    const second = await runLoopEscalationSweep(env, {
      loadActiveLoops: load,
      fetchImpl,
      cooldownMinutes: 10,
      nowMs: () => 5_000_000 + 60_000,
    });
    expect(first.notified).toBe(true);
    expect(second.notified).toBe(false);
    expect(second.reason).toBe("cooldown");
  });

  it("continues when recording the Discord-error audit throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValueOnce(new Error("audit down"));
    const result = await runLoopEscalationSweep(createTestEnv({ DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc" }), {
      loadActiveLoops: () => [{ loopId: "broken", tenantId: "acme", runStatus: "abandoned" }],
      fetchImpl: (async () => new Response("nope", { status: 502 })) as typeof fetch,
    });
    expect(result.notified).toBe(false);
    expect(result.reason).toContain("discord_webhook_http_502");
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("loop_escalation_audit_failed"))).toBe(true);
  });
});
