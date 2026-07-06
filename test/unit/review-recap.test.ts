import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReviewRecap, generateAndSendReviewRecap, loadReviewRecap, sendReviewRecapToDiscord } from "../../src/services/review-recap";
import { createTestEnv } from "../helpers/d1";

const NOW = "2026-07-06T00:00:00Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildReviewRecap (#1963, pure aggregate)", () => {
  it("counts a merged PR whose mergedAt falls inside the window", () => {
    const recap = buildReviewRecap({
      repoFullName: "JSONbored/gittensory",
      generatedAt: NOW,
      windowDays: 7,
      pullRequests: [{ state: "closed", mergedAt: new Date(NOW_MS - 2 * DAY_MS).toISOString() }],
      gateMergePrecision: null,
      gateDecided: 0,
    });
    expect(recap.merged).toBe(1);
    expect(recap.closed).toBe(0);
    expect(recap.stillOpen).toBe(0);
  });

  it("excludes a merged PR whose mergedAt falls OUTSIDE the window (both sides of the >= sinceMs branch)", () => {
    const recap = buildReviewRecap({
      repoFullName: "JSONbored/gittensory",
      generatedAt: NOW,
      windowDays: 7,
      pullRequests: [{ state: "closed", mergedAt: new Date(NOW_MS - 30 * DAY_MS).toISOString() }],
      gateMergePrecision: null,
      gateDecided: 0,
    });
    expect(recap.merged).toBe(0);
    expect(recap.closed).toBe(0);
    expect(recap.stillOpen).toBe(0);
  });

  it("counts a closed-unmerged PR using closedAt when present", () => {
    const recap = buildReviewRecap({
      repoFullName: "JSONbored/gittensory",
      generatedAt: NOW,
      windowDays: 7,
      pullRequests: [{ state: "closed", mergedAt: null, closedAt: new Date(NOW_MS - 1 * DAY_MS).toISOString() }],
      gateMergePrecision: null,
      gateDecided: 0,
    });
    expect(recap.closed).toBe(1);
    expect(recap.merged).toBe(0);
  });

  it("falls back to updatedAt for a closed-unmerged PR whose closedAt is absent (nullish fallback, present side)", () => {
    const recap = buildReviewRecap({
      repoFullName: "JSONbored/gittensory",
      generatedAt: NOW,
      windowDays: 7,
      pullRequests: [{ state: "closed", mergedAt: null, closedAt: null, updatedAt: new Date(NOW_MS - 1 * DAY_MS).toISOString() }],
      gateMergePrecision: null,
      gateDecided: 0,
    });
    expect(recap.closed).toBe(1);
  });

  it("never counts a closed PR with NEITHER closedAt nor updatedAt parseable (nullish fallback, absent side)", () => {
    const recap = buildReviewRecap({
      repoFullName: "JSONbored/gittensory",
      generatedAt: NOW,
      windowDays: 7,
      pullRequests: [{ state: "closed", mergedAt: null, closedAt: null, updatedAt: null }],
      gateMergePrecision: null,
      gateDecided: 0,
    });
    expect(recap.closed).toBe(0);
    expect(recap.merged).toBe(0);
    expect(recap.stillOpen).toBe(0);
  });

  it("counts an open PR toward stillOpen regardless of window", () => {
    const recap = buildReviewRecap({
      repoFullName: "JSONbored/gittensory",
      generatedAt: NOW,
      windowDays: 7,
      pullRequests: [{ state: "open" }],
      gateMergePrecision: null,
      gateDecided: 0,
    });
    expect(recap.stillOpen).toBe(1);
    expect(recap.merged).toBe(0);
    expect(recap.closed).toBe(0);
  });

  it("clamps a non-finite windowDays to the 7-day default (nullish/non-finite side)", () => {
    const recap = buildReviewRecap({
      repoFullName: "JSONbored/gittensory",
      generatedAt: NOW,
      windowDays: undefined,
      pullRequests: [],
      gateMergePrecision: null,
      gateDecided: 0,
    });
    expect(recap.windowDays).toBe(7);
  });

  it("clamps windowDays into [1, 90] on both sides", () => {
    const low = buildReviewRecap({ repoFullName: "r", generatedAt: NOW, windowDays: -5, pullRequests: [], gateMergePrecision: null, gateDecided: 0 });
    expect(low.windowDays).toBe(1);
    const high = buildReviewRecap({ repoFullName: "r", generatedAt: NOW, windowDays: 999, pullRequests: [], gateMergePrecision: null, gateDecided: 0 });
    expect(high.windowDays).toBe(90);
  });

  it("renders a gate-precision summary line when a precision value IS present (ternary present side)", () => {
    const recap = buildReviewRecap({
      repoFullName: "JSONbored/gittensory",
      generatedAt: NOW,
      windowDays: 7,
      pullRequests: [],
      gateMergePrecision: 0.9123,
      gateDecided: 12,
    });
    expect(recap.gatePrecision).toBe(0.9123);
    expect(recap.gateDecided).toBe(12);
    expect(recap.summary.join(" ")).toMatch(/Gate merge precision: 91% \(12 decided prediction\(s\)\)\./);
  });

  it("renders a 'not enough data' line when gate precision is null (ternary absent side)", () => {
    const recap = buildReviewRecap({
      repoFullName: "JSONbored/gittensory",
      generatedAt: NOW,
      windowDays: 7,
      pullRequests: [],
      gateMergePrecision: null,
      gateDecided: 0,
    });
    expect(recap.summary.join(" ")).toMatch(/not enough decided predictions yet to report/);
  });

  it("scrubs a local filesystem path out of the repo full name (defense-in-depth redaction)", () => {
    const recap = buildReviewRecap({
      repoFullName: "acme/widgets /Users/someone/leak",
      generatedAt: NOW,
      windowDays: 7,
      pullRequests: [],
      gateMergePrecision: null,
      gateDecided: 0,
    });
    expect(recap.repoFullName).not.toMatch(/\/Users\//);
    expect(recap.repoFullName).toContain("<redacted-path>");
  });
});

describe("loadReviewRecap (#1963, D1-backed loader)", () => {
  it("aggregates real pull_requests rows and a matching gate_decision/pr_outcome pair for the SAME repo", async () => {
    const env = createTestEnv();
    await env.DB.prepare(
      `INSERT INTO pull_requests (id, repo_full_name, number, title, state, merged_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "pr-1", "JSONbored/gittensory", 1, "merged pr", "closed", new Date(NOW_MS - 2 * DAY_MS).toISOString(), new Date(NOW_MS - 2 * DAY_MS).toISOString(),
        "pr-2", "JSONbored/gittensory", 2, "closed pr", "closed", null, new Date(NOW_MS - 1 * DAY_MS).toISOString(),
        "pr-3", "JSONbored/gittensory", 3, "open pr", "open", null, new Date(NOW_MS - 1 * DAY_MS).toISOString(),
      )
      .run();
    const gd = new Date(NOW_MS - 3 * DAY_MS).toISOString();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at)
       VALUES (?, ?, ?, 'gate_decision', 'merge', 'gittensory-native', ?)`,
    ).bind("ra-1", "JSONbored/gittensory", "JSONbored/gittensory#1", gd).run();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at)
       VALUES (?, ?, ?, 'pr_outcome', 'merged', 'gittensory-native', ?)`,
    ).bind("ra-2", "JSONbored/gittensory", "JSONbored/gittensory#1", gd).run();

    const recap = await loadReviewRecap(env, "JSONbored/gittensory", { windowDays: 7, nowIso: NOW });
    expect(recap.merged).toBe(1);
    expect(recap.closed).toBe(1);
    expect(recap.stillOpen).toBe(1);
    expect(recap.gateDecided).toBe(1);
    expect(recap.gatePrecision).toBe(1);
  });

  it("returns null gate precision when this repo has no gate-eval row (project-lookup absent side)", async () => {
    const env = createTestEnv();
    const recap = await loadReviewRecap(env, "JSONbored/gittensory", { windowDays: 7, nowIso: NOW });
    expect(recap.gatePrecision).toBeNull();
    expect(recap.gateDecided).toBe(0);
    expect(recap.merged).toBe(0);
  });

  it("matches the project column case-insensitively", async () => {
    const env = createTestEnv();
    const gd = new Date(NOW_MS - 1 * DAY_MS).toISOString();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at)
       VALUES (?, ?, ?, 'gate_decision', 'merge', 'gittensory-native', ?)`,
    ).bind("ra-1", "jsonbored/gittensory", "jsonbored/gittensory#9", gd).run();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at)
       VALUES (?, ?, ?, 'pr_outcome', 'merged', 'gittensory-native', ?)`,
    ).bind("ra-2", "jsonbored/gittensory", "jsonbored/gittensory#9", gd).run();

    const recap = await loadReviewRecap(env, "JSONbored/Gittensory", { windowDays: 7, nowIso: NOW });
    expect(recap.gateDecided).toBe(1);
    expect(recap.gatePrecision).toBe(1);
  });

  it("falls back to Date.now() for computeGateEval's nowMs when nowIso is unparseable (ternary non-finite side)", async () => {
    const env = createTestEnv();
    // An unparseable nowIso still produces a usable recap: buildReviewRecap's OWN generatedAt/sinceMs math
    // degrades separately (asserted by buildReviewRecap's own tests) -- this test isolates the OTHER
    // consumer of generatedAt, computeGateEval's nowMs, which must fall back to Date.now() rather than NaN.
    const recap = await loadReviewRecap(env, "JSONbored/gittensory", { windowDays: 7, nowIso: "not-a-real-date" });
    expect(recap.gatePrecision).toBeNull();
    expect(recap.gateDecided).toBe(0);
  });

  it("defaults nowIso/windowDays when omitted (invariant: never throws, always returns a shape)", async () => {
    const env = createTestEnv();
    const recap = await loadReviewRecap(env, "JSONbored/gittensory");
    expect(recap.windowDays).toBe(7);
    expect(typeof recap.generatedAt).toBe("string");
  });
});

const HOOK = "https://discord.com/api/webhooks/123/abc";

function envWithWebhook(): Env {
  return Object.assign(createTestEnv(), { GITTENSORY_DISCORD_WEBHOOK: HOOK }) as Env;
}

async function auditRows(env: Env): Promise<Array<{ outcome: string; detail: string }>> {
  const rows = await env.DB.prepare("select outcome, detail from audit_events where event_type = 'review_recap_notification.discord' order by created_at").all<{ outcome: string; detail: string }>();
  return rows.results ?? [];
}

describe("sendReviewRecapToDiscord (#1963, reuses resolveDiscordWebhook)", () => {
  const recap = buildReviewRecap({
    repoFullName: "JSONbored/gittensory",
    generatedAt: NOW,
    windowDays: 7,
    pullRequests: [],
    gateMergePrecision: 0.95,
    gateDecided: 20,
  });

  it("posts an embed and records a completed audit event when a webhook IS configured (resolved.status === configured side)", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(null, { status: 204 });
    });
    const env = envWithWebhook();
    const result = await sendReviewRecapToDiscord(env, recap);
    expect(result.sent).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(HOOK);
    expect(JSON.parse(calls[0]?.body ?? "{}").embeds[0].title).toContain("JSONbored/gittensory");
    const rows = await auditRows(env);
    expect(rows.some((r) => r.outcome === "completed")).toBe(true);
  });

  it("denies delivery and records it when NO webhook is configured (resolved.status !== configured side)", async () => {
    const env = createTestEnv();
    const result = await sendReviewRecapToDiscord(env, recap);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("missing_repo_webhook");
    const rows = await auditRows(env);
    expect(rows.some((r) => r.outcome === "denied")).toBe(true);
  });

  it("degrades to a recorded error result when the webhook POST throws (fail-safe path)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const env = envWithWebhook();
    const result = await sendReviewRecapToDiscord(env, recap);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("network down");
    const rows = await auditRows(env);
    expect(rows.some((r) => r.outcome === "error")).toBe(true);
  });

  it("treats a non-2xx webhook response as a failure (mirrors notifyActionToDiscord's http-status guard)", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 429 }));
    const env = envWithWebhook();
    const result = await sendReviewRecapToDiscord(env, recap);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("discord_webhook_http_429");
  });
});

describe("generateAndSendReviewRecap (#1963, manual-trigger entry point)", () => {
  it("builds the recap and returns both the recap and the delivery result together", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const env = envWithWebhook();
    const { recap, delivery } = await generateAndSendReviewRecap(env, "JSONbored/gittensory", { windowDays: 7, nowIso: NOW });
    expect(recap.repoFullName).toBe("JSONbored/gittensory");
    expect(delivery.sent).toBe(true);
  });

  it("still returns the computed recap when delivery is denied (no webhook configured)", async () => {
    const env = createTestEnv();
    const { recap, delivery } = await generateAndSendReviewRecap(env, "JSONbored/gittensory", { windowDays: 7, nowIso: NOW });
    expect(recap.windowDays).toBe(7);
    expect(delivery.sent).toBe(false);
  });
});
