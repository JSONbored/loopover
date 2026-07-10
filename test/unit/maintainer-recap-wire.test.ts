import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecapEnabled, resolveMaintainerRecapManifestOverride, runMaintainerRecapJob, shouldFireMaintainerRecap } from "../../src/review/maintainer-recap-wire";
import type { MaintainerRecapJobSkipped } from "../../src/review/maintainer-recap-wire";
import type { RunMaintainerRecapResult } from "../../src/services/maintainer-recap";
import { updatePullRequestSlopAssessment, upsertPullRequestFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

const SELF_REPO = "JSONbored/gittensory";

const HOOK = "https://discord.com/api/webhooks/123/abc";

function ranRecap(
  result: MaintainerRecapJobSkipped | RunMaintainerRecapResult,
): Extract<RunMaintainerRecapResult, { skipped: false }> {
  expect(result.skipped).toBe(false);
  if (result.skipped) throw new Error("expected recap job to run");
  return result;
}

// Wrap env.DB.prepare so any SQL matching `pattern` throws, exercising a fail-safe catch; every other
// query delegates to the real test DB unchanged. Mirrors ops-wire.test.ts's poisonDbPrepare.
function poisonDbPrepare(env: Env, pattern: RegExp): void {
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = ((sql: string) => {
    if (pattern.test(sql)) throw new Error("poisoned query");
    return realPrepare(sql);
  }) as typeof env.DB.prepare;
}

// Mark a repo registered so recapScanRepos picks it up (mirrors ops-wire.test.ts's seedRegisteredRepo).
async function seedRegisteredRepo(env: Env, fullName: string): Promise<void> {
  const [owner, name] = fullName.split("/");
  await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } })
    .prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 1)")
    .bind(fullName, owner, name)
    .run();
}

// A resolved, merged PR carrying a slop assessment so it counts in buildRepoOutcomeCalibration's slop bands.
async function seedMergedPr(env: Env, repoFullName: string, number: number): Promise<void> {
  await upsertPullRequestFromGitHub(env, repoFullName, { number, title: `PR ${number}`, state: "closed", merged_at: "2026-06-01T00:00:00.000Z" });
  await updatePullRequestSlopAssessment(env, repoFullName, number, { slopRisk: 0, slopBand: "clean" });
}

// Only RECORDS calls to the Discord webhook itself -- recapScanRepos's resolveRepositorySettings also fetches
// each repo's .gittensory.yml (loadRepoFocusManifest), which must keep succeeding (generic 204) but not be
// mistaken for a webhook post.
function stubDiscordFetch(): Array<{ body: string }> {
  const calls: Array<{ body: string }> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === HOOK) calls.push({ body: init?.body ? String(init.body) : "" });
    return new Response(null, { status: 204 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isRecapEnabled — default OFF, truthy convention", () => {
  it("is OFF for unset / false / empty, ON for 1/true/yes/on", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isRecapEnabled({ GITTENSORY_MAINTAINER_RECAP: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isRecapEnabled({ GITTENSORY_MAINTAINER_RECAP: on })).toBe(true);
  });

  it("a present manifest override wins outright over the env flag, in both directions (#2250)", () => {
    expect(isRecapEnabled({ GITTENSORY_MAINTAINER_RECAP: "false" }, { present: true, enabled: true, cadence: "weekly" })).toBe(true);
    expect(isRecapEnabled({ GITTENSORY_MAINTAINER_RECAP: "true" }, { present: true, enabled: false, cadence: "weekly" })).toBe(false);
  });

  it("falls back to the env flag when the manifest override is not present", () => {
    expect(isRecapEnabled({ GITTENSORY_MAINTAINER_RECAP: "true" }, { present: false, enabled: false, cadence: "weekly" })).toBe(true);
    expect(isRecapEnabled({ GITTENSORY_MAINTAINER_RECAP: "false" }, undefined)).toBe(false);
  });
});

describe("shouldFireMaintainerRecap — cadence gate (#2248)", () => {
  it("fires the weekly default (Monday 14:00 UTC) and nowhere else", () => {
    expect(shouldFireMaintainerRecap({}, 14, 1)).toBe(true); // Monday @ 14:00 UTC
    expect(shouldFireMaintainerRecap({}, 14, 2)).toBe(false); // wrong day
    expect(shouldFireMaintainerRecap({}, 15, 1)).toBe(false); // wrong hour
  });

  it("an explicit weekly cadence behaves exactly like the default", () => {
    expect(shouldFireMaintainerRecap({ GITTENSORY_RECAP_CADENCE: "weekly" }, 14, 1)).toBe(true);
    expect(shouldFireMaintainerRecap({ GITTENSORY_RECAP_CADENCE: "weekly" }, 14, 2)).toBe(false);
  });

  it("daily cadence fires every day at the configured hour, ignoring day-of-week", () => {
    const env = { GITTENSORY_RECAP_CADENCE: "daily" };
    expect(shouldFireMaintainerRecap(env, 14, 1)).toBe(true);
    expect(shouldFireMaintainerRecap(env, 14, 3)).toBe(true);
    expect(shouldFireMaintainerRecap(env, 14, 6)).toBe(true);
    expect(shouldFireMaintainerRecap(env, 15, 3)).toBe(false); // still hour-gated
  });

  it("an invalid cadence value falls back to weekly (not daily), so a typo can't quietly fire more often", () => {
    const env = { GITTENSORY_RECAP_CADENCE: "biweekly" };
    expect(shouldFireMaintainerRecap(env, 14, 1)).toBe(true); // Monday still fires (weekly default)
    expect(shouldFireMaintainerRecap(env, 14, 2)).toBe(false); // Tuesday does not — proves it is NOT daily
  });

  it("respects a custom configured hour and day-of-week", () => {
    const env = { GITTENSORY_RECAP_CADENCE: "weekly", GITTENSORY_RECAP_HOUR: "3", GITTENSORY_RECAP_DAY: "5" };
    expect(shouldFireMaintainerRecap(env, 3, 5)).toBe(true);
    expect(shouldFireMaintainerRecap(env, 3, 1)).toBe(false); // the default Monday no longer applies
    expect(shouldFireMaintainerRecap(env, 14, 5)).toBe(false); // the default hour no longer applies
  });

  it("clamps an out-of-range (but finite) hour/day to the nearest bound", () => {
    const env = { GITTENSORY_RECAP_HOUR: "99", GITTENSORY_RECAP_DAY: "-3" };
    expect(shouldFireMaintainerRecap(env, 23, 0)).toBe(true); // 99 → 23 (MAX_HOUR), -3 → 0 (MIN_DAY_OF_WEEK)
    expect(shouldFireMaintainerRecap(env, 14, 1)).toBe(false); // the (unclamped) default no longer matches
  });

  it("falls back to the default hour/day on a non-finite value", () => {
    const env = { GITTENSORY_RECAP_HOUR: "not-a-number", GITTENSORY_RECAP_DAY: "nope" };
    expect(shouldFireMaintainerRecap(env, 14, 1)).toBe(true); // falls back to 14 / Monday
  });

  it("a present manifest override's cadence wins over the env cadence, in both directions (#2250)", () => {
    const dailyOverride = { present: true, enabled: true, cadence: "daily" } as const;
    // env says weekly, manifest says daily -> fires on a non-Monday too (hour still gates).
    expect(shouldFireMaintainerRecap({ GITTENSORY_RECAP_CADENCE: "weekly" }, 14, 3, dailyOverride)).toBe(true);
    const weeklyOverride = { present: true, enabled: true, cadence: "weekly" } as const;
    // env says daily, manifest says weekly -> does NOT fire on a non-Monday.
    expect(shouldFireMaintainerRecap({ GITTENSORY_RECAP_CADENCE: "daily" }, 14, 3, weeklyOverride)).toBe(false);
    expect(shouldFireMaintainerRecap({ GITTENSORY_RECAP_CADENCE: "daily" }, 14, 1, weeklyOverride)).toBe(true);
  });

  it("falls back to the env cadence when the manifest override is not present", () => {
    const notPresent = { present: false, enabled: false, cadence: "daily" } as const;
    expect(shouldFireMaintainerRecap({ GITTENSORY_RECAP_CADENCE: "weekly" }, 14, 3, notPresent)).toBe(false);
  });
});

describe("resolveMaintainerRecapManifestOverride — config-as-code lookup (#2250)", () => {
  it("returns the self-repo's configured maintainerRecap block when present", async () => {
    const env = createTestEnv();
    await upsertRepoFocusManifest(env, SELF_REPO, { maintainerRecap: { enabled: true, cadence: "daily", channel: "discord" } });

    expect(await resolveMaintainerRecapManifestOverride(env)).toEqual({ present: true, enabled: true, cadence: "daily" });
  });

  it("returns present: false when the self-repo has no maintainerRecap block configured", async () => {
    const env = createTestEnv();
    await upsertRepoFocusManifest(env, SELF_REPO, { wantedPaths: ["src/"] });

    expect(await resolveMaintainerRecapManifestOverride(env)).toEqual({ present: false, enabled: false, cadence: "weekly" });
  });

  it("degrades to present: false (never throws) when the manifest load itself fails", async () => {
    const env = createTestEnv();
    // loadRepoFocusManifest reads signal_snapshots (the persisted-record cache) before any live fetch fallback.
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/"signal_snapshots"|signal_snapshots/i.test(sql)) throw new Error("poisoned query");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await resolveMaintainerRecapManifestOverride(env)).toEqual({ present: false, enabled: false, cadence: "weekly" });
    expect(warnings.mock.calls.map((c) => String(c[0])).some((line) => line.includes("maintainer_recap_manifest_override_error"))).toBe(true);
  });
});

describe("runMaintainerRecapJob — cross-repo digest (#1963, #2248)", () => {
  it("aggregates gate-precision + calibration across every registered repo (none agent-configured → fallback to all) and delivers to Discord", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    await seedRegisteredRepo(env, "owner/beta");
    await seedMergedPr(env, "owner/beta", 1);
    await seedMergedPr(env, "owner/beta", 2);
    const posted = stubDiscordFetch();

    const { report, delivery } = ranRecap(await runMaintainerRecapJob(env));

    expect(delivery.discord).toEqual({ sent: true });
    expect(delivery.slack.sent).toBe(false);
    expect(report.windowDays).toBe(7); // default when omitted
    expect(report.repos.map((r) => r.repoFullName).sort()).toEqual(["owner/alpha", "owner/beta"]);
    expect(report.totals.merged).toBe(3); // 1 (alpha) + 2 (beta)
    expect(posted).toHaveLength(1);
  });

  it("threads a custom windowDays through to the report and the per-repo aggregators", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    stubDiscordFetch();

    const { report } = ranRecap(await runMaintainerRecapJob(env, 30));

    expect(report).not.toBeNull();
    expect(report!.windowDays).toBe(30);
  });

  it("prefers agent-configured repos over the full registered set when at least one is configured", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/configured");
    await seedMergedPr(env, "owner/configured", 1);
    await upsertRepositorySettings(env, { repoFullName: "owner/configured", autonomy: { merge: "auto" } });
    await seedRegisteredRepo(env, "owner/unconfigured");
    await seedMergedPr(env, "owner/unconfigured", 1);
    stubDiscordFetch();

    const { report } = ranRecap(await runMaintainerRecapJob(env));

    expect(report).not.toBeNull();
    expect(report!.repos.map((r) => r.repoFullName)).toEqual(["owner/configured"]);
  });

  it("falls back to every registered repo when settings resolution errors for every repo (a settings blip must not abort the scan)", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    await seedRegisteredRepo(env, "owner/beta");
    await seedMergedPr(env, "owner/beta", 1);
    // resolveRepositorySettings reads repository_settings; poisoning it makes every repo's lookup throw, so
    // recapScanRepos's inner catch fires for each and `configured` stays empty.
    poisonDbPrepare(env, /"repository_settings"/i);
    stubDiscordFetch();

    const { report } = ranRecap(await runMaintainerRecapJob(env));

    expect(report).not.toBeNull();
    expect(report!.repos.map((r) => r.repoFullName).sort()).toEqual(["owner/alpha", "owner/beta"]);
  });

  it("fails safe per-repo: an aggregator error is logged and the repo is skipped; the job still delivers a (zeroed) report", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    // gate-precision reads pull_requests (Drizzle, quoted table name) per repo.
    poisonDbPrepare(env, /"pull_requests"/i);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubDiscordFetch();

    const { report, delivery } = ranRecap(await runMaintainerRecapJob(env)); // resolves (never throws)

    expect(report.repos).toEqual([]);
    expect(delivery.discord).toEqual({ sent: true });
    expect(delivery.slack.sent).toBe(false);
    const logged = warnings.mock.calls.map((c) => String(c[0])).find((line) => line.includes("maintainer_recap_repo_error") && line.includes("owner/alpha"));
    expect(logged).toBeDefined();
  });

  it("still delivers a zeroed report to Discord when there are no registered repos at all", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    stubDiscordFetch();

    const { report, delivery } = ranRecap(await runMaintainerRecapJob(env));

    expect(report.repos).toEqual([]);
    expect(report.totals.gateFalsePositiveRate).toBeNull();
    expect(delivery.discord).toEqual({ sent: true });
    expect(delivery.slack.sent).toBe(false);
  });

  it("a retried tick within the SAME UTC date is a no-op: no repo scan, no second Discord post (#2249)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T14:00:00.000Z"));
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    const posted = stubDiscordFetch();

    const first = ranRecap(await runMaintainerRecapJob(env));
    vi.setSystemTime(new Date("2026-07-09T14:02:00.000Z")); // same UTC date, a couple minutes later (a retry)
    const second = await runMaintainerRecapJob(env);

    expect(first.delivery.discord).toEqual({ sent: true });
    expect(second).toEqual({ skipped: true, reason: "already_sent_this_period" });
    expect(posted).toHaveLength(1); // the retry never re-scanned repos or re-posted
    vi.useRealTimers();
  });

  it("a tick on a DIFFERENT UTC date gets its own fresh claim and sends again (#2249)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T14:00:00.000Z"));
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    const posted = stubDiscordFetch();

    const first = ranRecap(await runMaintainerRecapJob(env));
    vi.setSystemTime(new Date("2026-07-10T14:00:00.000Z")); // next day
    const second = ranRecap(await runMaintainerRecapJob(env));

    expect(first.delivery.discord).toEqual({ sent: true });
    expect(second.delivery.discord).toEqual({ sent: true });
    expect(posted).toHaveLength(2);
    vi.useRealTimers();
  });

  it("records a maintainer_recap_generated audit event with cadence/windowDays/repoCount/sectionCount/channelsAttempted metadata (#2251)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T14:00:00.000Z"));
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK, GITTENSORY_RECAP_CADENCE: "daily" });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    stubDiscordFetch();

    await runMaintainerRecapJob(env, 14);

    const row = await env.DB.prepare("select target_key, outcome, detail, metadata_json from audit_events where event_type = ? order by created_at desc limit 1")
      .bind("maintainer_recap_generated")
      .first<{ target_key: string; outcome: string; detail: string; metadata_json: string }>();
    expect(row).toMatchObject({ target_key: "maintainer-recap:2026-07-09", outcome: "success" });
    expect(row!.detail).toContain("1 repo(s)");
    const metadata = JSON.parse(row!.metadata_json);
    expect(metadata).toEqual({ cadence: "daily", windowDays: 14, repoCount: 1, sectionCount: expect.any(Number), channelsAttempted: ["discord", "slack"] });
    vi.useRealTimers();
  });

  it("a present manifest override's cadence is reflected in the maintainer_recap_generated audit metadata, not the env value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T14:00:00.000Z"));
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK, GITTENSORY_RECAP_CADENCE: "weekly" });
    stubDiscordFetch();

    await runMaintainerRecapJob(env, undefined, { present: true, enabled: true, cadence: "daily" });

    const row = await env.DB.prepare("select metadata_json from audit_events where event_type = ? order by created_at desc limit 1")
      .bind("maintainer_recap_generated")
      .first<{ metadata_json: string }>();
    expect(JSON.parse(row!.metadata_json).cadence).toBe("daily");
    vi.useRealTimers();
  });
});
