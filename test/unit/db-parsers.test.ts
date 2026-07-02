import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimRegateFanoutSlot,
  countRecentDeadLetters,
  countRecentDeadLettersByType,
  countRecentAuditEventsForActorAndTarget,
  getLatestScorePreview,
  getRepoAuthorPullRequestHistory,
  getLatestScoringModelSnapshot,
  getFreshOfficialMinerDetection,
  listPullRequests,
  listPullRequestDetailSyncStates,
  listRepoSyncSegments,
  listRepoSyncStates,
  markPullRequestRegated,
  markPullRequestsRegated,
  markPullRequestSurfacePublished,
  recordAuditEvent,
  recordWebhookEvent,
  upsertOfficialMinerDetection,
  upsertPullRequestFromGitHub,
  extractLinkedIssueNumbers,
  extractLinkedIssueNumbersWithOverflow,
  MAX_LINKED_ISSUE_NUMBERS,
} from "../../src/db/repositories";
import { getDb } from "../../src/db/client";
import { webhookEvents } from "../../src/db/schema";
import { createTestEnv } from "../helpers/d1";

describe("database row parser hardening", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps linked issues extracted from attacker-controlled PR bodies and reports overflow", () => {
    const body = Array.from({ length: MAX_LINKED_ISSUE_NUMBERS + 25 }, (_, index) => `Fixes #${index + 1}`).join("\n");

    expect(extractLinkedIssueNumbers(body)).toEqual(Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => index + 1));
    expect(extractLinkedIssueNumbersWithOverflow(body)).toEqual({
      numbers: Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => index + 1),
      overflow: true,
    });
  });

  it("deduplicates linked issues before applying the extraction cap", () => {
    const body = [`Fixes #1`, ...Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => `Resolves #${index + 1}`)].join("\n");

    expect(extractLinkedIssueNumbers(body)).toEqual(Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => index + 1));
    expect(extractLinkedIssueNumbersWithOverflow(body).overflow).toBe(false);
  });

  it("returns no linked issues when the cap is zero or negative", () => {
    expect(extractLinkedIssueNumbers("Fixes #1\nCloses #2", 0)).toEqual([]);
    expect(extractLinkedIssueNumbers("Fixes #1", -5)).toEqual([]);
  });

  it("returns empty arrays from D1 raw() when a select has no rows", async () => {
    const env = createTestEnv();
    const rows = await env.DB.prepare("select id from installations where 1 = 0").raw();
    expect(rows).toEqual([]);
  });

  it("preserves cached pull request review and mergeability scenario fields", async () => {
    const env = createTestEnv();

    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 1,
      title: "Blocked branch",
      state: "open",
      draft: true,
      mergeable: false,
      reviewDecision: "CHANGES_REQUESTED",
      user: { login: "oktofeesh1" },
      labels: [{ name: "bug" }],
      body: "Fixes #7",
    });
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 2,
      title: "Mergeable branch",
      state: "open",
      isDraft: false,
      mergeable: true,
      reviewDecision: "APPROVED",
      user: { login: "oktofeesh1" },
      labels: [],
      body: null,
    });

    await expect(listPullRequests(env, "owner/repo")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: 1, isDraft: true, mergeableState: "blocked", reviewDecision: "CHANGES_REQUESTED", linkedIssues: [7] }),
        expect.objectContaining({ number: 2, isDraft: false, mergeableState: "mergeable", reviewDecision: "APPROVED" }),
      ]),
    );
  });

  it("REGRESSION: adding another linked issue resets the PR-level claim time", async () => {
    const env = createTestEnv();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T10:00:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 11,
      title: "First claim",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #1",
    });
    const first = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 11);

    vi.setSystemTime(new Date("2026-06-29T10:02:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 11,
      title: "Same claim",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #1",
    });
    const same = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 11);
    expect(same).toMatchObject({
      linkedIssues: [1],
      linkedIssueClaimedAt: first?.linkedIssueClaimedAt,
    });

    vi.setSystemTime(new Date("2026-06-29T10:05:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 11,
      title: "Expanded claim",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #1\nFixes #2",
    });
    const expanded = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 11);

    expect(expanded).toMatchObject({
      title: "Expanded claim",
      linkedIssues: [1, 2],
      linkedIssueClaimedAt: "2026-06-29T10:05:00.000Z",
    });

    vi.setSystemTime(new Date("2026-06-29T10:07:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 11,
      title: "Reordered expanded claim",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #2\nFixes #1",
    });
    const reordered = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 11);
    expect(reordered).toMatchObject({
      title: "Reordered expanded claim",
      linkedIssues: [2, 1],
      linkedIssueClaimedAt: expanded?.linkedIssueClaimedAt,
    });

    vi.setSystemTime(new Date("2026-06-29T10:10:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 11,
      title: "Disjoint claim",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #3",
    });
    const disjoint = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 11);

    expect(disjoint).toMatchObject({
      linkedIssues: [3],
      linkedIssueClaimedAt: "2026-06-29T10:10:00.000Z",
    });

    vi.setSystemTime(new Date("2026-06-29T10:15:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 11,
      title: "Cleared claim",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "No issue link now.",
    });
    const cleared = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 11);
    expect(cleared).toMatchObject({
      linkedIssues: [],
      linkedIssueClaimedAt: null,
    });
  });

  it("falls back to the observed linked-issue claim time when the existing same-claim timestamp is missing", async () => {
    const env = createTestEnv();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T11:00:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 12,
      title: "Missing claim timestamp",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #7",
    });
    await env.DB.prepare("UPDATE pull_requests SET linked_issue_claimed_at = NULL WHERE repo_full_name = ? AND number = ?").bind("owner/repo", 12).run();

    vi.setSystemTime(new Date("2026-06-29T11:03:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 12,
      title: "Same claim with repaired timestamp",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #7",
    });

    const repaired = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 12);
    expect(repaired).toMatchObject({
      linkedIssues: [7],
      linkedIssueClaimedAt: "2026-06-29T11:03:00.000Z",
    });
  });

  it("repairs sparse non-array linked issue cache rows without throwing", async () => {
    const env = createTestEnv();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T11:10:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 13,
      title: "Sparse cached claim",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #8",
    });
    await env.DB.prepare("UPDATE pull_requests SET linked_issues_json = ? WHERE repo_full_name = ? AND number = ?")
      .bind("{}", "owner/repo", 13)
      .run();

    vi.setSystemTime(new Date("2026-06-29T11:12:00.000Z"));
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 13,
      title: "Sparse cached claim repaired",
      state: "open",
      user: { login: "alice" },
      labels: [],
      body: "Fixes #8",
    });

    const repaired = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 13);
    expect(repaired).toMatchObject({
      title: "Sparse cached claim repaired",
      linkedIssues: [8],
      linkedIssueClaimedAt: "2026-06-29T11:12:00.000Z",
    });
  });

  it("markPullRequestRegated stamps the internal last_regated_at marker (sweep convergence #audit-sweep-converge)", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 5, title: "Stale PR", state: "open", user: { login: "alice" }, labels: [] });

    const before = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 5);
    expect(before?.lastRegatedAt ?? null).toBeNull(); // never swept yet → marker absent

    await markPullRequestRegated(env, "owner/repo", 5);
    const after = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 5);
    expect(typeof after?.lastRegatedAt).toBe("string"); // marker stamped with an ISO timestamp
    expect(after?.title).toBe("Stale PR"); // INVARIANT: a plain D1 UPDATE — it touches only the marker, not PR content
  });

  it("markPullRequestSurfacePublished stamps last_published_surface_sha only at the matching live head (#4 over-publish dedup)", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 9, title: "PR", state: "open", user: { login: "alice" }, head: { sha: "headA" }, labels: [] });

    const before = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 9);
    expect(before?.lastPublishedSurfaceSha ?? null).toBeNull(); // never published → marker absent

    await markPullRequestSurfacePublished(env, "owner/repo", 9, null); // null head → no-op (the !headSha guard)
    expect((await listPullRequests(env, "owner/repo")).find((p) => p.number === 9)?.lastPublishedSurfaceSha ?? null).toBeNull();

    await markPullRequestSurfacePublished(env, "owner/repo", 9, "oldHead"); // stale head → WHERE head_sha mismatch → no-op
    expect((await listPullRequests(env, "owner/repo")).find((p) => p.number === 9)?.lastPublishedSurfaceSha ?? null).toBeNull();

    await markPullRequestSurfacePublished(env, "owner/repo", 9, "headA"); // matches the live head → stamps
    const after = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 9);
    expect(after?.lastPublishedSurfaceSha).toBe("headA");
    expect(after?.title).toBe("PR"); // INVARIANT: touches only the marker, not PR content
  });

  it("markPullRequestsRegated batch-stamps every candidate at dispatch and no-ops on an empty list (#audit-sweep-dispatch-stamp)", async () => {
    const env = createTestEnv();
    for (const number of [5, 6, 7]) {
      await upsertPullRequestFromGitHub(env, "owner/repo", { number, title: `PR${number}`, state: "open", user: { login: "alice" }, labels: [] });
    }

    await markPullRequestsRegated(env, "owner/repo", []); // empty → no-op (early return)
    expect((await listPullRequests(env, "owner/repo")).every((p) => (p.lastRegatedAt ?? null) === null)).toBe(true);

    await markPullRequestsRegated(env, "owner/repo", [5, 7]); // batch stamps only 5 and 7
    const rows = await listPullRequests(env, "owner/repo");
    expect(typeof rows.find((p) => p.number === 5)?.lastRegatedAt).toBe("string");
    expect(typeof rows.find((p) => p.number === 7)?.lastRegatedAt).toBe("string");
    expect(rows.find((p) => p.number === 6)?.lastRegatedAt ?? null).toBeNull(); // #6 not in the batch → untouched
  });

  it("claimRegateFanoutSlot collapses a burst to one winner per window (#audit-fanout-dedup)", async () => {
    const env = createTestEnv();
    const W = 90 * 1000;
    expect(await claimRegateFanoutSlot(env, "2026-06-25T01:00:00.000Z", W)).toBe(true); // first claim wins (marker NULL)
    expect(await claimRegateFanoutSlot(env, "2026-06-25T01:00:05.000Z", W)).toBe(false); // +5s, inside window → loses
    expect(await claimRegateFanoutSlot(env, "2026-06-25T01:00:50.000Z", W)).toBe(false); // +50s, still inside → loses
    expect(await claimRegateFanoutSlot(env, "2026-06-25T01:01:31.000Z", W)).toBe(true); // +91s, outside window → wins again
    expect(await claimRegateFanoutSlot(env, "2026-06-25T01:01:40.000Z", W)).toBe(false); // back inside the new window → loses
  });

  it("REGRESSION: recordWebhookEvent updates payload_hash when processing an existing queued delivery", async () => {
    const env = createTestEnv();
    await recordWebhookEvent(env, { deliveryId: "foreign-app-queued", eventName: "pull_request", payloadHash: "raw-sha", status: "queued" });

    await recordWebhookEvent(env, { deliveryId: "foreign-app-queued", eventName: "pull_request", payloadHash: "foreign_app", status: "processed" });

    const row = await env.DB.prepare("select payload_hash, status from webhook_events where delivery_id = ?")
      .bind("foreign-app-queued")
      .first<{ payload_hash: string; status: string }>();
    expect(row).toEqual({ payload_hash: "foreign_app", status: "processed" });
  });

  it("REGRESSION: webhook_events.received_at is always a real ISO timestamp, never the 'CURRENT_TIMESTAMP' literal (#audit-ts-literal)", async () => {
    const env = createTestEnv();
    // Real path: recordWebhookEvent always passes nowIso().
    await recordWebhookEvent(env, { deliveryId: "ts-1", eventName: "pull_request", payloadHash: "h", status: "queued" });
    const r1 = await env.DB.prepare("select received_at from webhook_events where delivery_id = 'ts-1'").first<{ received_at: string }>();
    expect(r1?.received_at).not.toBe("CURRENT_TIMESTAMP");
    expect(Number.isFinite(Date.parse(r1?.received_at ?? "not-a-date"))).toBe(true);
    // Backstop: a Drizzle insert that OMITS received_at must hit the $defaultFn (real ISO), not a static-default
    // literal — this is the exact omit path that corrupted ~20,472 rows before the schema was switched to $defaultFn.
    const db = getDb(env.DB);
    await db.insert(webhookEvents).values({ deliveryId: "ts-2", eventName: "issues", payloadHash: "h2", status: "queued" });
    const r2 = await env.DB.prepare("select received_at from webhook_events where delivery_id = 'ts-2'").first<{ received_at: string }>();
    expect(r2?.received_at).not.toBe("CURRENT_TIMESTAMP");
    expect(Number.isFinite(Date.parse(r2?.received_at ?? "not-a-date"))).toBe(true);
  });

  it("claimRegateFanoutSlot fails open (returns true) on a DB error so the fleet never stalls", async () => {
    const env = createTestEnv();
    const broken = { ...env, DB: null } as unknown as typeof env;
    expect(await claimRegateFanoutSlot(broken, "2026-06-25T01:00:00.000Z", 90 * 1000)).toBe(true);
  });

  it("REGRESSION: a later GitHub sync does NOT clobber last_regated_at (omitted from the upsert SET clause)", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 6, title: "First", state: "open", user: { login: "bob" }, labels: [] });
    await markPullRequestRegated(env, "owner/repo", 6);
    const stamped = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 6)?.lastRegatedAt;
    expect(typeof stamped).toBe("string");

    // A subsequent GitHub-sync upsert (new title) must NOT reset the sweep marker, or the sweep would loop again.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 6, title: "Synced again", state: "open", user: { login: "bob" }, labels: [] });
    const resynced = (await listPullRequests(env, "owner/repo")).find((p) => p.number === 6);
    expect(resynced?.title).toBe("Synced again"); // the sync ran
    expect(resynced?.lastRegatedAt).toBe(stamped); // but the marker survived
  });

  it("countRecentDeadLetters counts github_app.dlq_dead_lettered audits since a cutoff, independent of any ops flag (#1276)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, { eventType: "github_app.dlq_dead_lettered", actor: "gittensory", targetKey: "dlq:github-webhook:a", outcome: "error", createdAt: "2026-06-24T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.dlq_dead_lettered", actor: "gittensory", targetKey: "dlq:backfill-repo-segment:b", outcome: "error", createdAt: "2026-06-24T12:00:00.000Z" });
    // An unrelated audit event must NOT be counted (the event-type filter).
    await recordAuditEvent(env, { eventType: "agent.sweep.regate", actor: "gittensory", targetKey: "owner/repo", outcome: "completed", createdAt: "2026-06-24T12:00:00.000Z" });

    expect(await countRecentDeadLetters(env, "2026-06-24T09:00:00.000Z")).toBe(2); // both dead-letters in window
    expect(await countRecentDeadLetters(env, "2026-06-24T11:00:00.000Z")).toBe(1); // only the 12:00 one
    expect(await countRecentDeadLetters(env, "2026-06-24T13:00:00.000Z")).toBe(0); // none after the cutoff → count(*) returns 0
  });

  it("countRecentDeadLettersByType groups recent dead letters by job type in deterministic key order (#1208)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "gittensory",
      targetKey: "dlq:github-webhook:a",
      outcome: "error",
      createdAt: "2026-06-24T12:00:00.000Z",
      metadata: { jobType: "github-webhook" },
    });
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "gittensory",
      targetKey: "dlq:backfill-repo-segment:b",
      outcome: "error",
      createdAt: "2026-06-24T10:00:00.000Z",
      metadata: { jobType: "backfill-repo-segment" },
    });
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "gittensory",
      targetKey: "dlq:github-webhook:c",
      outcome: "error",
      createdAt: "2026-06-24T14:00:00.000Z",
      metadata: { jobType: "github-webhook" },
    });

    const counts = await countRecentDeadLettersByType(env, "2026-06-24T09:00:00.000Z");
    expect(counts).toEqual({
      "backfill-repo-segment": 1,
      "github-webhook": 2,
    });
    expect(Object.keys(counts)).toEqual(["backfill-repo-segment", "github-webhook"]);
  });

  it("countRecentDeadLettersByType returns a single grouped key when only one job type is present", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "gittensory",
      targetKey: "dlq:refresh-registry:a",
      outcome: "error",
      createdAt: "2026-06-24T10:00:00.000Z",
      metadata: { jobType: "refresh-registry" },
    });
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "gittensory",
      targetKey: "dlq:refresh-registry:b",
      outcome: "error",
      createdAt: "2026-06-24T11:00:00.000Z",
      metadata: { jobType: "refresh-registry" },
    });

    expect(await countRecentDeadLettersByType(env, "2026-06-24T09:00:00.000Z")).toEqual({
      "refresh-registry": 2,
    });
  });

  it("countRecentDeadLettersByType returns an empty object when no recent dead letters exist", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "agent.sweep.regate",
      actor: "gittensory",
      targetKey: "owner/repo",
      outcome: "completed",
      createdAt: "2026-06-24T12:00:00.000Z",
    });

    expect(await countRecentDeadLettersByType(env, "2026-06-24T09:00:00.000Z")).toEqual({});
  });

  it("countRecentDeadLettersByType falls back missing or blank job types to unknown", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "gittensory",
      targetKey: "dlq:unknown:a",
      outcome: "error",
      createdAt: "2026-06-24T10:00:00.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "gittensory",
      targetKey: "dlq:unknown:b",
      outcome: "error",
      createdAt: "2026-06-24T11:00:00.000Z",
      metadata: { jobType: "   " },
    });

    expect(await countRecentDeadLettersByType(env, "2026-06-24T09:00:00.000Z")).toEqual({
      unknown: 2,
    });
  });

  it("countRecentAuditEventsForActorAndTarget counts events scoped to ONE actor+eventType+targetKey since a cutoff (#2463)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/repo#1", outcome: "completed", createdAt: "2026-06-24T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/repo#1", outcome: "completed", createdAt: "2026-06-24T12:00:00.000Z" });
    // A different actor on the SAME target must not be counted (the actor filter).
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "someone-else", targetKey: "owner/repo#1", outcome: "completed", createdAt: "2026-06-24T12:00:00.000Z" });
    // The SAME actor pinging a DIFFERENT PR/issue must not be counted (the targetKey filter).
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/repo#2", outcome: "completed", createdAt: "2026-06-24T12:00:00.000Z" });
    // An unrelated event type on the same actor+target must not be counted (the eventType filter).
    await recordAuditEvent(env, { eventType: "github_app.agent_command_replied", actor: "chatty", targetKey: "owner/repo#1", outcome: "completed", createdAt: "2026-06-24T12:00:00.000Z" });

    expect(await countRecentAuditEventsForActorAndTarget(env, "chatty", "github_app.review_nag_ping", "owner/repo#1", "2026-06-24T09:00:00.000Z")).toBe(2);
    expect(await countRecentAuditEventsForActorAndTarget(env, "chatty", "github_app.review_nag_ping", "owner/repo#1", "2026-06-24T11:00:00.000Z")).toBe(1); // only the 12:00 one
    expect(await countRecentAuditEventsForActorAndTarget(env, "chatty", "github_app.review_nag_ping", "owner/repo#1", "2026-06-24T13:00:00.000Z")).toBe(0); // none after the cutoff → count(*) returns 0
  });

  it("computes complete case-insensitive repo author PR history for gate grace", async () => {
    const env = createTestEnv();

    for (let number = 1; number <= 503; number += 1) {
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number,
        title: `PR ${number}`,
        state: number <= 3 ? "closed" : "open",
        user: { login: number <= 3 ? "RepeatUser" : `other-${number}` },
        labels: [],
      });
    }
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 600,
      title: "Merged work",
      state: "closed",
      merged_at: "2025-01-01T00:00:00.000Z",
      user: { login: "RepeatUser" },
      labels: [],
    });

    await expect(getRepoAuthorPullRequestHistory(env, "owner/repo", "repeatuser", 999)).resolves.toEqual({
      mergedPrCount: 1,
      closedUnmergedPrCount: 3,
    });
    await expect(getRepoAuthorPullRequestHistory(env, "owner/repo", "repeatuser", 600)).resolves.toEqual({
      mergedPrCount: 0,
      closedUnmergedPrCount: 3,
    });
  });

  it("normalizes enum-like database values from stored sync, scoring, and preview rows", async () => {
    const env = createTestEnv();

    for (const [repo, status, source] of [
      ["owner/skipped", "skipped", "installation"],
      ["owner/capped", "capped", "test"],
      ["owner/rate", "rate_limited", "unknown-source"],
      ["owner/stale", "stale", "github"],
      ["owner/bad", "not-a-real-status", "bad-source"],
    ]) {
      await env.DB.prepare(
        `insert into repo_sync_state (
          repo_full_name, status, source_kind, open_issues_count, open_pull_requests_count,
          recent_merged_pull_requests_count, warnings_json
        ) values (?, ?, ?, 0, 0, 0, '[]')`,
      )
        .bind(repo, status, source)
        .run();
    }

    for (const [segment, status, mode] of [
      ["recent_merged_pull_requests", "sampled", "full"],
      ["pull_request_files", "waiting_rate_limit", "resume"],
      ["pull_request_reviews", "error", "bad-mode"],
      ["check_summaries", "not_modified", "light"],
      ["bad-segment", "bad-status", "bad-mode"],
    ]) {
      await env.DB.prepare(
        `insert into repo_sync_segments (
          id, repo_full_name, segment, status, source_kind, mode, fetched_count, page_count, warnings_json
        ) values (?, 'owner/repo', ?, ?, 'github', ?, 0, 0, '[]')`,
      )
        .bind(`segment-${segment}-${status}`, segment, status, mode)
        .run();
    }

    for (const [pullNumber, status] of [
      [1, "waiting_rate_limit"],
      [2, "error"],
      [3, "bad-status"],
    ] as const) {
      await env.DB.prepare(
        `insert into pull_request_detail_sync_state (
          id, repo_full_name, pull_number, status
        ) values (?, 'owner/repo', ?, ?)`,
      )
        .bind(`detail-${pullNumber}`, pullNumber, status)
        .run();
    }

    await env.DB.prepare(
      `insert into scoring_model_snapshots (
        id, source_kind, source_url, fetched_at, active_model, constants_json,
        programming_languages_json, warnings_json, payload_json
      ) values ('score-model', 'bad-source', 'fixture://model', '2026-05-25T00:00:00.000Z', 'bad-model', '{}', '{}', '[]', '{}')`,
    ).run();

    for (const [targetType, generatedAt] of [
      ["pull_request", "2026-05-25T00:00:01.000Z"],
      ["local_diff", "2026-05-25T00:00:02.000Z"],
      ["variant", "2026-05-25T00:00:03.000Z"],
      ["bad-target", "2026-05-25T00:00:04.000Z"],
    ]) {
      await env.DB.prepare(
        `insert into score_previews (
          id, scoring_model_snapshot_id, repo_full_name, target_type, target_key,
          input_json, result_json, generated_at
        ) values (?, 'score-model', 'owner/repo', ?, ?, '{}', '{}', ?)`,
      )
        .bind(`preview-${targetType}`, targetType, `target-${targetType}`, generatedAt)
        .run();
    }

    expect(await listRepoSyncStates(env)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoFullName: "owner/skipped", status: "skipped", sourceKind: "installation" }),
        expect.objectContaining({ repoFullName: "owner/capped", status: "capped", sourceKind: "test" }),
        expect.objectContaining({ repoFullName: "owner/rate", status: "rate_limited", sourceKind: "github" }),
        expect.objectContaining({ repoFullName: "owner/stale", status: "stale" }),
        expect.objectContaining({ repoFullName: "owner/bad", status: "never_synced", sourceKind: "github" }),
      ]),
    );
    expect(await listRepoSyncSegments(env, "owner/repo")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ segment: "recent_merged_pull_requests", status: "sampled", mode: "full" }),
        expect.objectContaining({ segment: "pull_request_files", status: "waiting_rate_limit", mode: "resume" }),
        expect.objectContaining({ segment: "pull_request_reviews", status: "error", mode: "light" }),
        expect.objectContaining({ segment: "check_summaries", status: "not_modified" }),
        expect.objectContaining({ segment: "metadata", status: "never_synced", mode: "light" }),
      ]),
    );
    expect(await listPullRequestDetailSyncStates(env, "owner/repo")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pullNumber: 1, status: "waiting_rate_limit" }),
        expect.objectContaining({ pullNumber: 2, status: "error" }),
        expect.objectContaining({ pullNumber: 3, status: "never_synced" }),
      ]),
    );
    expect(await getLatestScoringModelSnapshot(env)).toMatchObject({ sourceKind: "fallback", activeModel: "unknown" });
    await expect(getLatestScorePreview(env, "owner/repo", "target-pull_request")).resolves.toMatchObject({ targetType: "pull_request" });
    await expect(getLatestScorePreview(env, "owner/repo", "target-local_diff")).resolves.toMatchObject({ targetType: "local_diff" });
    await expect(getLatestScorePreview(env, "owner/repo", "target-variant")).resolves.toMatchObject({ targetType: "variant" });
    await expect(getLatestScorePreview(env, "owner/repo", "target-bad-target")).resolves.toMatchObject({ targetType: "planned_pr" });
    await expect(getLatestScorePreview(env, "owner/repo", "missing")).resolves.toBeNull();
  });

  it("fails closed for malformed or incomplete cached official miner detections", async () => {
    const env = createTestEnv();
    for (const [login, status, snapshotJson, error] of [
      ["broken", "confirmed", "{}", null],
      ["outage", "unavailable", "{}", null],
    ]) {
      await env.DB.prepare(
        `insert into official_miner_detections (
          login, status, snapshot_json, error, fetched_at, expires_at, updated_at
        ) values (?, ?, ?, ?, '2026-05-29T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-05-29T00:00:00.000Z')`,
      )
        .bind(login, status, snapshotJson, error)
        .run();
    }

    await expect(getFreshOfficialMinerDetection(env, "missing")).resolves.toBeNull();
    await expect(getFreshOfficialMinerDetection(env, "broken")).resolves.toEqual({ status: "unavailable", error: "cached Gittensor miner snapshot is invalid" });
    await expect(getFreshOfficialMinerDetection(env, "outage")).resolves.toEqual({ status: "unavailable", error: "cached Gittensor API unavailable" });
  });

  it("allowlists cached official miner snapshot fields", async () => {
    const env = createTestEnv();
    await upsertOfficialMinerDetection(
      env,
      "oktofeesh1",
      {
        status: "confirmed",
        snapshot: {
          source: "gittensor_api",
          githubId: "123",
          githubUsername: "oktofeesh1",
          uid: 7,
          hotkey: "must-not-cache",
          wallet: "must-not-cache",
          coldkey: "must-not-cache",
          failedReason: "needs more history",
          evaluatedAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:01:00.000Z",
          isEligible: true,
          credibility: 1,
          eligibleRepoCount: 1,
          issueDiscoveryScore: 0,
          issueTokenScore: 0,
          issueCredibility: 1,
          isIssueEligible: false,
          issueEligibleRepoCount: 0,
          alphaPerDay: 0,
          taoPerDay: 0,
          usdPerDay: 0,
          totals: {
            pullRequests: 1,
            mergedPullRequests: 1,
            openPullRequests: 0,
            closedPullRequests: 0,
            openIssues: 0,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
          },
          repositories: [
            {
              repoFullName: "JSONbored/gittensory",
              pullRequests: 1,
              mergedPullRequests: 1,
              openPullRequests: 0,
              closedPullRequests: 0,
              openIssues: 0,
              closedIssues: 0,
              solvedIssues: 0,
              validSolvedIssues: 0,
              isEligible: true,
              isIssueEligible: false,
              credibility: 1,
              issueCredibility: 1,
              totalScore: 0,
              baseTotalScore: 0,
              hotkey: "must-not-cache",
            },
            { wallet: "must-not-cache" },
          ],
          pullRequests: [
            {
              repoFullName: "JSONbored/gittensory",
              number: 1,
              title: "Fix cache",
              state: "open",
              mergedAt: "2026-05-29T00:00:00.000Z",
              label: "bug",
              score: 0,
              baseScore: 0,
              tokenScore: 0,
              wallet: "must-not-cache",
            },
            { hotkey: "must-not-cache" },
          ],
          issueLabels: ["bug"],
        } as never,
      },
      60_000,
      Date.parse("2026-05-29T00:00:00.000Z"),
    );

    const raw = await env.DB.prepare("select snapshot_json from official_miner_detections where login = ?").bind("oktofeesh1").first<{ snapshot_json: string }>();
    expect(raw?.snapshot_json).not.toMatch(/hotkey|coldkey|wallet|must-not-cache/i);
    const cached = await getFreshOfficialMinerDetection(env, "oktofeesh1", "2026-05-29T00:00:30.000Z");
    expect(JSON.stringify(cached)).not.toMatch(/hotkey|coldkey|wallet|must-not-cache/i);
    expect(cached).toMatchObject({ status: "confirmed", snapshot: { githubId: "123", githubUsername: "oktofeesh1", uid: 7 } });
  });

  it("normalizes sparse cached official miner snapshots without preserving unknown fields", async () => {
    const env = createTestEnv();
    await upsertOfficialMinerDetection(
      env,
      "minimal",
      {
        status: "confirmed",
        snapshot: {
          source: "gittensor_api",
          githubId: "456",
          githubUsername: "minimal",
          uid: "not-a-number",
          failedReason: null,
          evaluatedAt: 123,
          updatedAt: 123,
          totals: null,
          repositories: "not-an-array",
          pullRequests: "not-an-array",
          issueLabels: ["bug", 7],
          wallet: "must-not-cache",
          hotkey: "must-not-cache",
        } as never,
      },
      60_000,
      Date.parse("2026-05-29T00:00:00.000Z"),
    );

    const cached = await getFreshOfficialMinerDetection(env, "minimal", "2026-05-29T00:00:30.000Z");
    expect(JSON.stringify(cached)).not.toMatch(/hotkey|coldkey|wallet|must-not-cache/i);
    expect(cached).toMatchObject({
      status: "confirmed",
      snapshot: {
        githubId: "456",
        githubUsername: "minimal",
        uid: undefined,
        failedReason: null,
        evaluatedAt: undefined,
        updatedAt: undefined,
        totals: {
          pullRequests: 0,
          mergedPullRequests: 0,
          openPullRequests: 0,
          closedPullRequests: 0,
          openIssues: 0,
          closedIssues: 0,
          solvedIssues: 0,
          validSolvedIssues: 0,
        },
        repositories: [],
        pullRequests: [],
        issueLabels: [],
      },
    });
  });

  it("stores only bounded official miner identity and totals in the cache", async () => {
    const env = createTestEnv();
    await upsertOfficialMinerDetection(
      env,
      "oversized",
      {
        status: "confirmed",
        snapshot: {
          source: "gittensor_api",
          githubId: "7".repeat(200),
          githubUsername: "u".repeat(200),
          failedReason: "f".repeat(600),
          evaluatedAt: "e".repeat(100),
          updatedAt: "u".repeat(100),
          totals: {
            pullRequests: 123,
            mergedPullRequests: 45,
            openPullRequests: 6,
            closedPullRequests: 7,
            openIssues: 8,
            closedIssues: 9,
            solvedIssues: 10,
            validSolvedIssues: 11,
          },
          repositories: Array.from({ length: 200 }, (_, index) => ({ repoFullName: `owner/repo-${index}` })),
          pullRequests: Array.from({ length: 200 }, (_, index) => ({ repoFullName: "owner/repo", number: index, title: "t".repeat(1000) })),
          issueLabels: Array.from({ length: 200 }, (_, index) => `label-${index}`),
        } as never,
      },
      60_000,
      Date.parse("2026-05-29T00:00:00.000Z"),
    );

    const raw = await env.DB.prepare("select snapshot_json from official_miner_detections where login = ?").bind("oversized").first<{ snapshot_json: string }>();
    const cachedSnapshot = JSON.parse(raw?.snapshot_json ?? "{}");

    expect(cachedSnapshot.githubId).toHaveLength(128);
    expect(cachedSnapshot.githubUsername).toHaveLength(128);
    expect(cachedSnapshot.failedReason).toHaveLength(512);
    expect(cachedSnapshot.evaluatedAt).toHaveLength(64);
    expect(cachedSnapshot.updatedAt).toHaveLength(64);
    expect(cachedSnapshot.totals).toMatchObject({ pullRequests: 123, mergedPullRequests: 45, openIssues: 8 });
    expect(cachedSnapshot.repositories).toEqual([]);
    expect(cachedSnapshot.pullRequests).toEqual([]);
    expect(cachedSnapshot.issueLabels).toEqual([]);
    expect(raw?.snapshot_json).not.toContain("owner/repo");
    expect(raw?.snapshot_json).not.toContain("label-199");
  });

  it("drops unknown fields even when cached miner identity fields are missing", async () => {
    const env = createTestEnv();
    await upsertOfficialMinerDetection(
      env,
      "anonymous",
      {
        status: "confirmed",
        snapshot: {
          source: "gittensor_api",
          wallet: "must-not-cache",
          coldkey: "must-not-cache",
          hotkey: "must-not-cache",
          issueLabels: "not-an-array",
        } as never,
      },
      60_000,
      Date.parse("2026-05-29T00:00:00.000Z"),
    );

    const raw = await env.DB.prepare("select snapshot_json from official_miner_detections where login = ?").bind("anonymous").first<{ snapshot_json: string }>();
    expect(raw?.snapshot_json).not.toMatch(/hotkey|coldkey|wallet|must-not-cache/i);
    expect(JSON.parse(raw?.snapshot_json ?? "{}")).toMatchObject({ githubId: "", githubUsername: "", issueLabels: [] });
  });
});
