import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import { upsertIssueFromGitHub } from "../../src/db/repositories";
import { resolveUnlinkedIssueMatchHold } from "../../src/review/unlinked-issue-guardrail";
import type { UnlinkedIssueGuardrailConfig } from "../../src/types";

function config(overrides: Partial<UnlinkedIssueGuardrailConfig> = {}): UnlinkedIssueGuardrailConfig {
  return { mode: "hold", minConfidence: 0.85, ...overrides };
}

function aiVerdict(overrides: Record<string, unknown> = {}) {
  return { matched: true, confidence: 0.9, evidence: "diff directly resolves the described bug", ...overrides };
}

async function seedIssue(env: Awaited<ReturnType<typeof createTestEnv>>, number: number, title: string, body: string) {
  await upsertIssueFromGitHub(env, "owner/repo", { number, title, state: "open", user: { login: "someone" }, labels: [], body });
}

describe("resolveUnlinkedIssueMatchHold", () => {
  it("returns undefined immediately when the guardrail mode is off, without any AI call", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 1, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchHold(env, {
      repoFullName: "owner/repo",
      config: config({ mode: "off" }),
      linkedIssueCount: 0,
      prTitle: "fix webhook retry duplicate bug",
      prBody: null,
      changedPaths: [],
      diff: "diff",
    });
    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns undefined immediately when the PR already links an issue, without any AI call", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 1, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchHold(env, {
      repoFullName: "owner/repo",
      config: config(),
      linkedIssueCount: 1,
      prTitle: "fix webhook retry duplicate bug",
      prBody: null,
      changedPaths: [],
      diff: "diff",
    });
    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns undefined when the repo has no open issues that qualify as candidates", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 1, "completely unrelated topic", "nothing to do with this change at all");
    const result = await resolveUnlinkedIssueMatchHold(env, {
      repoFullName: "owner/repo",
      config: config(),
      linkedIssueCount: 0,
      prTitle: "fix webhook retry duplicate bug",
      prBody: null,
      changedPaths: [],
      diff: "diff",
    });
    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("holds the PR with a comment citing the matched issue when the AI confirms a direct match", async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchHold(env, {
      repoFullName: "owner/repo",
      config: config(),
      linkedIssueCount: 0,
      prTitle: "fix webhook retry duplicate bug",
      prBody: null,
      changedPaths: [],
      diff: "diff",
    });
    expect(result?.reason).toContain("#7");
    expect(result?.reason).toContain("diff directly resolves the described bug");
    expect(result?.comment).toContain("Closes #7");
  });

  it("omits the evidence parenthetical when the AI verdict has no evidence text", async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict({ evidence: "" })) }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchHold(env, {
      repoFullName: "owner/repo",
      config: config(),
      linkedIssueCount: 0,
      prTitle: "fix webhook retry duplicate bug",
      prBody: null,
      changedPaths: [],
      diff: "diff",
    });
    expect(result?.reason).toBe("this PR links no issue, but appears to directly solve open issue #7 without linking it");
  });

  it("does not hold when the AI verdict is below the configured minConfidence", async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict({ confidence: 0.5 })) }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchHold(env, {
      repoFullName: "owner/repo",
      config: config({ minConfidence: 0.85 }),
      linkedIssueCount: 0,
      prTitle: "fix webhook retry duplicate bug",
      prBody: null,
      changedPaths: [],
      diff: "diff",
    });
    expect(result).toBeUndefined();
  });

  it("treats an issue with no body field at all (undefined, not null) as having empty body text", async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    // No `body` key at all -> GitHubIssuePayload omits it -> IssueRecord.body is `undefined`, not `null`,
    // exercising the `issue.body ?? null` fallback. Title-only token overlap is still enough to qualify.
    await upsertIssueFromGitHub(env, "owner/repo", {
      number: 12,
      title: "webhook retry duplicate timeout handling logic bug",
      state: "open",
      user: { login: "someone" },
      labels: [],
    });
    const result = await resolveUnlinkedIssueMatchHold(env, {
      repoFullName: "owner/repo",
      config: config(),
      linkedIssueCount: 0,
      prTitle: "fix webhook retry duplicate timeout handling logic",
      prBody: null,
      changedPaths: [],
      diff: "diff",
    });
    expect(result?.reason).toContain("#12");
  });

  it("falls through to the second candidate when the first is not a match", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ response: JSON.stringify(aiVerdict({ matched: false, confidence: 0.9 })) })
      .mockResolvedValueOnce({ response: JSON.stringify(aiVerdict({ matched: true, confidence: 0.95, evidence: "second issue is the real match" })) });
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    // Both issues score identically on tokens alone; #3 (lower number) is checked first by the pre-filter's
    // tie-break, and its AI verdict comes back not-matched -- the orchestrator must still check #9.
    await seedIssue(env, 3, "webhook retry duplicate bug report", "retries duplicate events under load, needs a dedup key");
    await seedIssue(env, 9, "webhook retry duplicate bug report", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchHold(env, {
      repoFullName: "owner/repo",
      config: config(),
      linkedIssueCount: 0,
      prTitle: "fix webhook retry duplicate bug report",
      prBody: null,
      changedPaths: [],
      diff: "diff",
    });
    expect(result?.reason).toContain("#9");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
