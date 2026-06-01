import { describe, expect, it } from "vitest";
import {
  getAgentCommandAnswer,
  getCommandUsefulnessSummary,
  recordAgentCommandFeedback,
  upsertAgentCommandAnswer,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("command usefulness feedback storage", () => {
  it("deduplicates actor feedback by answer and stores only actor hashes", async () => {
    const env = createTestEnv();
    await upsertAgentCommandAnswer(env, answer({ id: "answer-preflight", command: "preflight" }));

    await recordAgentCommandFeedback(env, {
      id: "feedback-initial",
      answerId: "answer-preflight",
      repoFullName: "JSONbored/gittensory",
      issueNumber: 77,
      command: "preflight",
      actorLogin: "Oktofeesh1",
      vote: "useful",
      source: "github_reaction",
      actorKind: "author",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
      metadata: { deliveryId: "delivery-1" },
    });
    await recordAgentCommandFeedback(env, {
      answerId: "answer-preflight",
      repoFullName: "JSONbored/gittensory",
      issueNumber: 77,
      command: "preflight",
      actorLogin: "oktofeesh1",
      vote: "not_useful",
      source: "github_reaction",
      actorKind: "author",
      updatedAt: "2026-05-28T00:05:00.000Z",
      metadata: { deliveryId: "delivery-2" },
    });
    await recordAgentCommandFeedback(env, {
      answerId: "answer-preflight",
      repoFullName: "JSONbored/gittensory",
      issueNumber: 77,
      command: "preflight",
      actorLogin: "maintainer",
      vote: "useful",
      source: "app",
      actorKind: "maintainer",
      updatedAt: "2026-05-28T00:06:00.000Z",
      metadata: { surface: "app" },
    });

    const rows = await env.DB.prepare("select actor_hash, vote, source, actor_kind, metadata_json from github_agent_command_feedback order by updated_at")
      .all<{ actor_hash: string; vote: string; source: string; actor_kind: string; metadata_json: string }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.map((row) => row.vote).sort()).toEqual(["not_useful", "useful"]);
    expect(rows.results.every((row) => row.actor_hash.startsWith("sha256:"))).toBe(true);
    expect(rows.results.map((row) => row.actor_hash).join("\n")).not.toMatch(/Oktofeesh1|oktofeesh1|maintainer/);
    expect(rows.results.find((row) => row.vote === "not_useful")).toMatchObject({
      source: "github_reaction",
      actor_kind: "author",
    });

    const summary = await getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 30 });
    expect(summary.totals).toMatchObject({
      feedbackCount: 2,
      usefulCount: 1,
      notUsefulCount: 1,
      answerCount: 1,
      usefulnessRate: 0.5,
    });
    expect(summary.commands).toEqual([
      expect.objectContaining({
        command: "preflight",
        feedbackCount: 2,
        usefulCount: 1,
        notUsefulCount: 1,
        answerCount: 1,
        usefulnessRate: 0.5,
      }),
    ]);
  });

  it("upserts answer metadata and filters usefulness windows deterministically", async () => {
    const env = createTestEnv();
    await upsertAgentCommandAnswer(env, answer({ id: "answer-new", command: "blockers", responseCommentId: 10 }));
    await upsertAgentCommandAnswer(env, answer({ id: "answer-new", command: "blockers", responseCommentId: 11, responseUrl: "https://github.com/JSONbored/gittensory/pull/1#issuecomment-11" }));
    await upsertAgentCommandAnswer(env, answer({ id: "answer-old", command: "next-action" }));

    await expect(getAgentCommandAnswer(env, "answer-new")).resolves.toMatchObject({
      id: "answer-new",
      responseCommentId: 11,
      responseUrl: "https://github.com/JSONbored/gittensory/pull/1#issuecomment-11",
    });

    await recordAgentCommandFeedback(env, feedback({ answerId: "answer-new", command: "blockers", actorLogin: "reviewer", updatedAt: "2026-05-28T00:00:00.000Z" }));
    await recordAgentCommandFeedback(env, feedback({ answerId: "answer-old", command: "next-action", actorLogin: "old", updatedAt: "2026-04-01T00:00:00.000Z" }));

    const summary = await getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 14 });
    expect(summary.windowDays).toBe(14);
    expect(summary.commands.map((row) => row.command)).toEqual(["blockers"]);
    expect(summary.totals.feedbackCount).toBe(1);

    const clamped = await getCommandUsefulnessSummary(env, { now: "2026-05-29T00:00:00.000Z", windowDays: 999 });
    expect(clamped.windowDays).toBe(180);
  });
});

function answer(overrides: Partial<Parameters<typeof upsertAgentCommandAnswer>[1]> = {}): Parameters<typeof upsertAgentCommandAnswer>[1] {
  return {
    id: "answer",
    repoFullName: "JSONbored/gittensory",
    issueNumber: 77,
    command: "preflight",
    requestCommentId: 1,
    responseCommentId: 2,
    responseUrl: null,
    actorKind: "author",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

function feedback(overrides: Partial<Parameters<typeof recordAgentCommandFeedback>[1]> = {}): Parameters<typeof recordAgentCommandFeedback>[1] {
  return {
    answerId: "answer",
    repoFullName: "JSONbored/gittensory",
    issueNumber: 77,
    command: "preflight",
    actorLogin: "reviewer",
    vote: "useful",
    source: "github_reaction",
    actorKind: "maintainer",
    updatedAt: "2026-05-28T00:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}
