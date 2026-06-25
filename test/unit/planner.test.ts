import { describe, expect, it, vi } from "vitest";

import { buildIssuePlanComment, classifyPlanCommandRequest, generateIssuePlan, isPlanCommand, isPlannerEnabled } from "../../src/review/planner";
import type { GitHubWebhookPayload } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("isPlannerEnabled (#issue-coding-plan)", () => {
  it("is OFF for unset/falsey flags and ON for truthy ones", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isPlannerEnabled({ GITTENSORY_REVIEW_PLANNER: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isPlannerEnabled({ GITTENSORY_REVIEW_PLANNER: on })).toBe(true);
  });
});

describe("isPlanCommand (#issue-coding-plan)", () => {
  it("matches a bare @gittensory plan mention (case-insensitive, anywhere)", () => {
    expect(isPlanCommand("@gittensory plan")).toBe(true);
    expect(isPlanCommand("Hey @gittensory plan this please")).toBe(true);
    expect(isPlanCommand("@GitTensory   plan")).toBe(true);
  });
  it("does not match other commands or non-mentions", () => {
    expect(isPlanCommand("@gittensory help")).toBe(false);
    expect(isPlanCommand("@gittensoryplan")).toBe(false); // no handle boundary
    expect(isPlanCommand("plan the work")).toBe(false);
    expect(isPlanCommand(null)).toBe(false);
    expect(isPlanCommand(undefined)).toBe(false);
  });
});

describe("generateIssuePlan (#issue-coding-plan)", () => {
  it("returns the model's plan text when Workers AI responds", async () => {
    const run = vi.fn(async () => ({ response: "## Summary\nDo the thing.\n\n## Steps\n1. Edit foo.ts" }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    const plan = await generateIssuePlan(env, { title: "Add a flag", body: "We need a config flag." });
    expect(plan).toContain("## Summary");
    expect(run).toHaveBeenCalledTimes(1);
    // The issue text is passed to the model as the user message.
    const opts = (run.mock.calls[0] as unknown as [string, { messages?: Array<{ role: string; content: string }> }])[1];
    const userMessage = opts?.messages?.find((m) => m.role === "user")?.content ?? "";
    expect(userMessage).toContain("Add a flag");
    expect(userMessage).toContain("We need a config flag.");
  });

  it("covers the title/body fallbacks and routes through the AI Gateway when configured", async () => {
    const run = vi.fn(async () => ({ response: "plan" }));
    const env = createTestEnv({ AI: { run } as unknown as Ai, AI_GATEWAY_ID: "gw-1" });
    expect(await generateIssuePlan(env, { title: "only a title", body: "" })).toBe("plan"); // body fallback
    expect(await generateIssuePlan(env, { title: "", body: "only a body" })).toBe("plan"); // title fallback
    // the configured gateway id is threaded as the 3rd run() arg
    expect((run.mock.calls[0] as unknown as unknown[])[2]).toEqual({ gateway: { id: "gw-1" } });
  });

  it("returns null when there is no issue text to plan from (no AI call)", async () => {
    const run = vi.fn(async () => ({ response: "x" }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    expect(await generateIssuePlan(env, { title: "", body: "" })).toBeNull();
    expect(await generateIssuePlan(env, { title: null, body: null })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns null when Workers AI is unavailable or returns nothing (fail-safe)", async () => {
    expect(await generateIssuePlan(createTestEnv({ AI: undefined as unknown as Ai }), { title: "T", body: "B" })).toBeNull();
    const emptyRun = vi.fn(async () => ({ response: "   " }));
    expect(await generateIssuePlan(createTestEnv({ AI: { run: emptyRun } as unknown as Ai }), { title: "T", body: "B" })).toBeNull();
    // throwing on every attempt also degrades to null
    const throwRun = vi.fn(async () => {
      throw new Error("ai down");
    });
    expect(await generateIssuePlan(createTestEnv({ AI: { run: throwRun } as unknown as Ai }), { title: "T", body: "B" })).toBeNull();
  });
});

describe("classifyPlanCommandRequest (#issue-coding-plan)", () => {
  const base = (over: Record<string, unknown> = {}): GitHubWebhookPayload =>
    ({
      action: "created",
      repository: { full_name: "acme/widgets" },
      issue: { number: 9, title: "T", state: "open", body: "B" },
      comment: { id: 1, body: "@gittensory plan", user: { login: "maint", type: "User" } },
      sender: { login: "maint", type: "User" },
      ...over,
    }) as unknown as GitHubWebhookPayload;

  it("returns ok with the validated fields for a maintainer comment on a real issue", () => {
    const req = classifyPlanCommandRequest(base(), 123);
    expect(req).toEqual({ ok: true, repoFullName: "acme/widgets", installationId: 123, actor: "maint", issue: { number: 9, title: "T", body: "B" } });
  });

  it("skips a non-created action or a bot author", () => {
    expect(classifyPlanCommandRequest(base({ action: "edited" }), 123)).toMatchObject({ ok: false, reason: "unsupported_comment_action_or_bot", targetKey: "acme/widgets#9" });
    expect(classifyPlanCommandRequest(base({ comment: { id: 1, body: "@gittensory plan", user: { login: "bot", type: "Bot" } } }), 123)).toMatchObject({ ok: false, reason: "unsupported_comment_action_or_bot" });
    expect(classifyPlanCommandRequest(base({ sender: { login: "x", type: "Bot" } }), 123)).toMatchObject({ ok: false, reason: "unsupported_comment_action_or_bot" });
    expect(classifyPlanCommandRequest(base({ sender: { login: "renovate[bot]", type: "User" } }), 123)).toMatchObject({ ok: false, reason: "unsupported_comment_action_or_bot" });
  });

  it("skips when the repo, issue, installation, or actor is missing, or the comment is on a PR", () => {
    expect(classifyPlanCommandRequest(base({ repository: undefined }), 123)).toMatchObject({ ok: false, reason: "missing_repo_issue_installation_or_actor", repoFullName: null, targetKey: null });
    expect(classifyPlanCommandRequest(base({ issue: undefined }), 123)).toMatchObject({ ok: false, reason: "missing_repo_issue_installation_or_actor", targetKey: "acme/widgets" });
    expect(classifyPlanCommandRequest(base({ issue: { number: 9, title: "T", state: "open", pull_request: {} } }), 123)).toMatchObject({ ok: false, reason: "missing_repo_issue_installation_or_actor" });
    expect(classifyPlanCommandRequest(base(), null)).toMatchObject({ ok: false, reason: "missing_repo_issue_installation_or_actor" });
    expect(classifyPlanCommandRequest(base({ sender: undefined, comment: { id: 1, body: "@gittensory plan", user: undefined } }), 123)).toMatchObject({ ok: false, reason: "missing_repo_issue_installation_or_actor", actor: null });
  });
});

describe("buildIssuePlanComment (#issue-coding-plan)", () => {
  it("renders the plan with the marker, actor, scope, and footer", () => {
    const body = buildIssuePlanComment("## Summary\nShip it.", { actor: "maintainer1", repoFullName: "acme/widgets", issueNumber: 42 });
    expect(body).toContain("Gittensory implementation plan");
    expect(body).toContain("@maintainer1");
    expect(body).toContain("acme/widgets#42");
    expect(body).toContain("Ship it.");
    expect(body).toContain("`@gittensory plan`");
  });
});
