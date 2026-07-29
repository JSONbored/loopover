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

/** A day row whose volume is entirely own-ledger (no registered-Orb fold), which is what every case below
 *  models -- so `ownMerged`/`ownClosed` mirror `merged`/`closed` and the accuracy denominator is unchanged.
 *  The Orb-fold asymmetry gets its own explicit cases further down. */
function row(day: string, merged: number, closed: number, reversed: number) {
  return { day, merged, closed, ownMerged: merged, ownClosed: closed, reversed };
}

describe("buildPublicAccuracyTrend", () => {
  it("buckets day rows into weekly totals and computes the SAME accuracy formula as the live number", () => {
    const currentMonday = isoWeekStart(NOW);
    const priorMonday = isoWeekStart(NOW - 7 * 86_400_000);
    const trend = buildPublicAccuracyTrend(
      [
        row(priorMonday, 4, 2, 1),
        row(priorMonday, 1, 0, 0), // a second day in the SAME week -- must accumulate
        row(currentMonday, 3, 3, 0),
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
    const trend = buildPublicAccuracyTrend([row(tooOld, 999, 999, 999), row(currentMonday, MIN_ACCURACY_TREND_SAMPLE, 0, 0)], NOW, 2);
    expect(trend[0]).toMatchObject({ merged: null, closed: null, reversed: null });
    expect(trend[1]).toMatchObject({ merged: MIN_ACCURACY_TREND_SAMPLE, closed: 0, reversed: 0 });
  });

  it("ignores an unparseable day string rather than throwing or corrupting a bucket", () => {
    const currentMonday = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend([row("not-a-date", 5, 5, 5), row(currentMonday, MIN_ACCURACY_TREND_SAMPLE, 0, 0)], NOW, 1);
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ merged: MIN_ACCURACY_TREND_SAMPLE, closed: 0, reversed: 0 });
  });

  it("REGRESSION: redacts counts and accuracyPct below MIN_ACCURACY_TREND_SAMPLE decided PRs", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend([row(week, MIN_ACCURACY_TREND_SAMPLE - 1, 0, 0)], NOW, 1);
    expect(trend[0]).toMatchObject({ merged: null, closed: null, reversed: null, accuracyPct: null });
  });

  it("returns a real percentage at exactly MIN_ACCURACY_TREND_SAMPLE decided PRs", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend([row(week, MIN_ACCURACY_TREND_SAMPLE, 0, 0)], NOW, 1);
    expect(trend[0]?.accuracyPct).toBe(100);
  });

  it("clamps a reversed count that exceeds decided (a reopened auto-close dropped from merged+closed) to 0%, never negative", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend([row(week, 0, MIN_ACCURACY_TREND_SAMPLE, MIN_ACCURACY_TREND_SAMPLE + 5)], NOW, 1);
    expect(trend[0]?.accuracyPct).toBe(0);
  });

  it("defaults to PUBLIC_ACCURACY_TREND_WEEKS trailing weeks when weeks is omitted", () => {
    const trend = buildPublicAccuracyTrend([], NOW);
    expect(trend).toHaveLength(PUBLIC_ACCURACY_TREND_WEEKS);
  });

  it("returns all-zero, null-accuracy buckets for an empty input (a brand-new / not-yet-enabled deployment)", () => {
    const trend = buildPublicAccuracyTrend([], NOW, 3);
    expect(trend).toHaveLength(3);
    for (const week of trend) expect(week).toMatchObject({ merged: null, closed: null, reversed: null, accuracyPct: null });
  });

  it("REGRESSION: divides reversals by the OWN-LEDGER denominator, not the Orb-folded volume", () => {
    // #7449 fixed this asymmetry for the lifetime figure and it was never carried across to the trend: the Orb
    // aggregate has no reversal concept, so folding its merged/closed into the denominator while the numerator
    // stays own-ledger-only trends every week toward 100% as more installs register.
    const week = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend(
      [{ day: week, merged: 100, closed: 0, ownMerged: 4, ownClosed: 0, reversed: 1 }],
      NOW,
      1,
    );
    // 1 - 1/4 = 75%, NOT 1 - 1/100 = 99%.
    expect(trend[0]).toEqual({ weekStart: week, merged: 100, closed: 0, reversed: 1, accuracyPct: 75 });
  });

  it("reports null accuracy — never 100% — when a reversal is not observable on this deployment", () => {
    // Regression: on a runtime that does not execute reviews, `reversed` is pinned at 0 forever, so every week
    // rendered as a perfect 100% over rising volume. The volume itself IS measured and still publishes.
    const week = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend([row(week, 40, 10, 0)], NOW, 1, false);
    expect(trend[0]).toEqual({ weekStart: week, merged: 40, closed: 10, reversed: 0, accuracyPct: null });
  });

  it("reports null accuracy when a week's volume is entirely Orb-folded (no own-ledger PRs to attribute a reversal to)", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicAccuracyTrend(
      [{ day: week, merged: 50, closed: 10, ownMerged: 0, ownClosed: 0, reversed: 0 }],
      NOW,
      1,
    );
    expect(trend[0]).toMatchObject({ merged: 50, closed: 10, reversed: 0, accuracyPct: null });
  });
});

describe("loadPublicAccuracyTrend — end-to-end over the real live tables", () => {
  it("combines own-ledger merged/closed/reversed and Orb-fleet merged/closed into a consistent weekly trend", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "JSONbored/loopover" });
    const thisMonday = isoWeekStart(NOW);
    const thisWeekIso = `${thisMonday}T09:00:00.000Z`;
    const laterInWeekIso = new Date(Date.parse(thisWeekIso) + 86_400_000).toISOString();

    // Own-ledger: PR #1 published+merged this week (no reversal).
    await upsertRepositoryFromGitHub(env, { name: "loopover", full_name: "JSONbored/loopover", private: false, owner: { login: "JSONbored" } }, 1);
    await upsertPullRequestFromGitHub(env, "JSONbored/loopover", { number: 1, title: "PR 1", state: "closed", merged_at: thisWeekIso, user: { login: "a" }, head: { sha: "s1" }, labels: [] });
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "JSONbored/loopover#1", outcome: "completed", createdAt: thisWeekIso });

    // Own-ledger: PR #2 auto-closed by the engine this week, then REVERTED (reopened by a contributor) -- must
    // count in `reversed`, bucketed by the ORIGINAL close's created_at (not the later reopen's timestamp).
    await upsertPullRequestFromGitHub(env, "JSONbored/loopover", { number: 2, title: "PR 2", state: "open", user: { login: "b" }, head: { sha: "s2" }, labels: [] });
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "JSONbored/loopover#2", outcome: "completed", createdAt: thisWeekIso });
    await recordAuditEvent(env, { eventType: "agent.action.close", targetKey: "JSONbored/loopover#2", outcome: "completed", createdAt: thisWeekIso });
    await recordAuditEvent(env, { eventType: "reversal_reopened", targetKey: "JSONbored/loopover#2", outcome: "completed", createdAt: laterInWeekIso });

    // Own-ledger: PR #3 closes WITHOUT merging (no reversal), on a DAY WITH NO PRIOR own-ledger merge -- exercises
    // the closedRows fold's `map.get(day)?.merged ?? 0` fallback branch (a day the mergedRows loop never touched),
    // distinct from the mergedRows loop above.
    await upsertPullRequestFromGitHub(env, "JSONbored/loopover", { number: 3, title: "PR 3", state: "closed", user: { login: "c" }, head: { sha: "s3" }, labels: [] });
    await env.DB.prepare("UPDATE pull_requests SET updated_at = ? WHERE repo_full_name = ? AND number = 3").bind(laterInWeekIso, "JSONbored/loopover").run();
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "JSONbored/loopover#3", outcome: "completed", createdAt: laterInWeekIso });

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

  it("REGRESSION (#fairness-analytics): a reversal recorded in a LATER week still credits the ORIGINAL decision's week", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "JSONbored/loopover" });
    const priorMonday = isoWeekStart(NOW - 7 * 86_400_000);
    const priorWeekIso = `${priorMonday}T09:00:00.000Z`;
    const thisMonday = isoWeekStart(NOW);
    const thisWeekIso = `${thisMonday}T09:00:00.000Z`;

    await upsertRepositoryFromGitHub(env, { name: "loopover", full_name: "JSONbored/loopover", private: false, owner: { login: "JSONbored" } }, 1);
    for (const n of [9, 10, 11]) {
      await upsertPullRequestFromGitHub(env, "JSONbored/loopover", { number: n, title: `merged PR ${n}`, state: "closed", merged_at: priorWeekIso, user: { login: "a" }, head: { sha: `s${n}` }, labels: [] });
      await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: `JSONbored/loopover#${n}`, outcome: "completed", createdAt: priorWeekIso });
      await recordAuditEvent(env, { eventType: "agent.action.merge", targetKey: `JSONbored/loopover#${n}`, outcome: "completed", createdAt: priorWeekIso });
    }
    // PR #9's revert PR merges (and gets recorded) THIS week -- the mistake must still credit the PRIOR week, when
    // the bad merge decision was actually made, not the week the revert surfaced.
    await recordAuditEvent(env, { eventType: "reversal_reverted", targetKey: "JSONbored/loopover#9", outcome: "completed", createdAt: thisWeekIso });

    const trend = await loadPublicAccuracyTrend(env, NOW);
    const priorWeek = trend[trend.length - 2];
    const currentWeek = trend[trend.length - 1];
    expect(priorWeek?.weekStart).toBe(priorMonday);
    expect(priorWeek?.merged).toBe(3);
    expect(priorWeek?.reversed).toBe(1);
    expect(priorWeek?.accuracyPct).toBe(66.7);
    expect(currentWeek?.reversed ?? 0).toBe(0);
  });

  it("redacts a sparse Orb-fleet week when LOOPOVER_PUBLIC_STATS_REPOS is empty (no own-ledger allowlist)", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS_REPOS: "" });
    const thisMonday = isoWeekStart(NOW);
    const thisWeekIso = `${thisMonday}T09:00:00.000Z`;
    await env.DB.prepare("INSERT INTO orb_github_installations (installation_id, registered) VALUES (?, 1)").bind(9002).run();
    await env.DB.prepare("INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .bind("other-org/other-repo", 6, 9002, "closed", thisWeekIso)
      .run();

    const trend = await loadPublicAccuracyTrend(env, NOW);
    const currentWeek = trend[trend.length - 1];
    expect(currentWeek).toMatchObject({ merged: null, closed: null, reversed: null, accuracyPct: null });
  });
});
