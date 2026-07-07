import { describe, expect, it } from "vitest";
import { classifyConfigurationCommandRequest } from "../../src/github/configuration-command";
import type { GitHubWebhookPayload } from "../../src/types";

type PayloadParts = {
  action?: string;
  body?: string | null;
  commentUser?: { login?: string; type?: string } | null;
  sender?: { login?: string; type?: string } | null;
  repository?: { full_name?: string } | null;
  issue?: { number: number; pull_request?: unknown } | null;
};

function payload(parts: PayloadParts = {}): GitHubWebhookPayload {
  return {
    action: parts.action ?? "created",
    repository: parts.repository === null ? undefined : (parts.repository ?? { full_name: "acme/widgets" }),
    issue: parts.issue === null ? undefined : (parts.issue ?? { number: 7 }),
    comment: { body: parts.body === undefined ? "@gittensory configuration" : parts.body, user: parts.commentUser === null ? undefined : (parts.commentUser ?? { login: "maintainer", type: "User" }) },
    sender: parts.sender === null ? undefined : (parts.sender ?? { login: "maintainer", type: "User" }),
  } as unknown as GitHubWebhookPayload;
}

describe("classifyConfigurationCommandRequest", () => {
  it("returns null for a non-configuration comment (no mention, or a different verb)", () => {
    expect(classifyConfigurationCommandRequest(payload({ body: "just a comment" }), 123)).toBeNull();
    expect(classifyConfigurationCommandRequest(payload({ body: "@gittensory plan" }), 123)).toBeNull();
    expect(classifyConfigurationCommandRequest(payload({ body: null }), 123)).toBeNull();
  });

  it("returns ok:true with the resolved target for a valid maintainer configuration command", () => {
    const req = classifyConfigurationCommandRequest(payload(), 123);
    expect(req).toEqual({ ok: true, repoFullName: "acme/widgets", installationId: 123, actor: "maintainer", issueNumber: 7 });
  });

  it("works on a PR thread too (repo-level command, not issue-only)", () => {
    const req = classifyConfigurationCommandRequest(payload({ issue: { number: 9, pull_request: {} } }), 123);
    expect(req).toEqual({ ok: true, repoFullName: "acme/widgets", installationId: 123, actor: "maintainer", issueNumber: 9 });
  });

  it("skips a non-created action", () => {
    expect(classifyConfigurationCommandRequest(payload({ action: "edited" }), 123)).toMatchObject({ ok: false, reason: "unsupported_comment_action_or_bot" });
  });

  it("skips bot actors (comment user, sender, or a [bot] login suffix)", () => {
    expect(classifyConfigurationCommandRequest(payload({ commentUser: { login: "x", type: "Bot" } }), 123)).toMatchObject({ ok: false, reason: "unsupported_comment_action_or_bot" });
    expect(classifyConfigurationCommandRequest(payload({ sender: { login: "x", type: "Bot" } }), 123)).toMatchObject({ ok: false, reason: "unsupported_comment_action_or_bot" });
    expect(classifyConfigurationCommandRequest(payload({ sender: { login: "renovate[bot]", type: "User" }, commentUser: { login: "renovate[bot]", type: "User" } }), 123)).toMatchObject({ ok: false, reason: "unsupported_comment_action_or_bot" });
  });

  it("skips when repo, issue, installation, or actor is missing", () => {
    expect(classifyConfigurationCommandRequest(payload({ repository: null }), 123)).toMatchObject({ ok: false, reason: "missing_repo_issue_installation_or_actor", repoFullName: null });
    expect(classifyConfigurationCommandRequest(payload({ issue: null }), 123)).toMatchObject({ ok: false, reason: "missing_repo_issue_installation_or_actor" });
    expect(classifyConfigurationCommandRequest(payload(), null)).toMatchObject({ ok: false, reason: "missing_repo_issue_installation_or_actor" });
    // actor resolves to null when neither sender.login nor comment.user.login is present (both still non-bot)
    expect(
      classifyConfigurationCommandRequest(payload({ sender: { type: "User" }, commentUser: { type: "User" } }), 123),
    ).toMatchObject({ ok: false, reason: "missing_repo_issue_installation_or_actor", actor: null });
  });

  it("falls back to the comment author when the sender login is absent", () => {
    const req = classifyConfigurationCommandRequest(payload({ sender: { type: "User" }, commentUser: { login: "author", type: "User" } }), 123);
    expect(req).toMatchObject({ ok: true, actor: "author" });
  });
});
