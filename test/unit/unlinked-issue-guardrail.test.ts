import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import { upsertIssueFromGitHub, hasRecentAuditEvent } from "../../src/db/repositories";
import { resolveUnlinkedIssueMatchDisposition, UNLINKED_ISSUE_MATCH_AUDIT_EVENT_TYPE } from "../../src/review/unlinked-issue-guardrail";
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

const BASE_INPUT = {
  repoFullName: "owner/repo",
  pullNumber: 101,
  linkedIssueCount: 0,
  prTitle: "fix webhook retry duplicate bug",
  prBody: null as string | null,
  changedPaths: [] as string[],
  diff: "diff",
  prAuthorLogin: "contributor-a",
};

describe("resolveUnlinkedIssueMatchDisposition", () => {
  it("returns undefined immediately when the guardrail mode is off, without any AI call", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 1, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config({ mode: "off" }) });
    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns undefined immediately when the PR already links an issue, without any AI call", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 1, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config(), linkedIssueCount: 1 });
    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns undefined when the repo has no open issues that qualify as candidates", async () => {
    const run = vi.fn();
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 1, "completely unrelated topic", "nothing to do with this change at all");
    const result = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config() });
    expect(result).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("holds (kind: hold) with a comment citing the matched issue on a FIRST confirmed match, and records the occurrence", async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config() });
    expect(result?.kind).toBe("hold");
    expect(result?.reason).toContain("#7");
    expect(result?.reason).toContain("diff directly resolves the described bug");
    expect(result?.comment).toContain("Closes #7");
    // The occurrence is recorded for future repeat-detection, even on a first-time hold.
    expect(await hasRecentAuditEvent(env, "contributor-a", UNLINKED_ISSUE_MATCH_AUDIT_EVENT_TYPE, "2000-01-01T00:00:00.000Z")).toBe(true);
  });

  it("omits the evidence parenthetical when the AI verdict has no evidence text", async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict({ evidence: "" })) }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config() });
    expect(result).toEqual({
      kind: "hold",
      reason: "this PR links no issue, but appears to directly solve open issue #7 without linking it",
      comment: expect.stringContaining("Closes #7"),
    });
  });

  it("does not hold when the AI verdict is below the configured minConfidence", async () => {
    const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict({ confidence: 0.5 })) }));
    const env = createTestEnv({ AI: { run } as unknown as Ai });
    await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
    const result = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config({ minConfidence: 0.85 }) });
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
    const result = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config(), prTitle: "fix webhook retry duplicate timeout handling logic" });
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
    const result = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config(), prTitle: "fix webhook retry duplicate bug report" });
    expect(result?.reason).toContain("#9");
    expect(run).toHaveBeenCalledTimes(2);
  });

  describe("repeat-offense escalation (#unlinked-issue-guardrail-followup)", () => {
    it("escalates to a CLOSE on a second confirmed match by the SAME contributor on a different PR", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
      const env = createTestEnv({ AI: { run } as unknown as Ai });
      await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");

      const first = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config() });
      expect(first?.kind).toBe("hold");

      const second = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, pullNumber: 102, config: config() });
      expect(second?.kind).toBe("close");
      expect(second?.reason).toContain("#7");
      expect(second?.reason).toContain("repeat");
      expect(second?.comment).toContain("already flagged");
    });

    it("does NOT escalate when the same confirmed PR is reprocessed", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
      const env = createTestEnv({ AI: { run } as unknown as Ai });
      await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");

      const first = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, pullNumber: 101, config: config() });
      expect(first?.kind).toBe("hold");

      const replay = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, pullNumber: 101, config: config() });
      expect(replay?.kind).toBe("hold");
    });

    it("does NOT escalate a second match by a DIFFERENT contributor", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
      const env = createTestEnv({ AI: { run } as unknown as Ai });
      await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");

      const first = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, prAuthorLogin: "contributor-a", config: config() });
      expect(first?.kind).toBe("hold");

      const second = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, prAuthorLogin: "contributor-b", config: config() });
      expect(second?.kind).toBe("hold");
    });

    it("never escalates when the PR author is unknown (null), even across repeated calls", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
      const env = createTestEnv({ AI: { run } as unknown as Ai });
      await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");

      const first = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, prAuthorLogin: null, config: config() });
      expect(first?.kind).toBe("hold");
      const second = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, prAuthorLogin: null, config: config() });
      expect(second?.kind).toBe("hold");
    });

    it("escalates a repeat even across DIFFERENT repos (the ledger is scoped to the contributor, not one repo)", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
      const env = createTestEnv({ AI: { run } as unknown as Ai });
      await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
      await upsertIssueFromGitHub(env, "owner/other-repo", { number: 7, title: "webhook retry duplicate bug", state: "open", user: { login: "someone" }, labels: [], body: "retries duplicate events under load, needs a dedup key" });

      const first = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config() });
      expect(first?.kind).toBe("hold");

      const second = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, repoFullName: "owner/other-repo", pullNumber: 101, config: config() });
      expect(second?.kind).toBe("close");
    });

    it("fails open (stays a hold, never throws) when the prior-match read itself errors", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
      const env = createTestEnv({ AI: { run } as unknown as Ai });
      await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
      const realPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = ((sql: string) => {
        if (/SELECT.*FROM.*audit_events/i.test(sql)) throw new Error("d1 down");
        return realPrepare(sql);
      }) as typeof env.DB.prepare;
      const result = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config() });
      expect(result?.kind).toBe("hold");
    });

    it("swallows a write failure when recording the occurrence — the hold/close verdict is unaffected", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
      const env = createTestEnv({ AI: { run } as unknown as Ai });
      await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");
      const realPrepare = env.DB.prepare.bind(env.DB);
      env.DB.prepare = ((sql: string) => {
        if (/INSERT INTO.*audit_events/i.test(sql)) throw new Error("d1 down");
        return realPrepare(sql);
      }) as typeof env.DB.prepare;
      const result = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, config: config() });
      expect(result?.kind).toBe("hold");
    });

    it("does not record an occurrence (and cannot escalate later) when the author login is only whitespace", async () => {
      const run = vi.fn(async () => ({ response: JSON.stringify(aiVerdict()) }));
      const env = createTestEnv({ AI: { run } as unknown as Ai });
      await seedIssue(env, 7, "webhook retry duplicate bug", "retries duplicate events under load, needs a dedup key");

      const first = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, prAuthorLogin: "   ", config: config() });
      expect(first?.kind).toBe("hold");
      const second = await resolveUnlinkedIssueMatchDisposition(env, { ...BASE_INPUT, prAuthorLogin: "   ", config: config() });
      expect(second?.kind).toBe("hold");
    });
  });
});
