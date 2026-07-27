import { describe, expect, it, vi } from "vitest";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import {
  PENDING_CLOSURE_GRACE_MS,
  PENDING_CLOSURE_LOOKBACK_MS,
  PENDING_CLOSURE_REQUEUE_INTERVAL_MS,
  recordPendingClosureFlag,
  sweepStrandedPendingClosures,
} from "../../src/review/pending-closure-watchdog";
import { createTestEnv } from "../helpers/d1";

function envWithQueue(): { env: Env; sent: unknown[] } {
  const sent: unknown[] = [];
  const env = createTestEnv();
  (env as unknown as { JOBS: { send: (msg: unknown) => Promise<void> } }).JOBS = {
    send: async (msg: unknown) => void sent.push(msg),
  };
  return { env, sent };
}

async function seedPr(env: Env, number: number, state: string): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: 88, account: { login: "alice", id: 88, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["pull_request"] },
  });
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "alice/repo", private: false, owner: { login: "alice" } }, 88);
  await upsertPullRequestFromGitHub(env, "alice/repo", { number, title: "PR", state, user: { login: "bob" }, head: { sha: "s1" }, labels: [], body: "b" });
}

// #9031: Pass 1 applies the pending-closure label and enqueues ONE delayed job to run Pass 2. That message was
// the only thing that could finish the sequence — and the documented "next sweep / CI event" backstop is
// vacuous, because #never-endless-reregate makes an already-regated PR permanently sweep-ineligible while the
// flag itself suppresses merge and approve. Lose the message and the PR is stranded for good.
describe("sweepStrandedPendingClosures (#9031)", () => {
  const PAST_DUE = (now: number) => now - PENDING_CLOSURE_GRACE_MS - 60_000;

  it("re-enqueues Pass 2 for a flag whose deadline passed with the PR still open", async () => {
    const { env, sent } = envWithQueue();
    await seedPr(env, 11, "open");
    const now = Date.now();
    await recordPendingClosureFlag(env, { repoFullName: "alice/repo", pullNumber: 11, installationId: 88 }, PAST_DUE(now));

    expect(await sweepStrandedPendingClosures(env, now)).toEqual({ scanned: 1, requeued: 1 });
    expect(sent).toEqual([
      { type: "recapture-preview", deliveryId: "linked-issue-verify:alice/repo#11", repoFullName: "alice/repo", prNumber: 11, installationId: 88, attempt: 0 },
    ]);
  });

  it("waits out the grace period, so a job merely queued behind a busy backlog is not mistaken for a lost one", async () => {
    const { env, sent } = envWithQueue();
    await seedPr(env, 12, "open");
    const now = Date.now();
    await recordPendingClosureFlag(env, { repoFullName: "alice/repo", pullNumber: 12, installationId: 88 }, now - 1000);

    expect(await sweepStrandedPendingClosures(env, now)).toEqual({ scanned: 1, requeued: 0 });
    expect(sent).toEqual([]);
  });

  it("leaves a PR that already reached a terminal state alone", async () => {
    const { env, sent } = envWithQueue();
    await seedPr(env, 13, "closed");
    const now = Date.now();
    await recordPendingClosureFlag(env, { repoFullName: "alice/repo", pullNumber: 13, installationId: 88 }, PAST_DUE(now));

    expect(await sweepStrandedPendingClosures(env, now)).toEqual({ scanned: 1, requeued: 0 });
    expect(sent).toEqual([]);
  });

  it("does not rescue the same PR on every tick — a PR stuck for another reason is retried periodically", async () => {
    const { env, sent } = envWithQueue();
    await seedPr(env, 14, "open");
    const now = Date.now();
    await recordPendingClosureFlag(env, { repoFullName: "alice/repo", pullNumber: 14, installationId: 88 }, PAST_DUE(now));

    expect((await sweepStrandedPendingClosures(env, now)).requeued).toBe(1);
    expect((await sweepStrandedPendingClosures(env, now + 60_000)).requeued).toBe(0);
    // Past the interval it tries again, rather than giving up on a PR that is genuinely still stranded.
    expect((await sweepStrandedPendingClosures(env, now + PENDING_CLOSURE_REQUEUE_INTERVAL_MS + 1000)).requeued).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("ignores flags older than the lookback window", async () => {
    const { env } = envWithQueue();
    await seedPr(env, 15, "open");
    const now = Date.now();
    await recordPendingClosureFlag(env, { repoFullName: "alice/repo", pullNumber: 15, installationId: 88 }, PAST_DUE(now));

    expect(await sweepStrandedPendingClosures(env, now + PENDING_CLOSURE_LOOKBACK_MS + 60_000)).toEqual({ scanned: 0, requeued: 0 });
  });

  it("falls back to the flag's own timestamp when the recorded deadline is unreadable", async () => {
    const { env, sent } = envWithQueue();
    await seedPr(env, 16, "open");
    await env.DB.prepare("INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(
        crypto.randomUUID(),
        "agent.linked_issue.pending_closure_flagged",
        "loopover",
        "alice/repo#16",
        "queued",
        "flagged",
        JSON.stringify({ repoFullName: "alice/repo", pullNumber: 16, installationId: 88, dueAt: "not-a-date" }),
        new Date(Date.now() - 3 * PENDING_CLOSURE_GRACE_MS).toISOString(),
      )
      .run();

    // Refusing to rescue a real flag because its metadata is malformed would recreate the exact stranding
    // this watchdog exists to end.
    expect((await sweepStrandedPendingClosures(env)).requeued).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("skips a flag whose metadata cannot identify a PR at all", async () => {
    const { env, sent } = envWithQueue();
    await env.DB.prepare("INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), "agent.linked_issue.pending_closure_flagged", "loopover", "alice/repo#17", "queued", "flagged", JSON.stringify({ repoFullName: "alice/repo" }), new Date().toISOString())
      .run();

    expect(await sweepStrandedPendingClosures(env)).toEqual({ scanned: 1, requeued: 0 });
    expect(sent).toEqual([]);
  });

  it("does not count a rescue whose enqueue failed", async () => {
    const { env } = envWithQueue();
    await seedPr(env, 18, "open");
    const now = Date.now();
    await recordPendingClosureFlag(env, { repoFullName: "alice/repo", pullNumber: 18, installationId: 88 }, PAST_DUE(now));
    (env as unknown as { JOBS: { send: () => Promise<void> } }).JOBS = { send: async () => Promise.reject(new Error("queue down")) };

    expect(await sweepStrandedPendingClosures(env, now)).toEqual({ scanned: 1, requeued: 0 });
    // And nothing was recorded, so the next tick retries rather than believing it already rescued this PR.
    expect((await sweepStrandedPendingClosures(env, now + 1000)).scanned).toBe(1);
  });

  it("returns an empty result instead of throwing when the scan fails", async () => {
    const { env } = envWithQueue();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repositories = await import("../../src/db/repositories");
    vi.spyOn(repositories, "listAuditEventsByType").mockRejectedValue(new Error("db unavailable"));

    expect(await sweepStrandedPendingClosures(env)).toEqual({ scanned: 0, requeued: 0 });
    expect(warn.mock.calls.some(([line]) => String(line).includes("pending_closure_sweep_scan_failed"))).toBe(true);
    vi.restoreAllMocks();
  });
});
