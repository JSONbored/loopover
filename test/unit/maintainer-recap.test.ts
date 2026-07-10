import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMaintainerRecap, runMaintainerRecap, type MaintainerRecapRepoInput } from "../../src/services/maintainer-recap";
import type { OutcomeCalibration } from "../../src/services/outcome-calibration";
import type { RecapReport } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

const GEN = "2026-07-08T00:00:00.000Z";
const DISCORD_HOOK = "https://discord.com/api/webhooks/123/abc";
const SLACK_HOOK = "https://hooks.slack.com/services/T00/B00/xxxyyyzzz";

/** Build one repo's injected inputs from the handful of counts this builder actually reads. `cohorts` (#4521)
 *  is omitted by default -- every pre-existing call site keeps exercising the no-cohorts (legacy) arm. */
function repoInput(
  repoFullName: string,
  c: {
    blocked?: number;
    blockedThenMerged?: number;
    overridden?: number;
    totalResolved?: number;
    merged?: number;
    closed?: number;
    reversals?: number;
    emptyBands?: boolean;
    cohorts?: { miner: { blocked: number; blockedThenMerged: number }; human: { blocked: number; blockedThenMerged: number } };
  } = {},
): MaintainerRecapRepoInput {
  const blocked = c.blocked ?? 0;
  const blockedThenMerged = c.blockedThenMerged ?? 0;
  const bands: OutcomeCalibration["slop"]["bands"] = c.emptyBands
    ? []
    : [{ band: "clean", sampleSize: 0, merged: c.merged ?? 0, closed: c.closed ?? 0, mergeRate: 0 }];
  const cohortReport = (counts: { blocked: number; blockedThenMerged: number }) => ({
    perGateType: [],
    overall: { blocked: counts.blocked, blockedThenMerged: counts.blockedThenMerged, falsePositiveRate: counts.blocked > 0 ? Math.round((counts.blockedThenMerged / counts.blocked) * 1000) / 1000 : null },
  });
  return {
    gatePrecision: {
      repoFullName,
      generatedAt: GEN,
      windowDays: 7,
      perGateType: [{ gateType: "missing_linked_issue", blocked, blockedThenMerged, overridden: c.overridden ?? 0, falsePositiveRate: null }],
      overall: { blocked, blockedThenMerged, falsePositiveRate: null },
      signals: [],
      ...(c.cohorts ? { cohorts: { miner: cohortReport(c.cohorts.miner), human: cohortReport(c.cohorts.human) } } : {}),
    },
    calibration: {
      repoFullName,
      generatedAt: GEN,
      windowDays: 7,
      slop: { totalResolved: c.totalResolved ?? 0, bands, overallMergeRate: null, discriminates: null },
      recommendations: { total: 0, positive: 0, negative: c.reversals ?? 0, pending: 0, positiveRate: null },
      signals: [],
    },
  };
}

describe("buildMaintainerRecap (#2239)", () => {
  it("zeroes everything for an empty window and reports the null false-positive rate", () => {
    // windowDays omitted ⇒ normalizeWindowDays' non-finite arm ⇒ the 7-day default.
    const report = buildMaintainerRecap({ generatedAt: GEN, repos: [] });
    expect(report.windowDays).toBe(7);
    expect(report.repos).toEqual([]);
    expect(report.totals).toMatchObject({ reviewed: 0, merged: 0, closed: 0, blocked: 0, gateFalsePositives: 0, gateOverrides: 0, reversals: 0, gateFalsePositiveRate: null });
    // blocked === 0 ⇒ rate is null ⇒ the "not enough blocked PRs" summary arm.
    expect(report.summary[1]).toContain("not enough blocked PRs");
    expect(report.summary[0]).toContain("0 repo(s)");
  });

  it("folds a single repo's counts and computes the gate false-positive rate", () => {
    const report = buildMaintainerRecap({
      generatedAt: GEN,
      windowDays: 14, // provided ⇒ normalizeWindowDays' finite/clamp arm
      repos: [repoInput("owner/repo-a", { blocked: 10, blockedThenMerged: 2, overridden: 3, totalResolved: 8, merged: 6, closed: 2, reversals: 1 })],
    });
    expect(report.windowDays).toBe(14);
    expect(report.repos).toHaveLength(1);
    expect(report.repos[0]).toMatchObject({ repoFullName: "owner/repo-a", reviewed: 8, merged: 6, closed: 2, gateFalsePositives: 2, gateOverrides: 3, reversals: 1 });
    expect(report.totals).toMatchObject({ reviewed: 8, merged: 6, closed: 2, blocked: 10, gateFalsePositives: 2, gateOverrides: 3, reversals: 1, gateFalsePositiveRate: 0.2 });
    // blocked > 0 ⇒ the populated summary arm with the percentage.
    expect(report.summary[1]).toContain("Gate false-positive rate: 20%");
    expect(report.summary[1]).toContain("(2/10 block(s) later merged)");
    expect(report.summary[2]).toContain("3 maintainer override(s), 1 recommendation reversal(s)");
  });

  it("aggregates across multiple repos (including one with no slop bands)", () => {
    const report = buildMaintainerRecap({
      generatedAt: GEN,
      windowDays: 30,
      repos: [
        repoInput("owner/repo-a", { blocked: 4, blockedThenMerged: 1, overridden: 1, totalResolved: 5, merged: 4, closed: 1, reversals: 2 }),
        repoInput("owner/repo-b", { blocked: 6, blockedThenMerged: 3, overridden: 2, totalResolved: 0, reversals: 1, emptyBands: true }),
      ],
    });
    expect(report.repos).toHaveLength(2);
    expect(report.repos[1]).toMatchObject({ repoFullName: "owner/repo-b", reviewed: 0, merged: 0, closed: 0, gateFalsePositives: 3, gateOverrides: 2, reversals: 1 });
    expect(report.totals).toMatchObject({ reviewed: 5, merged: 4, closed: 1, blocked: 10, gateFalsePositives: 4, gateOverrides: 3, reversals: 3, gateFalsePositiveRate: 0.4 });
  });

  it("clamps an out-of-range window to the max and a zero to the min", () => {
    expect(buildMaintainerRecap({ generatedAt: GEN, windowDays: 999, repos: [] }).windowDays).toBe(90);
    expect(buildMaintainerRecap({ generatedAt: GEN, windowDays: 0, repos: [] }).windowDays).toBe(1);
  });

  it("scrubs a local-path leak out of the repo name (public-safe by construction)", () => {
    const report = buildMaintainerRecap({ generatedAt: GEN, repos: [repoInput("/Users/secret/repo", { blocked: 1, blockedThenMerged: 0 })] });
    expect(report.repos[0]?.repoFullName).toContain("<redacted-path>");
    expect(report.repos[0]?.repoFullName).not.toContain("/Users/secret");
  });
});

// #4521: additive miner-vs-human cohort split, computed only for repos whose injected GatePrecisionReport
// actually carried `cohorts` (loadGatePrecisionReport's includeCohorts option, #4520).
describe("buildMaintainerRecap cohort split (#4521)", () => {
  it("omits totals.cohorts and the per-repo cohorts field when no repo's report carried one (byte-identical to before the split existed)", () => {
    const report = buildMaintainerRecap({ generatedAt: GEN, repos: [repoInput("owner/repo-a", { blocked: 4, blockedThenMerged: 1 })] });
    expect(report.totals.cohorts).toBeUndefined();
    expect(report.repos[0]?.cohorts).toBeUndefined();
    expect(report.summary).toHaveLength(3); // no 4th cohort summary line either
  });

  it("attaches the per-repo split verbatim and aggregates it into totals.cohorts", () => {
    const report = buildMaintainerRecap({
      generatedAt: GEN,
      repos: [
        repoInput("owner/repo-a", {
          blocked: 6, blockedThenMerged: 2,
          cohorts: { miner: { blocked: 2, blockedThenMerged: 1 }, human: { blocked: 4, blockedThenMerged: 1 } },
        }),
      ],
    });
    expect(report.repos[0]?.cohorts).toMatchObject({
      miner: { blocked: 2, gateFalsePositives: 1, gateFalsePositiveRate: 0.5 },
      human: { blocked: 4, gateFalsePositives: 1, gateFalsePositiveRate: 0.25 },
    });
    expect(report.totals.cohorts).toMatchObject({
      miner: { blocked: 2, gateFalsePositives: 1, gateFalsePositiveRate: 0.5 },
      human: { blocked: 4, gateFalsePositives: 1, gateFalsePositiveRate: 0.25 },
    });
    expect(report.summary[3]).toContain("Miner-originated: 2 blocked (50% false-positive)");
    expect(report.summary[3]).toContain("Human-originated: 4 blocked (25% false-positive)");
  });

  it("sums cohorts ACROSS repos, correctly reporting n/a for a zero-blocked cohort", () => {
    const report = buildMaintainerRecap({
      generatedAt: GEN,
      repos: [
        repoInput("owner/repo-a", { blocked: 2, blockedThenMerged: 0, cohorts: { miner: { blocked: 2, blockedThenMerged: 0 }, human: { blocked: 0, blockedThenMerged: 0 } } }),
        repoInput("owner/repo-b", { blocked: 3, blockedThenMerged: 1, cohorts: { miner: { blocked: 1, blockedThenMerged: 0 }, human: { blocked: 2, blockedThenMerged: 1 } } }),
      ],
    });
    expect(report.totals.cohorts).toMatchObject({
      miner: { blocked: 3, gateFalsePositives: 0, gateFalsePositiveRate: 0 },
      human: { blocked: 2, gateFalsePositives: 1, gateFalsePositiveRate: 0.5 },
    });
  });

  it("degrades gracefully when only SOME repos in the window carried a cohort split (partial adoption)", () => {
    const report = buildMaintainerRecap({
      generatedAt: GEN,
      repos: [
        repoInput("owner/repo-a", { blocked: 4, blockedThenMerged: 1 }), // no cohorts -- doesn't contribute
        repoInput("owner/repo-b", { blocked: 2, blockedThenMerged: 1, cohorts: { miner: { blocked: 1, blockedThenMerged: 1 }, human: { blocked: 1, blockedThenMerged: 0 } } }),
      ],
    });
    expect(report.repos[0]?.cohorts).toBeUndefined();
    expect(report.repos[1]?.cohorts).toBeDefined();
    // Only repo-b's counts feed the aggregate -- repo-a's 4 blocked never appear here.
    expect(report.totals.cohorts).toMatchObject({ miner: { blocked: 1 }, human: { blocked: 1 } });
    // But repo-a's counts STILL feed the ordinary (non-cohort) totals, unaffected by the split.
    expect(report.totals.blocked).toBe(6);
  });
});

function envWithBothWebhooks(): Env {
  return createTestEnv({ DISCORD_WEBHOOK_URL: DISCORD_HOOK, SLACK_WEBHOOK_URL: SLACK_HOOK }) as Env;
}

/** Record fetch calls to Discord/Slack webhooks only (ignore manifest/settings fetches). */
function stubRecapChannelFetch(): Array<{ url: string; body: string }> {
  const calls: Array<{ url: string; body: string }> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target === DISCORD_HOOK || target === SLACK_HOOK) {
      calls.push({ url: target, body: init?.body ? String(init.body) : "" });
    }
    return new Response(null, { status: 204 });
  });
  return calls;
}

function leakyRecapReport(): RecapReport {
  return {
    generatedAt: GEN,
    windowDays: 7,
    repos: [
      {
        repoFullName: "acme/widgets /Users/secret/leak",
        reviewed: 3,
        merged: 2,
        closed: 1,
        gateFalsePositives: 0,
        gateOverrides: 0,
        reversals: 0,
      },
    ],
    totals: {
      reviewed: 3,
      merged: 2,
      closed: 1,
      blocked: 0,
      gateFalsePositives: 0,
      gateOverrides: 0,
      reversals: 0,
      gateFalsePositiveRate: null,
    },
    summary: ["Clean recap line.", "payout was 500 tao last window", "path /root/secrets/config.json here"],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runMaintainerRecap (#2252 end-to-end orchestration)", () => {
  it("builds an empty report when neither report nor repos are injected (repos ?? [] absent arm)", async () => {
    stubRecapChannelFetch();
    const result = await runMaintainerRecap(envWithBothWebhooks(), {});
    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.report.repos).toEqual([]);
    expect(result.formatted).toContain("_No repositories in this window._");
    expect(result.formatted).toContain("(n/a)");
  });

  it("short-circuits when enabled is false — no build/format/fetch (flag-OFF arm)", async () => {
    const calls = stubRecapChannelFetch();
    const result = await runMaintainerRecap(envWithBothWebhooks(), { enabled: false, repos: [repoInput("owner/repo")] });
    expect(result).toEqual({ skipped: true, reason: "disabled" });
    expect(calls).toHaveLength(0);
  });

  it("builds, formats, and fans out to BOTH channels when both webhooks are configured", async () => {
    const calls = stubRecapChannelFetch();
    const result = await runMaintainerRecap(envWithBothWebhooks(), { repos: [repoInput("owner/repo-a", { blocked: 4, blockedThenMerged: 1, totalResolved: 2, merged: 1, closed: 1 })] });
    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.formatted).toContain("# Maintainer recap");
    expect(result.formatted).toMatch(/\(\d+%\)/);
    expect(result.delivery.discord).toEqual({ sent: true });
    expect(result.delivery.slack).toEqual({ sent: true });
    expect(calls.map((c) => c.url).sort()).toEqual([DISCORD_HOOK, SLACK_HOOK].sort());
    expect(calls.some((c) => c.url === DISCORD_HOOK && c.body.includes("Maintainer recap"))).toBe(true);
    expect(calls.some((c) => c.url === SLACK_HOOK && c.body.includes("Maintainer recap"))).toBe(true);
  });

  it("still delivers to Slack when Discord fetch fails (Discord outage must not abort Slack)", async () => {
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === DISCORD_HOOK) throw new Error("discord down");
      if (String(url) === SLACK_HOOK) return new Response(null, { status: 204 });
      return new Response(null, { status: 204 });
    });
    const result = await runMaintainerRecap(envWithBothWebhooks(), { repos: [repoInput("owner/repo")] });
    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.delivery.discord).toEqual({ sent: false, reason: "discord down" });
    expect(result.delivery.slack).toEqual({ sent: true });
  });

  it("still delivers to Discord when Slack fetch fails (Slack outage must not abort Discord)", async () => {
    vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
      if (String(url) === SLACK_HOOK) throw new Error("slack down");
      return new Response(null, { status: 204 });
    });
    const result = await runMaintainerRecap(envWithBothWebhooks(), { repos: [repoInput("owner/repo")] });
    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.delivery.discord).toEqual({ sent: true });
    expect(result.delivery.slack).toEqual({ sent: false, reason: "slack down" });
  });

  it("redacts reward/path terms in BOTH channel payloads via formatMaintainerRecap", async () => {
    const calls = stubRecapChannelFetch();
    const result = await runMaintainerRecap(envWithBothWebhooks(), { report: leakyRecapReport() });
    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.delivery.discord.sent).toBe(true);
    expect(result.delivery.slack.sent).toBe(true);
    for (const call of calls) {
      expect(call.body.toLowerCase()).not.toMatch(/payout|\/users\/secret|\/root\/secrets/);
      expect(call.body).toMatch(/redacted/);
    }
  });
});
