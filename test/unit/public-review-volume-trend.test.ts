import { describe, expect, it } from "vitest";
import {
  MIN_REVIEW_VOLUME_TREND_SAMPLE,
  PUBLIC_REVIEW_VOLUME_TREND_WEEKS,
  buildPublicReviewVolumeTrend,
  loadPublicReviewVolumeTrend,
} from "../../src/services/public-review-volume-trend";
import { isoWeekStart } from "../../src/services/public-quality-metrics";
import { recordAuditEvent, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const NOW = Date.parse("2026-06-22T12:00:00.000Z");

describe("buildPublicReviewVolumeTrend", () => {
  it("buckets day rows into weekly totals and computes the SAME filteredPct formula as the live number", () => {
    const currentMonday = isoWeekStart(NOW);
    const priorMonday = isoWeekStart(NOW - 7 * 86_400_000);
    const trend = buildPublicReviewVolumeTrend(
      [
        { day: priorMonday, reviewed: 4, merged: 2 },
        { day: priorMonday, reviewed: 1, merged: 1 }, // a second day in the SAME week -- must accumulate
        { day: currentMonday, reviewed: 3, merged: 3 },
      ],
      NOW,
      2,
    );
    expect(trend).toHaveLength(2);
    expect(trend[0]).toEqual({
      weekStart: priorMonday,
      reviewed: 5,
      merged: 3,
      // (5 - 3) / 5 = 40%
      filteredPct: 40,
    });
    expect(trend[1]).toEqual({
      weekStart: currentMonday,
      reviewed: 3,
      merged: 3,
      filteredPct: 0,
    });
  });

  it("REGRESSION: ignores day rows outside the trailing window instead of letting them corrupt the oldest bucket", () => {
    const currentMonday = isoWeekStart(NOW);
    const tooOld = isoWeekStart(NOW - 30 * 86_400_000);
    const trend = buildPublicReviewVolumeTrend([{ day: tooOld, reviewed: 999, merged: 999 }, { day: currentMonday, reviewed: 1, merged: 0 }], NOW, 2);
    expect(trend[0]).toMatchObject({ reviewed: 0, merged: 0 });
    expect(trend[1]).toMatchObject({ reviewed: 1, merged: 0 });
  });

  it("ignores an unparseable day string rather than throwing or corrupting a bucket", () => {
    const currentMonday = isoWeekStart(NOW);
    const trend = buildPublicReviewVolumeTrend([{ day: "not-a-date", reviewed: 5, merged: 5 }, { day: currentMonday, reviewed: 1, merged: 0 }], NOW, 1);
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ reviewed: 1, merged: 0 });
  });

  it("returns null filteredPct (not a misleading 0%) below MIN_REVIEW_VOLUME_TREND_SAMPLE reviewed PRs, but still reports the raw reviewed count", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicReviewVolumeTrend([{ day: week, reviewed: MIN_REVIEW_VOLUME_TREND_SAMPLE - 1, merged: 0 }], NOW, 1);
    expect(trend[0]?.filteredPct).toBeNull();
    expect(trend[0]?.reviewed).toBe(MIN_REVIEW_VOLUME_TREND_SAMPLE - 1);
  });

  it("returns a real percentage at exactly MIN_REVIEW_VOLUME_TREND_SAMPLE reviewed PRs", () => {
    const week = isoWeekStart(NOW);
    const trend = buildPublicReviewVolumeTrend([{ day: week, reviewed: MIN_REVIEW_VOLUME_TREND_SAMPLE, merged: 0 }], NOW, 1);
    expect(trend[0]?.filteredPct).toBe(100);
  });

  it("defaults to PUBLIC_REVIEW_VOLUME_TREND_WEEKS trailing weeks when weeks is omitted", () => {
    const trend = buildPublicReviewVolumeTrend([], NOW);
    expect(trend).toHaveLength(PUBLIC_REVIEW_VOLUME_TREND_WEEKS);
  });

  it("returns all-zero, null-filteredPct buckets for an empty input (a brand-new / not-yet-enabled deployment)", () => {
    const trend = buildPublicReviewVolumeTrend([], NOW, 3);
    expect(trend).toHaveLength(3);
    for (const week of trend) expect(week).toMatchObject({ reviewed: 0, merged: 0, filteredPct: null });
  });
});

describe("loadPublicReviewVolumeTrend — end-to-end over the real live tables", () => {
  it("credits a PR's week by its FIRST-PUBLISHED day, not its (possibly later) merge day, and folds in the Orb fleet", async () => {
    const env = createTestEnv({ GITTENSORY_PUBLIC_STATS_REPOS: "JSONbored/gittensory" });
    const thisMonday = isoWeekStart(NOW);
    const thisWeekIso = `${thisMonday}T09:00:00.000Z`;
    const laterInWeekIso = new Date(Date.parse(thisWeekIso) + 86_400_000).toISOString();
    const priorMonday = isoWeekStart(NOW - 7 * 86_400_000);
    const priorWeekIso = `${priorMonday}T09:00:00.000Z`;

    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 1);

    // PR #1: published LAST week, merged THIS week -- must credit `reviewed`/`merged` to LAST week's cohort
    // (its publish day), not to the week it actually merged in.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 1, title: "PR 1", state: "closed", merged_at: thisWeekIso, user: { login: "a" }, head: { sha: "s1" }, labels: [] });
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "JSONbored/gittensory#1", outcome: "completed", createdAt: priorWeekIso });

    // PR #2: published and closed (no merge) THIS week -- a genuinely filtered PR in THIS week's own cohort, on
    // a day with no prior own-ledger publish (exercises the day-map's `?? 0` fallback branch for a fresh day).
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 2, title: "PR 2", state: "closed", user: { login: "b" }, head: { sha: "s2" }, labels: [] });
    await env.DB.prepare("UPDATE pull_requests SET updated_at = ? WHERE repo_full_name = ? AND number = 2").bind(laterInWeekIso, "JSONbored/gittensory").run();
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "JSONbored/gittensory#2", outcome: "completed", createdAt: laterInWeekIso });

    // Orb fleet: a registered installation with a merge on the SAME later day as PR #2 -- own-ledger and Orb
    // day-maps each have a day the OTHER source has no entry for (exercises both directions of the ownLedger/
    // orb `?? 0` fallback), and Orb's own "reviewed" (merged+closed) must fold into the week total too.
    await env.DB.prepare("INSERT INTO orb_github_installations (installation_id, registered) VALUES (?, 1)").bind(9101).run();
    await env.DB.prepare("INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .bind("other-org/other-repo", 7, 9101, "merged", laterInWeekIso)
      .run();

    const trend = await loadPublicReviewVolumeTrend(env, NOW);
    const priorWeek = trend[trend.length - 2];
    const currentWeek = trend[trend.length - 1];

    // PR #1's publish credits LAST week's cohort with reviewed=1, merged=1 (its later merge still counts,
    // since merged reflects CURRENT disposition, not the merge's own day).
    expect(priorWeek?.weekStart).toBe(priorMonday);
    expect(priorWeek?.reviewed).toBe(1);
    expect(priorWeek?.merged).toBe(1);

    // THIS week: own-ledger PR #2 (reviewed, not merged) + Orb PR #7 (reviewed AND merged) = reviewed 2, merged 1.
    expect(currentWeek?.weekStart).toBe(thisMonday);
    expect(currentWeek?.reviewed).toBe(2);
    expect(currentWeek?.merged).toBe(1);
  });

  it("REGRESSION (#4723): a PR re-published inside the window still resolves to its TRUE (out-of-window) first-publish date, not the recent re-publish", async () => {
    // The whole point of the two-step recent_keys -> true_first_seen query (#4723): step 1 finds this PR as a
    // CANDIDATE purely because it has a recent publish event, but step 2 must still discover its true,
    // much-older first-publish date across its FULL history -- and once found, that date is outside the
    // trend's own window, so the PR must be excluded entirely, not misattributed to the recent event's week.
    // A naive single-pass query that filtered raw events by `created_at >= sinceIso` BEFORE taking MIN() would
    // get this wrong: it would see only the recent event and wrongly count the PR in the current week.
    const env = createTestEnv({ GITTENSORY_PUBLIC_STATS_REPOS: "JSONbored/gittensory" });
    const thisMonday = isoWeekStart(NOW);
    const thisWeekIso = `${thisMonday}T09:00:00.000Z`;
    // 20 weeks ago: well outside the 8-week trend window, but still a real, storable timestamp.
    const longAgoIso = new Date(Date.parse(thisWeekIso) - 20 * 7 * 86_400_000).toISOString();

    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 1);
    // Still open today (a long-lived PR that keeps getting re-reviewed) -- not merged, not closed.
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", { number: 9, title: "PR 9", state: "open", user: { login: "a" }, head: { sha: "s9" }, labels: [] });
    // Its TRUE first publish, 20 weeks ago -- outside the trend window on its own.
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "JSONbored/gittensory#9", outcome: "completed", createdAt: longAgoIso });
    // A legitimate re-publish THIS week (e.g. a fresh push triggered another review pass).
    await recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", targetKey: "JSONbored/gittensory#9", outcome: "completed", createdAt: thisWeekIso });

    const trend = await loadPublicReviewVolumeTrend(env, NOW);
    const currentWeek = trend[trend.length - 1];

    // PR #9 must NOT be counted anywhere in the trend -- its true first-publish is outside the window.
    expect(currentWeek?.reviewed).toBe(0);
    expect(trend.every((week) => week.reviewed === 0)).toBe(true);
  });

  it("still reports the Orb-fleet side when GITTENSORY_PUBLIC_STATS_REPOS is empty (no own-ledger allowlist)", async () => {
    const env = createTestEnv({ GITTENSORY_PUBLIC_STATS_REPOS: "" });
    const thisMonday = isoWeekStart(NOW);
    const thisWeekIso = `${thisMonday}T09:00:00.000Z`;
    await env.DB.prepare("INSERT INTO orb_github_installations (installation_id, registered) VALUES (?, 1)").bind(9102).run();
    await env.DB.prepare("INSERT INTO orb_pr_outcomes (repository_full_name, pr_number, installation_id, outcome, occurred_at) VALUES (?, ?, ?, ?, ?)")
      .bind("other-org/other-repo", 8, 9102, "closed", thisWeekIso)
      .run();

    const trend = await loadPublicReviewVolumeTrend(env, NOW);
    const currentWeek = trend[trend.length - 1];
    expect(currentWeek?.reviewed).toBe(1);
    expect(currentWeek?.merged).toBe(0);
  });
});
