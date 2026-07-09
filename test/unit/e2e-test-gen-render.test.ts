import { describe, expect, it } from "vitest";
import { buildE2eTestGenCommentBody } from "../../src/review/e2e-test-gen-render";
import { PR_PANEL_COMMENT_MARKER } from "../../src/github/comments";

describe("buildE2eTestGenCommentBody", () => {
  it("renders the generated test source in a fenced code block, defaulting the framework to Playwright", () => {
    const body = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: "test('x', () => {});" });
    expect(body).toContain(PR_PANEL_COMMENT_MARKER);
    expect(body).toContain("AI-generated Playwright test for @maintainer");
    expect(body).toContain("```typescript\ntest('x', () => {});\n```");
  });

  it("uses a longer markdown fence when generated source contains backtick fences", () => {
    const source = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('injected markdown stays inside the code block', async ({ page }) => {",
      "  const attackerMarkdown = `",
      "```",
      "# rendered outside the fence before the fix",
      "```",
      "  `;",
      "  expect(attackerMarkdown).toContain('# rendered outside');",
      "});",
    ].join("\n");

    const body = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: source });

    expect(body).toContain("````typescript\n");
    expect(body).toContain(source + "\n````");
    expect(body.split("\n")).not.toContain("```typescript");
  });

  it("uses a custom framework name when provided", () => {
    const body = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: "it('x', () => {});", framework: "Cypress" });
    expect(body).toContain("AI-generated Cypress test for @maintainer");
  });

  it("renders a not-usable note (no code fence) when testSource is null", () => {
    const body = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: null });
    expect(body).toContain(PR_PANEL_COMMENT_MARKER);
    expect(body).toContain("did not produce a usable result");
    expect(body).not.toContain("```");
  });

  it("names the configured framework in the not-usable note too", () => {
    const body = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: null, framework: "Cypress" });
    expect(body).toContain("didn't parse as valid Cypress source");
  });

  it("links to the commit instead of repeating the code when commit delivery succeeded", () => {
    const body = buildE2eTestGenCommentBody({
      actor: "maintainer",
      testSource: "test('x', () => {});",
      commit: { status: "committed", commitSha: "abcdef1234567890", htmlUrl: "https://github.com/o/r/commit/abcdef1234567890" },
    });
    expect(body).toContain("pushed as a commit");
    expect(body).toContain("[View the commit](https://github.com/o/r/commit/abcdef1234567890)");
    expect(body).toContain("`abcdef1`"); // short sha
    expect(body).not.toContain("```typescript"); // the commit IS the deliverable, not repeated inline
  });

  it("still renders the suggestion, with a reason, when commit delivery was declined", () => {
    const body = buildE2eTestGenCommentBody({
      actor: "maintainer",
      testSource: "test('x', () => {});",
      commit: { status: "declined", reason: "no write access to the PR branch" },
    });
    expect(body).toContain("Commit delivery was requested but declined: no write access to the PR branch");
    expect(body).toContain("```typescript\ntest('x', () => {});\n```"); // falls back to the suggestion
  });

  it("still renders the suggestion, with the scoring-integrity reason, when commit delivery was blocked for a confirmed miner", () => {
    const body = buildE2eTestGenCommentBody({
      actor: "maintainer",
      testSource: "test('x', () => {});",
      commit: { status: "blocked" },
    });
    expect(body).toContain("confirmed Gittensor miner");
    expect(body).toContain("```typescript\ntest('x', () => {});\n```");
  });

  it("renders exactly like comment-only mode when commit is omitted entirely", () => {
    const withoutCommit = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: "test('x', () => {});" });
    const withUndefinedCommit = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: "test('x', () => {});", commit: undefined });
    expect(withUndefinedCommit).toBe(withoutCommit);
  });
});
