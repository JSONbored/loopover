import { describe, expect, it } from "vitest";
import {
  getLatestScorePreview,
  getRepoAuthorPullRequestHistory,
  getLatestScoringModelSnapshot,
  getFreshOfficialMinerDetection,
  listPullRequests,
  listPullRequestDetailSyncStates,
  listRepoSyncSegments,
  listRepoSyncStates,
  upsertOfficialMinerDetection,
  upsertPullRequestFromGitHub,
  extractLinkedIssueNumbers,
  extractLinkedIssueNumbersWithOverflow,
  MAX_LINKED_ISSUE_NUMBERS,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("database row parser hardening", () => {

  it("caps linked issues extracted from attacker-controlled PR bodies and reports overflow", () => {
    const body = Array.from({ length: MAX_LINKED_ISSUE_NUMBERS + 25 }, (_, index) => `Fixes #${index + 1}`).join("\n");

    expect(extractLinkedIssueNumbers(body)).toEqual(Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => index + 1));
    expect(extractLinkedIssueNumbersWithOverflow(body)).toEqual({
      numbers: Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => index + 1),
      overflow: true,
    });
  });

  it("deduplicates linked issues before applying the extraction cap", () => {
    const body = [`Fixes #1`, ...Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => `Resolves #${index + 1}`)].join("\n");

    expect(extractLinkedIssueNumbers(body)).toEqual(Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => index + 1));
    expect(extractLinkedIssueNumbersWithOverflow(body).overflow).toBe(false);
  });

  it("returns no linked issues when the cap is zero or negative", () => {
    expect(extractLinkedIssueNumbers("Fixes #1\nCloses #2", 0)).toEqual([]);
    expect(extractLinkedIssueNumbers("Fixes #1", -5)).toEqual([]);
  });

  it("returns empty arrays from D1 raw() when a select has no rows", async () => {
    const env = createTestEnv();
    const rows = await env.DB.prepare("select id from installations where 1 = 0").raw();
    expect(rows).toEqual([]);
  });

  it("preserves cached pull request review and mergeability scenario fields", async () => {
    const env = createTestEnv();

    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 1,
      title: "Blocked branch",
      state: "open",
      draft: true,
      mergeable: false,
      reviewDecision: "CHANGES_REQUESTED",
      user: { login: "oktofeesh1" },
      labels: [{ name: "bug" }],
      body: "Fixes #7",
    });
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 2,
      title: "Mergeable branch",
      state: "open",
      isDraft: false,
      mergeable: true,
      reviewDecision: "APPROVED",
      user: { login: "oktofeesh1" },
      labels: [],
      body: null,
    });

    await expect(listPullRequests(env, "owner/repo")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: 1, isDraft: true, mergeableState: "blocked", reviewDecision: "CHANGES_REQUESTED", linkedIssues: [7] }),
        expect.objectContaining({ number: 2, isDraft: false, mergeableState: "mergeable", reviewDecision: "APPROVED" }),
      ]),
    );
  });

  it("computes complete case-insensitive repo author PR history for gate grace", async () => {
    const env = createTestEnv();

    for (let number = 1; number <= 503; number += 1) {
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number,
        title: `PR ${number}`,
        state: number <= 3 ? "closed" : "open",
        user: { login: number <= 3 ? "RepeatUser" : `other-${number}` },
        labels: [],
      });
    }
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 600,
      title: "Merged work",
      state: "closed",
      merged_at: "2025-01-01T00:00:00.000Z",
      user: { login: "RepeatUser" },
      labels: [],
    });

    await expect(getRepoAuthorPullRequestHistory(env, "owner/repo", "repeatuser", 999)).resolves.toEqual({
      mergedPrCount: 1,
      closedUnmergedPrCount: 3,
    });
    await expect(getRepoAuthorPullRequestHistory(env, "owner/repo", "repeatuser", 600)).resolves.toEqual({
      mergedPrCount: 0,
      closedUnmergedPrCount: 3,
    });
  });

  it("normalizes enum-like database values from stored sync, scoring, and preview rows", async () => {
    const env = createTestEnv();

    for (const [repo, status, source] of [
      ["owner/skipped", "skipped", "installation"],
      ["owner/capped", "capped", "test"],
      ["owner/rate", "rate_limited", "unknown-source"],
      ["owner/stale", "stale", "github"],
      ["owner/bad", "not-a-real-status", "bad-source"],
    ]) {
      await env.DB.prepare(
        `insert into repo_sync_state (
          repo_full_name, status, source_kind, open_issues_count, open_pull_requests_count,
          recent_merged_pull_requests_count, warnings_json
        ) values (?, ?, ?, 0, 0, 0, '[]')`,
      )
        .bind(repo, status, source)
        .run();
    }

    for (const [segment, status, mode] of [
      ["recent_merged_pull_requests", "sampled", "full"],
      ["pull_request_files", "waiting_rate_limit", "resume"],
      ["pull_request_reviews", "error", "bad-mode"],
      ["check_summaries", "not_modified", "light"],
      ["bad-segment", "bad-status", "bad-mode"],
    ]) {
      await env.DB.prepare(
        `insert into repo_sync_segments (
          id, repo_full_name, segment, status, source_kind, mode, fetched_count, page_count, warnings_json
        ) values (?, 'owner/repo', ?, ?, 'github', ?, 0, 0, '[]')`,
      )
        .bind(`segment-${segment}-${status}`, segment, status, mode)
        .run();
    }

    for (const [pullNumber, status] of [
      [1, "waiting_rate_limit"],
      [2, "error"],
      [3, "bad-status"],
    ] as const) {
      await env.DB.prepare(
        `insert into pull_request_detail_sync_state (
          id, repo_full_name, pull_number, status
        ) values (?, 'owner/repo', ?, ?)`,
      )
        .bind(`detail-${pullNumber}`, pullNumber, status)
        .run();
    }

    await env.DB.prepare(
      `insert into scoring_model_snapshots (
        id, source_kind, source_url, fetched_at, active_model, constants_json,
        programming_languages_json, warnings_json, payload_json
      ) values ('score-model', 'bad-source', 'fixture://model', '2026-05-25T00:00:00.000Z', 'bad-model', '{}', '{}', '[]', '{}')`,
    ).run();

    for (const [targetType, generatedAt] of [
      ["pull_request", "2026-05-25T00:00:01.000Z"],
      ["local_diff", "2026-05-25T00:00:02.000Z"],
      ["variant", "2026-05-25T00:00:03.000Z"],
      ["bad-target", "2026-05-25T00:00:04.000Z"],
    ]) {
      await env.DB.prepare(
        `insert into score_previews (
          id, scoring_model_snapshot_id, repo_full_name, target_type, target_key,
          input_json, result_json, generated_at
        ) values (?, 'score-model', 'owner/repo', ?, ?, '{}', '{}', ?)`,
      )
        .bind(`preview-${targetType}`, targetType, `target-${targetType}`, generatedAt)
        .run();
    }

    expect(await listRepoSyncStates(env)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoFullName: "owner/skipped", status: "skipped", sourceKind: "installation" }),
        expect.objectContaining({ repoFullName: "owner/capped", status: "capped", sourceKind: "test" }),
        expect.objectContaining({ repoFullName: "owner/rate", status: "rate_limited", sourceKind: "github" }),
        expect.objectContaining({ repoFullName: "owner/stale", status: "stale" }),
        expect.objectContaining({ repoFullName: "owner/bad", status: "never_synced", sourceKind: "github" }),
      ]),
    );
    expect(await listRepoSyncSegments(env, "owner/repo")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ segment: "recent_merged_pull_requests", status: "sampled", mode: "full" }),
        expect.objectContaining({ segment: "pull_request_files", status: "waiting_rate_limit", mode: "resume" }),
        expect.objectContaining({ segment: "pull_request_reviews", status: "error", mode: "light" }),
        expect.objectContaining({ segment: "check_summaries", status: "not_modified" }),
        expect.objectContaining({ segment: "metadata", status: "never_synced", mode: "light" }),
      ]),
    );
    expect(await listPullRequestDetailSyncStates(env, "owner/repo")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pullNumber: 1, status: "waiting_rate_limit" }),
        expect.objectContaining({ pullNumber: 2, status: "error" }),
        expect.objectContaining({ pullNumber: 3, status: "never_synced" }),
      ]),
    );
    expect(await getLatestScoringModelSnapshot(env)).toMatchObject({ sourceKind: "fallback", activeModel: "unknown" });
    await expect(getLatestScorePreview(env, "owner/repo", "target-pull_request")).resolves.toMatchObject({ targetType: "pull_request" });
    await expect(getLatestScorePreview(env, "owner/repo", "target-local_diff")).resolves.toMatchObject({ targetType: "local_diff" });
    await expect(getLatestScorePreview(env, "owner/repo", "target-variant")).resolves.toMatchObject({ targetType: "variant" });
    await expect(getLatestScorePreview(env, "owner/repo", "target-bad-target")).resolves.toMatchObject({ targetType: "planned_pr" });
    await expect(getLatestScorePreview(env, "owner/repo", "missing")).resolves.toBeNull();
  });

  it("fails closed for malformed or incomplete cached official miner detections", async () => {
    const env = createTestEnv();
    for (const [login, status, snapshotJson, error] of [
      ["broken", "confirmed", "{}", null],
      ["outage", "unavailable", "{}", null],
    ]) {
      await env.DB.prepare(
        `insert into official_miner_detections (
          login, status, snapshot_json, error, fetched_at, expires_at, updated_at
        ) values (?, ?, ?, ?, '2026-05-29T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-05-29T00:00:00.000Z')`,
      )
        .bind(login, status, snapshotJson, error)
        .run();
    }

    await expect(getFreshOfficialMinerDetection(env, "missing")).resolves.toBeNull();
    await expect(getFreshOfficialMinerDetection(env, "broken")).resolves.toEqual({ status: "unavailable", error: "cached Gittensor miner snapshot is invalid" });
    await expect(getFreshOfficialMinerDetection(env, "outage")).resolves.toEqual({ status: "unavailable", error: "cached Gittensor API unavailable" });
  });

  it("allowlists cached official miner snapshot fields", async () => {
    const env = createTestEnv();
    await upsertOfficialMinerDetection(
      env,
      "oktofeesh1",
      {
        status: "confirmed",
        snapshot: {
          source: "gittensor_api",
          githubId: "123",
          githubUsername: "oktofeesh1",
          uid: 7,
          hotkey: "must-not-cache",
          wallet: "must-not-cache",
          coldkey: "must-not-cache",
          failedReason: "needs more history",
          evaluatedAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:01:00.000Z",
          isEligible: true,
          credibility: 1,
          eligibleRepoCount: 1,
          issueDiscoveryScore: 0,
          issueTokenScore: 0,
          issueCredibility: 1,
          isIssueEligible: false,
          issueEligibleRepoCount: 0,
          alphaPerDay: 0,
          taoPerDay: 0,
          usdPerDay: 0,
          totals: {
            pullRequests: 1,
            mergedPullRequests: 1,
            openPullRequests: 0,
            closedPullRequests: 0,
            openIssues: 0,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
          },
          repositories: [
            {
              repoFullName: "JSONbored/gittensory",
              pullRequests: 1,
              mergedPullRequests: 1,
              openPullRequests: 0,
              closedPullRequests: 0,
              openIssues: 0,
              closedIssues: 0,
              solvedIssues: 0,
              validSolvedIssues: 0,
              isEligible: true,
              isIssueEligible: false,
              credibility: 1,
              issueCredibility: 1,
              totalScore: 0,
              baseTotalScore: 0,
              hotkey: "must-not-cache",
            },
            { wallet: "must-not-cache" },
          ],
          pullRequests: [
            {
              repoFullName: "JSONbored/gittensory",
              number: 1,
              title: "Fix cache",
              state: "open",
              mergedAt: "2026-05-29T00:00:00.000Z",
              label: "bug",
              score: 0,
              baseScore: 0,
              tokenScore: 0,
              wallet: "must-not-cache",
            },
            { hotkey: "must-not-cache" },
          ],
          issueLabels: ["bug"],
        } as never,
      },
      60_000,
      Date.parse("2026-05-29T00:00:00.000Z"),
    );

    const raw = await env.DB.prepare("select snapshot_json from official_miner_detections where login = ?").bind("oktofeesh1").first<{ snapshot_json: string }>();
    expect(raw?.snapshot_json).not.toMatch(/hotkey|coldkey|wallet|must-not-cache/i);
    const cached = await getFreshOfficialMinerDetection(env, "oktofeesh1", "2026-05-29T00:00:30.000Z");
    expect(JSON.stringify(cached)).not.toMatch(/hotkey|coldkey|wallet|must-not-cache/i);
    expect(cached).toMatchObject({ status: "confirmed", snapshot: { githubId: "123", githubUsername: "oktofeesh1", uid: 7 } });
  });

  it("normalizes sparse cached official miner snapshots without preserving unknown fields", async () => {
    const env = createTestEnv();
    await upsertOfficialMinerDetection(
      env,
      "minimal",
      {
        status: "confirmed",
        snapshot: {
          source: "gittensor_api",
          githubId: "456",
          githubUsername: "minimal",
          uid: "not-a-number",
          failedReason: null,
          evaluatedAt: 123,
          updatedAt: 123,
          totals: null,
          repositories: "not-an-array",
          pullRequests: "not-an-array",
          issueLabels: ["bug", 7],
          wallet: "must-not-cache",
          hotkey: "must-not-cache",
        } as never,
      },
      60_000,
      Date.parse("2026-05-29T00:00:00.000Z"),
    );

    const cached = await getFreshOfficialMinerDetection(env, "minimal", "2026-05-29T00:00:30.000Z");
    expect(JSON.stringify(cached)).not.toMatch(/hotkey|coldkey|wallet|must-not-cache/i);
    expect(cached).toMatchObject({
      status: "confirmed",
      snapshot: {
        githubId: "456",
        githubUsername: "minimal",
        uid: undefined,
        failedReason: null,
        evaluatedAt: undefined,
        updatedAt: undefined,
        totals: {
          pullRequests: 0,
          mergedPullRequests: 0,
          openPullRequests: 0,
          closedPullRequests: 0,
          openIssues: 0,
          closedIssues: 0,
          solvedIssues: 0,
          validSolvedIssues: 0,
        },
        repositories: [],
        pullRequests: [],
        issueLabels: [],
      },
    });
  });

  it("stores only bounded official miner identity and totals in the cache", async () => {
    const env = createTestEnv();
    await upsertOfficialMinerDetection(
      env,
      "oversized",
      {
        status: "confirmed",
        snapshot: {
          source: "gittensor_api",
          githubId: "7".repeat(200),
          githubUsername: "u".repeat(200),
          failedReason: "f".repeat(600),
          evaluatedAt: "e".repeat(100),
          updatedAt: "u".repeat(100),
          totals: {
            pullRequests: 123,
            mergedPullRequests: 45,
            openPullRequests: 6,
            closedPullRequests: 7,
            openIssues: 8,
            closedIssues: 9,
            solvedIssues: 10,
            validSolvedIssues: 11,
          },
          repositories: Array.from({ length: 200 }, (_, index) => ({ repoFullName: `owner/repo-${index}` })),
          pullRequests: Array.from({ length: 200 }, (_, index) => ({ repoFullName: "owner/repo", number: index, title: "t".repeat(1000) })),
          issueLabels: Array.from({ length: 200 }, (_, index) => `label-${index}`),
        } as never,
      },
      60_000,
      Date.parse("2026-05-29T00:00:00.000Z"),
    );

    const raw = await env.DB.prepare("select snapshot_json from official_miner_detections where login = ?").bind("oversized").first<{ snapshot_json: string }>();
    const cachedSnapshot = JSON.parse(raw?.snapshot_json ?? "{}");

    expect(cachedSnapshot.githubId).toHaveLength(128);
    expect(cachedSnapshot.githubUsername).toHaveLength(128);
    expect(cachedSnapshot.failedReason).toHaveLength(512);
    expect(cachedSnapshot.evaluatedAt).toHaveLength(64);
    expect(cachedSnapshot.updatedAt).toHaveLength(64);
    expect(cachedSnapshot.totals).toMatchObject({ pullRequests: 123, mergedPullRequests: 45, openIssues: 8 });
    expect(cachedSnapshot.repositories).toEqual([]);
    expect(cachedSnapshot.pullRequests).toEqual([]);
    expect(cachedSnapshot.issueLabels).toEqual([]);
    expect(raw?.snapshot_json).not.toContain("owner/repo");
    expect(raw?.snapshot_json).not.toContain("label-199");
  });

  it("drops unknown fields even when cached miner identity fields are missing", async () => {
    const env = createTestEnv();
    await upsertOfficialMinerDetection(
      env,
      "anonymous",
      {
        status: "confirmed",
        snapshot: {
          source: "gittensor_api",
          wallet: "must-not-cache",
          coldkey: "must-not-cache",
          hotkey: "must-not-cache",
          issueLabels: "not-an-array",
        } as never,
      },
      60_000,
      Date.parse("2026-05-29T00:00:00.000Z"),
    );

    const raw = await env.DB.prepare("select snapshot_json from official_miner_detections where login = ?").bind("anonymous").first<{ snapshot_json: string }>();
    expect(raw?.snapshot_json).not.toMatch(/hotkey|coldkey|wallet|must-not-cache/i);
    expect(JSON.parse(raw?.snapshot_json ?? "{}")).toMatchObject({ githubId: "", githubUsername: "", issueLabels: [] });
  });
});
