import { describe, expect, it } from "vitest";
import {
  getLatestScorePreview,
  getLatestScoringModelSnapshot,
  listPullRequestDetailSyncStates,
  listRepoSyncSegments,
  listRepoSyncStates,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("database row parser hardening", () => {
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
});
