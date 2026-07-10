import { describe, expect, it } from "vitest";
import {
  MIN_ACCURACY_TREND_SAMPLE,
  PUBLIC_ACCURACY_TREND_WEEKS,
  buildPublicAccuracyTrend,
  loadPublicAccuracyTrend,
} from "../../src/services/public-accuracy-trend";
import { isoWeekStart } from "../../src/services/public-quality-metrics";
import { recordAuditEvent, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const NOW = Date.parse("2026-06-22T12:00:00.000Z");

describe("buildPublicAccuracyTrend", () => {
  it("buckets day rows into weekly totals and computes the SAME accuracy formula as the live number", () => {
    const currentMonday = isoWeekStart(NOW);
    const priorMonday = isoWeekStart(NOW - 7 * 86_400_000);
    const trend = buildPublicAccuracyTrend(
      [
        { day: priorMonday, merged: 4, closed: 2, reversed: 1 },
        { day: priorMonday, merged: 1, closed: 0, reversed: 0 }, // a second day in the SAME week -- must accumulate
        { day: currentMonday, merged: 3, closed: 3, reversed: 0 },
      ],
      NOW,
      2,
    );
    expect(trend).toHaveLength(2);
    expect(trend[0]).toEqual({
      weekStart: priorMonday,
      merged: 5,
      closed: 2,
      reversed: 1,
      // 1 - 1/(5+2) = 85.7%
      accuracyPct: 85.7,
    });
    expect(trend[1]).toEqual({
      weekStart: currentMonday,
      merged: 3,
      closed: 3,
      reversed: 0,
      accuracyPct: 100,
    });
  });

  it("REGRESSION: ignores day rows outside the trailing window instead of letting them corrupt the oldest bucket", () => {
    const currentMonday = isoWeekStart(NOW);
    const tooOld = isoWeekStart(NOW - 30 * 86_400_000);
    const trend = buildPublicAccuracyTrend([{ day: tooOld, merged: 999, closed: 999, reversed: 999 }, { day: currentMonday, merged: 1, closed: 0, reversed: 0 }], NOW, 2);
    expect(trend[0]).toMatchObject({ merged: 0, closed: 0, reversed: 0 });
    expect(trend[1]).toMatchObject({ merged: 1, closed: 0, reversed: 0 });
  });

  it("ignores an unparseable day string rather than throwing or corrupting a bucket", () => {
    const currentMonday = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend([{ day: "not-a-date", merged: 5, closed: 5, reversed: 5 }, { day: currentMonday, merged: 1, closed: 0, reversed: 0 }], NOW, 1);
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ merged: 1, closed: 0, reversed: 0 });
  });

  it("returns null accuracyPct (not a misleading 0% or 100%) below MIN_ACCURACY_TREND_SAMPLE decided PRs", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend([{ day: week, merged: MIN_ACCURACY_TREND_SAMPLE - 1, closed: 0, reversed: 0 }], NOW, 1);
    expect(trend[0]?.accuracyPct).toBeNull();
  });

  it("returns a real percentage at exactly MIN_ACCURACY_TREND_SAMPLE decided PRs", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend([{ day: week, merged: MIN_ACCURACY_TREND_SAMPLE, closed: 0, reversed: 0 }], NOW, 1);
    expect(trend[0]?.accuracyPct).toBe(100);
  });

  it("clamps a reversed count that exceeds decided (a reopened auto-close dropped from merged+closed) to 0%, never negative", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend([{ day: week, merged: 0, closed: MIN_ACCURACY_TREND_SAMPLE, reversed: MIN_ACCURACY_TREND_SAMPLE + 5 }], NOW, 1);
    expect(trend[0]?.accuracyPct).toBe(0);
  });

  it("defaults to PUBLIC_ACCURACY_TREND_WEEKS trailing weeks when weeks is omitted", () => {
    const trend = buildPublicAccuracyTrend([], NOW);
    expect(trend).toHaveLength(PUBLIC_ACCURACY_TREND_WEEKS);
  });

  it("returns all-zero, null-accuracy buckets for an empty input (a brand-new / not-yet-enabled deployment)", () => {
    const trend = buildPublicAccuracyTrend([], NOW, 3);
    expect(trend).toHaveLength(3);
    for (const week of trend) expect(week).toMatchObject({ merged: 0, closed: 0, reversed: 0, accuracyPct: null });
  });
});

describe("loadPublicAccuracyTrend — end-to-end over the real live tables", () => {
  it("combines own-ledger merged/closed/reversed and Orb-fleet merged/closed into a consistent weekly trend", async () => {
    const env = createTestEnv({ GITTENSORY_PUBLIC_STATS_REPOS: "JSONbored/gittensory" });
    const thisMonday = isoWeekStart(NOW);
    const thisWeekIso = `${thisMonday}T09:00:00.000Z`;
    const laterInWeekIso = new Date(Date.parse(thisWeekIso) + 86_400_000).toISOString();

    // Own-ledger: PR #1 published+merged this week (no reversal).
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 1);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 1, title: "PR 1", state: "closed", merged_at: thisWeekIso, user: { login: "a" }, head: { sha: "s1" }, labels: [] });
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "JSONbored/gittensory#1", outcome: "completed", createdAt: thisWeekIso });

    // Own-ledger: PR #2 auto-closed by the engine this week, then REVERTED (reopened) -- must count in `reversed`.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 2, title: "PR 2", state: "open", user: { login: "b" }, head: { sha: "s2" }, labels: [] });
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "JSONbored/gittensory#2", outcome: "completed", createdAt: thisWeekIso });
    await recordAuditEvent(env, { eventType: "agent.action.close", targetKey: "JSONbored/gittensory#2", outcome: "completed", createdAt: thisWeekIso });

    // Own-ledger: PR #3 closes WITHOUT merging (no reversal), on a DAY WITH NO PRIOR own-ledger merge -- exercises
    // the closedRows fold's `map.get(day)?.merged ?? 0` fallback branch (a day the mergedRows loop never touched),
    // distinct from the mergedRows loop above.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 3, title: "PR 3", state: "closed", user: { login: "c" }, head: { sha: "s3" }, labels: [] });
    await env.DB.prepare("UPDATE pull_requests SET updated_at = ? WHERE repo_full_name = ? AND number = 3").bind(laterInWeekIso, "JSONbored/gittensory").run();
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "JSONbored/gittensory#3", outcome: "completed", createdAt: laterInWeekIso });

    // Orb fleet: a registered installation with a merge on the SAME later day as PR #3's close -- so the
    // own-ledger and Orb day-maps each have a day the OTHER source has no entry for at all (exercises both
    // directions of the ownLedger/orb `?? 0` fallback in loadPublicAccuracyTrend's day-merge step, not just the
    // "both sources active on the same day" case already covered by the shared thisWeekIso above).
    await env.DB.prepare("INSERT INTO orb_github_installations (installation_id, registered) VALUES (?, 1)").bind(9001).run();
    await env.DB.prepare("INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .bind("other-org/other-repo", 5, 9001, "merged", laterInWeekIso)
      .run();

    const trend = await loadPublicAccuracyTrend(env, NOW);
    const currentWeek = trend[trend.length - 1];
    expect(currentWeek?.weekStart).toBe(thisMonday);
    // merged: own-ledger PR#1 (1) + orb PR#5 (1, a different day) = 2. closed: own-ledger PR#3 (1). PR#2 stays
    // open (not merged/closed) but its close-then-reopen still counts toward reversed.
    expect(currentWeek?.merged).toBe(2);
    expect(currentWeek?.closed).toBe(1);
    expect(currentWeek?.reversed).toBe(1);
  });

  it("still reports the Orb-fleet side when GITTENSORY_PUBLIC_STATS_REPOS is empty (no own-ledger allowlist)", async () => {
    const env = createTestEnv({ GITTENSORY_PUBLIC_STATS_REPOS: "" });
    const thisMonday = isoWeekStart(NOW);
    const thisWeekIso = `${thisMonday}T09:00:00.000Z`;
    await env.DB.prepare("INSERT INTO orb_github_installations (installation_id, registered) VALUES (?, 1)").bind(9002).run();
    await env.DB.prepare("INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .bind("other-org/other-repo", 6, 9002, "closed", thisWeekIso)
      .run();

    const trend = await loadPublicAccuracyTrend(env, NOW);
    const currentWeek = trend[trend.length - 1];
    expect(currentWeek?.closed).toBe(1);
    expect(currentWeek?.merged).toBe(0);
    expect(currentWeek?.reversed).toBe(0);
  });
});
