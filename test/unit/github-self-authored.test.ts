import { describe, expect, it } from "vitest";
import {
  isSelfAuthoredAppCommentWebhook,
  isSelfAuthoredCiCompletionWebhook,
  isSelfAuthoredWebhookNoise,
} from "../../src/github/self-authored";
import type { GitHubWebhookPayload } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("self-authored GitHub webhook detection", () => {
  it("recognizes only comments authored by this GitHub App bot", () => {
    const env = createTestEnv({ GITHUB_APP_SLUG: "gittensory-orb" });
    const payload = {
      action: "edited",
      sender: { login: "gittensory-orb[bot]", type: "Bot" },
      comment: { user: { login: "gittensory-orb[bot]", type: "Bot" } },
    } as GitHubWebhookPayload;

    expect(isSelfAuthoredAppCommentWebhook(env, "issue_comment", payload)).toBe(true);
    expect(isSelfAuthoredWebhookNoise(env, "issue_comment", payload)).toBe(true);
    expect(isSelfAuthoredAppCommentWebhook(env, "pull_request", payload)).toBe(false);
    expect(isSelfAuthoredAppCommentWebhook(env, "issue_comment", { ...payload, action: "deleted" })).toBe(false);
    expect(isSelfAuthoredAppCommentWebhook(createTestEnv({ GITHUB_APP_SLUG: "" }), "issue_comment", payload)).toBe(false);
    expect(
      isSelfAuthoredAppCommentWebhook(env, "issue_comment", {
        ...payload,
        sender: { login: "someone-else[bot]", type: "Bot" },
      }),
    ).toBe(false);
  });

  it("recognizes self-authored check suites and check runs without matching other CI events", () => {
    const env = createTestEnv({ GITHUB_APP_SLUG: "gittensory-orb" });

    expect(
      isSelfAuthoredCiCompletionWebhook(env, "check_suite", {
        action: "completed",
        check_suite: { app: { slug: "gittensory-orb" } },
      } as never),
    ).toBe(true);
    expect(
      isSelfAuthoredCiCompletionWebhook(env, "check_run", {
        action: "completed",
        check_run: { app: { slug: "gittensory-orb" } },
      } as never),
    ).toBe(true);
    expect(
      isSelfAuthoredCiCompletionWebhook(env, "check_run", {
        action: "completed",
        check_run: { check_suite: { app: { slug: "gittensory-orb" } } },
      } as never),
    ).toBe(true);
    expect(
      isSelfAuthoredCiCompletionWebhook(env, "check_run", {
        action: "rerequested",
        check_run: { app: { slug: "gittensory-orb" } },
      } as never),
    ).toBe(false);
    expect(
      isSelfAuthoredCiCompletionWebhook(env, "check_run", {
        action: "completed",
        check_run: { app: { slug: "github-actions" } },
      } as never),
    ).toBe(false);
    expect(isSelfAuthoredCiCompletionWebhook(env, "pull_request", { action: "completed" })).toBe(false);
    expect(isSelfAuthoredWebhookNoise(env, "pull_request", { action: "completed" })).toBe(false);
  });
});
