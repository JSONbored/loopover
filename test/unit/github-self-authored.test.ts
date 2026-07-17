import { describe, expect, it } from "vitest";
import {
  isBotAuthoredIssueCommentEditWebhook,
  isNonActionableWebhookNoise,
  isNonCompletedCiWebhook,
  isSelfAuthoredAppCommentWebhook,
  isSelfAuthoredCiCompletionWebhook,
  isSelfAuthoredWebhookNoise,
} from "../../src/github/self-authored";
import type { GitHubWebhookPayload } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("self-authored GitHub webhook detection", () => {
  it("recognizes only comments authored by this GitHub App bot", () => {
    const env = createTestEnv({ GITHUB_APP_SLUG: "loopover-orb" });
    const payload = {
      action: "edited",
      sender: { login: "loopover-orb[bot]", type: "Bot" },
      comment: { user: { login: "loopover-orb[bot]", type: "Bot" } },
    } as GitHubWebhookPayload;
    const missingSlugEnv = createTestEnv();
    delete (missingSlugEnv as { GITHUB_APP_SLUG?: string }).GITHUB_APP_SLUG;

    expect(isSelfAuthoredAppCommentWebhook(env, "issue_comment", payload)).toBe(true);
    expect(isSelfAuthoredWebhookNoise(env, "issue_comment", payload)).toBe(true);
    expect(isSelfAuthoredAppCommentWebhook(env, "pull_request", payload)).toBe(false);
    expect(isSelfAuthoredAppCommentWebhook(env, "issue_comment", { ...payload, action: "deleted" })).toBe(false);
    expect(isSelfAuthoredAppCommentWebhook(createTestEnv({ GITHUB_APP_SLUG: "" }), "issue_comment", payload)).toBe(false);
    expect(isSelfAuthoredAppCommentWebhook(missingSlugEnv, "issue_comment", payload)).toBe(false);
    expect(
      isSelfAuthoredAppCommentWebhook(env, "issue_comment", {
        ...payload,
        sender: { login: "someone-else[bot]", type: "Bot" },
      }),
    ).toBe(false);
  });

  it("recognizes self-authored check suites and check runs without matching other CI events", () => {
    const env = createTestEnv({ GITHUB_APP_SLUG: "loopover-orb" });

    expect(
      isSelfAuthoredCiCompletionWebhook(env, "check_suite", {
        action: "completed",
        check_suite: { app: { slug: "loopover-orb" } },
      } as never),
    ).toBe(true);
    expect(
      isSelfAuthoredCiCompletionWebhook(env, "check_run", {
        action: "completed",
        check_run: { app: { slug: "loopover-orb" } },
      } as never),
    ).toBe(true);
    expect(
      isSelfAuthoredCiCompletionWebhook(env, "check_run", {
        action: "completed",
        check_run: { check_suite: { app: { slug: "loopover-orb" } } },
      } as never),
    ).toBe(true);
    expect(
      isSelfAuthoredCiCompletionWebhook(env, "check_run", {
        action: "rerequested",
        check_run: { app: { slug: "loopover-orb" } },
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

  it("classifies non-completed CI lifecycle events as non-actionable noise only until completion", () => {
    const env = createTestEnv({ GITHUB_APP_SLUG: "loopover-orb" });

    expect(isNonCompletedCiWebhook("check_suite", { action: "requested" })).toBe(true);
    expect(isNonCompletedCiWebhook("check_run", { action: "rerequested" })).toBe(true);
    expect(isNonActionableWebhookNoise(env, "check_suite", { action: "requested" })).toBe(true);
    expect(
      isNonActionableWebhookNoise(env, "check_suite", {
        action: "completed",
        check_suite: { app: { slug: "github-actions" } },
      } as never),
    ).toBe(false);
    expect(isNonCompletedCiWebhook("pull_request", { action: "opened" })).toBe(false);
  });

  it("drops bot-sender issue comment edits while preserving human panel edits", () => {
    const env = createTestEnv({ GITHUB_APP_SLUG: "loopover-orb" });
    const humanPanelEdit = {
      action: "edited",
      sender: { login: "maintainer", type: "User" },
      comment: { user: { login: "loopover-orb[bot]", type: "Bot" } },
    } as GitHubWebhookPayload;

    expect(
      isBotAuthoredIssueCommentEditWebhook("issue_comment", {
        action: "edited",
        sender: { login: "codecov[bot]", type: "User" },
      } as GitHubWebhookPayload),
    ).toBe(true);
    expect(
      isBotAuthoredIssueCommentEditWebhook("issue_comment", {
        action: "edited",
        sender: { login: "external-bot", type: "Bot" },
      } as GitHubWebhookPayload),
    ).toBe(true);
    expect(isBotAuthoredIssueCommentEditWebhook("issue_comment", humanPanelEdit)).toBe(false);
    expect(isNonActionableWebhookNoise(env, "issue_comment", humanPanelEdit)).toBe(false);
    expect(
      isBotAuthoredIssueCommentEditWebhook("issue_comment", {
        action: "edited",
      } as GitHubWebhookPayload),
    ).toBe(false);
    expect(
      isBotAuthoredIssueCommentEditWebhook("issue_comment", {
        action: "edited",
        sender: { login: "external-bot", type: "bot" },
      } as GitHubWebhookPayload),
    ).toBe(true);
    expect(
      isBotAuthoredIssueCommentEditWebhook("issue_comment", {
        action: "created",
        sender: { login: "codecov[bot]", type: "Bot" },
      } as GitHubWebhookPayload),
    ).toBe(false);
  });
});
