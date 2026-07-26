import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_EXPLANATION_RETRY_DELAYS_MS, postCloseExplanation } from "../../src/queue/review-evasion";
import { createIssueComment } from "../../src/github/pr-actions";
import { createTestEnv } from "../helpers/d1";

vi.mock("../../src/github/pr-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/pr-actions")>()),
  createIssueComment: vi.fn(async () => ({ id: 1 })),
}));

// #8802: the bounded retry around a one-shot close's ONLY explanation comment. Fake timers make the spaced
// retries instant; the delays constant itself is pinned so a future edit can't silently unbound the loop.
describe("postCloseExplanation (#8802)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("posts once and returns true on first success — no retries, no delay", async () => {
    const env = createTestEnv();
    const result = await postCloseExplanation(env, 123, "owner/repo", 7, "Closed: reason.");
    expect(result).toBe(true);
    expect(createIssueComment).toHaveBeenCalledTimes(1);
  });

  it("retries through transient failures and succeeds — a rate-limit window rarely spans three spaced attempts", async () => {
    const env = createTestEnv();
    vi.mocked(createIssueComment).mockRejectedValueOnce(new Error("secondary rate limit")).mockRejectedValueOnce(new Error("502"));
    const pending = postCloseExplanation(env, 123, "owner/repo", 7, "Closed: reason.");
    await vi.advanceTimersByTimeAsync(CLOSE_EXPLANATION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    expect(await pending).toBe(true);
    expect(createIssueComment).toHaveBeenCalledTimes(3);
  });

  it("returns false with a LOUD level:error residue log when every attempt fails — the audit row records the unexplained close", async () => {
    const env = createTestEnv();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(createIssueComment).mockRejectedValue(new Error("down"));
    const pending = postCloseExplanation(env, 123, "owner/repo", 7, "Closed: reason.");
    await vi.advanceTimersByTimeAsync(CLOSE_EXPLANATION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    expect(await pending).toBe(false);
    expect(createIssueComment).toHaveBeenCalledTimes(CLOSE_EXPLANATION_RETRY_DELAYS_MS.length);
    const residue = log.mock.calls.map((c) => c[0]).find((l) => typeof l === "string" && l.includes("close_explanation_post_failed"));
    expect(residue).toBeDefined();
    expect(JSON.parse(residue as string)).toMatchObject({ level: "error", event: "close_explanation_post_failed", repoFullName: "owner/repo", prNumber: 7 });
    log.mockRestore();
  });

  it("the delay ladder stays bounded and starts immediately (pinned)", () => {
    expect(CLOSE_EXPLANATION_RETRY_DELAYS_MS[0]).toBe(0);
    expect(CLOSE_EXPLANATION_RETRY_DELAYS_MS.length).toBe(3);
  });
});
