import { describe, expect, it } from "vitest";

import { classifyPrCommandRequest } from "../../src/github/pr-command-request";
import type { GitHubWebhookPayload } from "../../src/types";

describe("classifyPrCommandRequest (#1960)", () => {
  const base = (over: Record<string, unknown> = {}): GitHubWebhookPayload =>
    ({
      action: "created",
      repository: { full_name: "acme/widgets" },
      issue: { number: 9, title: "T", state: "open", body: "B", pull_request: {} },
      comment: { id: 1, body: "@gittensory review", user: { login: "maint", type: "User" } },
      sender: { login: "maint", type: "User" },
      ...over,
    }) as unknown as GitHubWebhookPayload;

  it("returns ok with the validated fields for a maintainer comment on a real PR", () => {
    const req = classifyPrCommandRequest(base(), 123);
    expect(req).toEqual({ ok: true, repoFullName: "acme/widgets", installationId: 123, actor: "maint", pr: { number: 9, title: "T", body: "B" } });
  });

  it("skips a non-created comment action (unsupported_comment_action)", () => {
    expect(classifyPrCommandRequest(base({ action: "edited" }), 123)).toMatchObject({ ok: false, reason: "unsupported_comment_action", repoFullName: "acme/widgets", targetKey: "acme/widgets#9" });
    expect(classifyPrCommandRequest(base({ action: "deleted" }), 123)).toMatchObject({ ok: false, reason: "unsupported_comment_action" });
  });

  it("skips a Bot comment author, Bot sender, or a login ending in [bot] (bot_author)", () => {
    expect(classifyPrCommandRequest(base({ comment: { id: 1, body: "@gittensory review", user: { login: "bot", type: "Bot" } } }), 123)).toMatchObject({ ok: false, reason: "bot_author" });
    expect(classifyPrCommandRequest(base({ sender: { login: "x", type: "Bot" } }), 123)).toMatchObject({ ok: false, reason: "bot_author" });
    expect(classifyPrCommandRequest(base({ sender: { login: "renovate[bot]", type: "User" } }), 123)).toMatchObject({ ok: false, reason: "bot_author" });
  });

  it("skips when the repo, PR, installation, or actor is missing, or the comment is on a plain issue (missing_repo_pr_installation_or_actor)", () => {
    expect(classifyPrCommandRequest(base({ repository: undefined }), 123)).toMatchObject({ ok: false, reason: "missing_repo_pr_installation_or_actor", repoFullName: null, targetKey: null });
    expect(classifyPrCommandRequest(base({ issue: undefined }), 123)).toMatchObject({ ok: false, reason: "missing_repo_pr_installation_or_actor", targetKey: "acme/widgets" });
    // No `pull_request` field on the issue → this is a plain issue comment, not a PR comment.
    expect(classifyPrCommandRequest(base({ issue: { number: 9, title: "T", state: "open" } }), 123)).toMatchObject({ ok: false, reason: "missing_repo_pr_installation_or_actor" });
    expect(classifyPrCommandRequest(base(), null)).toMatchObject({ ok: false, reason: "missing_repo_pr_installation_or_actor" });
    expect(classifyPrCommandRequest(base({ sender: undefined, comment: { id: 1, body: "@gittensory review", user: undefined } }), 123)).toMatchObject({
      ok: false,
      reason: "missing_repo_pr_installation_or_actor",
      actor: null,
    });
  });

  it("prefers the sender login over the comment author login when both are present", () => {
    const req = classifyPrCommandRequest(base({ sender: { login: "sender-login", type: "User" }, comment: { id: 1, body: "@gittensory review", user: { login: "comment-login", type: "User" } } }), 123);
    expect(req).toMatchObject({ ok: true, actor: "sender-login" });
  });

  it("falls back to the comment author login when the sender is absent", () => {
    const req = classifyPrCommandRequest(base({ sender: undefined, comment: { id: 1, body: "@gittensory review", user: { login: "comment-login", type: "User" } } }), 123);
    expect(req).toMatchObject({ ok: true, actor: "comment-login" });
  });
});
