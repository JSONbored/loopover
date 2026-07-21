import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimMaintainerRecapPeriod,
  claimRegateFanoutSlot,
  claimBacklogConvergenceFanoutSlot,
  countRecentDeadLetters,
  countRecentDeadLettersByType,
  countRecentAuditEventsForActorAndTarget,
  countRecentAuditEventsForActorInRepo,
  countRecentAuditEventsForActorInRepoWithTargetSuffix,
  findHottestInconclusiveReviewTargetForRepo,
  findHottestReviewTargetForRepo,
  hasAuditEventForDelivery,
  hasAuditEventForHeadSha,
  getLatestScorePreview,
  getRepoAuthorPullRequestHistory,
  getLatestScoringModelSnapshot,
  getFreshOfficialMinerDetection,
  getPullRequest,
  listAllPullRequests,
  listPullRequests,
  listPullRequestDetailSyncStates,
  listRepoSyncSegments,
  listRepoSyncStates,
  markPullRequestRegated,
  markPullRequestsRegated,
  markPullRequestsBacklogConvergenceRegated,
  markPullRequestSurfacePublished,
  recordAiUsageEvent,
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

    expect(extractLinkedIssueNumbers(body, "owner/repo")).toEqual(Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => index + 1));
    expect(extractLinkedIssueNumbersWithOverflow(body, "owner/repo")).toEqual({
      numbers: Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => index + 1),
      overflow: true,
    });
  });

  it("deduplicates linked issues before applying the extraction cap", () => {
    const body = [`Fixes #1`, ...Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => `Resolves #${index + 1}`)].join("\n");

    expect(extractLinkedIssueNumbers(body, "owner/repo")).toEqual(Array.from({ length: MAX_LINKED_ISSUE_NUMBERS }, (_, index) => index + 1));
    expect(extractLinkedIssueNumbersWithOverflow(body, "owner/repo").overflow).toBe(false);
  });

  it("returns no linked issues when the cap is zero or negative", () => {
    expect(extractLinkedIssueNumbers("Fixes #1\nCloses #2", "owner/repo", 0)).toEqual([]);
    expect(extractLinkedIssueNumbers("Fixes #1", "owner/repo", -5)).toEqual([]);
  });

  it("REGRESSION: ignores a closing keyword inside an inline code span, e.g. this repo's own PR template checklist example", () => {
    // .github/pull_request_template.md literally contains "(e.g. `Closes #123`)" -- every PR that keeps the
    // unmodified checklist item must NOT spuriously link to issue #123.
    const templateLine = "- [ ] I linked a currently open issue this PR resolves (e.g. `Closes #123`) — a linked open issue is required for every contributor PR.";
    expect(extractLinkedIssueNumbers(templateLine, "owner/repo")).toEqual([]);
    // A real closing keyword elsewhere in the same body still counts.
    expect(extractLinkedIssueNumbers(`Closes #42\n\n${templateLine}`, "owner/repo")).toEqual([42]);
  });

  it("REGRESSION: does not join closing keywords to issue references across inline code spans", () => {
    expect(extractLinkedIssueNumbers("Fixes `not a directive` #42", "owner/repo")).toEqual([]);
    expect(extractLinkedIssueNumbers("Resolves `not a directive` owner/repo#43", "owner/repo")).toEqual([]);
    expect(extractLinkedIssueNumbers("Fixes #7, not `Fixes #8`, and closes #9", "owner/repo")).toEqual([7, 9]);
  });

  it("recognizes the fully-qualified `Fixes owner/repo#N` closing syntax when owner/repo matches this repo (#3862)", () => {
    expect(extractLinkedIssueNumbers("Closes owner/repo#42", "owner/repo")).toEqual([42]);
    // Case-insensitive, matching GitHub's own repo-name matching.
    expect(extractLinkedIssueNumbers("Fixes Owner/Repo#7", "owner/repo")).toEqual([7]);
    // A DIFFERENT repo's qualified reference must not spoof a same-repo linked issue.
    expect(extractLinkedIssueNumbers("Resolves other/repo#99", "owner/repo")).toEqual([]);
    // Bare and qualified forms mix freely and dedupe together.
    expect(extractLinkedIssueNumbers("Fixes #1\nCloses owner/repo#1\nResolves owner/repo#2", "owner/repo")).toEqual([1, 2]);
  });

  it("REGRESSION (#linked-issue-url-form): recognizes the full GitHub issue URL closing form GitHub's own linker also accepts", () => {
    // The exact real-world shape this was missed for: `Closes https://github.com/owner/repo/issues/N`.
    expect(extractLinkedIssueNumbers("Closes https://github.com/owner/repo/issues/5914", "owner/repo")).toEqual([5914]);
    // http (not just https) and a leading www. subdomain are both accepted.
    expect(extractLinkedIssueNumbers("Fixes http://github.com/owner/repo/issues/1", "owner/repo")).toEqual([1]);
    expect(extractLinkedIssueNumbers("Resolves https://www.github.com/owner/repo/issues/2", "owner/repo")).toEqual([2]);
    // Case-insensitive, matching GitHub's own repo-name matching -- same as the qualified `owner/repo#N` form.
    expect(extractLinkedIssueNumbers("Closes https://github.com/Owner/Repo/issues/7", "owner/repo")).toEqual([7]);
    // A DIFFERENT repo's URL must not spoof a same-repo linked issue, same rule as the qualified form.
    expect(extractLinkedIssueNumbers("Closes https://github.com/other/repo/issues/99", "owner/repo")).toEqual([]);
    // URL, qualified, and bare forms mix freely and dedupe together.
    expect(extractLinkedIssueNumbers("Fixes #1\nCloses https://github.com/owner/repo/issues/2\nResolves owner/repo#3", "owner/repo")).toEqual([1, 2, 3]);
    // Still respects the inline-code-span exclusion, same as every other closing-keyword form.
    expect(extractLinkedIssueNumbers("Fixes `not a directive` https://github.com/owner/repo/issues/42", "owner/repo")).toEqual([]);
  });

  it("REGRESSION (#3862): a stored PR using ONLY the qualified `Closes owner/repo#N` form is not flagged as unlinked", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 5,
      title: "Qualified-form closing reference",
      state: "open",
      user: { login: "contributor1" },
      labels: [],
      body: "Closes owner/repo#42",
    });
    const stored = await getPullRequest(env, "owner/repo", 5);
    expect(stored?.linkedIssues).toEqual([42]);
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

  it("REGRESSION: adding an OVERLAPPING linked issue does NOT reset the PR-level claim time; only a fully disjoint set does", async () => {
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

    // #linked-issue-claim-overlap-preserve regression: this used to assert linkedIssueClaimedAt was reset to
    // the fresh "2026-06-29T10:05:00.000Z" timestamp -- that was the AUDITED BUG itself, not the intended
    // design. Adding #2 alongside the already-claimed #1 shares an overlap with the prior set ({1} ∩ {1,2} =
    // {1}), so #1's ORIGINAL claim time must survive; resetting it let a later PR that also claims #1 leapfrog
    // ahead in duplicate-cluster winner priority purely because this PR later mentioned an unrelated issue.
    expect(expanded).toMatchObject({
      title: "Expanded claim",
      linkedIssues: [1, 2],
      linkedIssueClaimedAt: first?.linkedIssueClaimedAt,
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

  it("markPullRequestsBacklogConvergenceRegated batch-stamps every candidate at dispatch and no-ops on an empty list (#4502)", async () => {
    const env = createTestEnv();
    for (const number of [5, 6, 7]) {
      await upsertPullRequestFromGitHub(env, "owner/repo", { number, title: `PR${number}`, state: "open", user: { login: "alice" }, labels: [] });
    }
    const stampedAt = async (number: number) =>
      (await env.DB.prepare("select last_backlog_convergence_regated_at as v from pull_requests where repo_full_name = ? and number = ?").bind("owner/repo", number).first<{ v: string | null }>())?.v ?? null;

    await markPullRequestsBacklogConvergenceRegated(env, "owner/repo", []); // empty → no-op (early return)
    expect(await stampedAt(5)).toBeNull();
    expect(await stampedAt(6)).toBeNull();
    expect(await stampedAt(7)).toBeNull();

    await markPullRequestsBacklogConvergenceRegated(env, "owner/repo", [5, 7]); // batch stamps only 5 and 7
    expect(typeof (await stampedAt(5))).toBe("string");
    expect(typeof (await stampedAt(7))).toBe("string");
    expect(await stampedAt(6)).toBeNull(); // #6 not in the batch → untouched
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

  it("claimBacklogConvergenceFanoutSlot fails open (returns true) on a DB error so the fleet never stalls (#4502)", async () => {
    const env = createTestEnv();
    const broken = { ...env, DB: null } as unknown as typeof env;
    expect(await claimBacklogConvergenceFanoutSlot(broken, "2026-06-25T01:00:00.000Z", 90 * 1000)).toBe(true);
  });

  it("claimMaintainerRecapPeriod: first claim for a period wins, a retry for the SAME period loses, a DIFFERENT period wins again (#2249)", async () => {
    const env = createTestEnv();
    expect(await claimMaintainerRecapPeriod(env, "2026-07-09")).toBe(true); // first claim (marker NULL)
    expect(await claimMaintainerRecapPeriod(env, "2026-07-09")).toBe(false); // retried tick, same period → loses
    expect(await claimMaintainerRecapPeriod(env, "2026-07-10")).toBe(true); // a new day → wins again
    expect(await claimMaintainerRecapPeriod(env, "2026-07-10")).toBe(false); // retried again → loses
  });

  it("claimMaintainerRecapPeriod fails open (returns true) on a DB error so the digest never silently stalls", async () => {
    const env = createTestEnv();
    const broken = { ...env, DB: null } as unknown as typeof env;
    expect(await claimMaintainerRecapPeriod(broken, "2026-07-09")).toBe(true);
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

  it("REGRESSION: a sparse sync (payload.body absent) does NOT wipe an already-claimed linked issue (#linked-issue-sparse-payload-preserve)", async () => {
    const env = createTestEnv();
    // A full sync (e.g. pull_request.opened) correctly claims the linked issue.
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "Fix the bug", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], body: "Closes #42" });
    const claimed = await getPullRequest(env, "owner/repo", 7);
    expect(claimed?.linkedIssues).toEqual([42]);
    expect(typeof claimed?.linkedIssueClaimedAt).toBe("string");

    // A NARROWER event's embedded pull_request sub-object (e.g. a pull_request_review payload shape) can omit
    // `body` entirely -- `undefined`, not an explicit empty string/null. This upsert must not re-derive an
    // empty linkedIssues from the absent body and clobber the already-correct claim.
    const resynced = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "Fix the bug", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [] });
    expect(resynced.linkedIssues).toEqual([42]); // the function's own return value is corrected too
    expect(resynced.linkedIssueClaimedAt).toBe(claimed?.linkedIssueClaimedAt); // claim timestamp is untouched

    const stored = await getPullRequest(env, "owner/repo", 7);
    expect(stored?.body).toBe("Closes #42");
    expect(stored?.linkedIssues).toEqual([42]);
    expect(stored?.linkedIssueClaimedAt).toBe(claimed?.linkedIssueClaimedAt);
  });

  it("REGRESSION: a sparse sync preserves cached body evidence for linked-issue overflow checks", async () => {
    const env = createTestEnv();
    const body = Array.from({ length: MAX_LINKED_ISSUE_NUMBERS + 1 }, (_, index) => `Fixes #${index + 1}`).join("\n");

    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 10, title: "Too many claims", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], body });
    const claimed = await getPullRequest(env, "owner/repo", 10);
    expect(claimed?.linkedIssues).toHaveLength(MAX_LINKED_ISSUE_NUMBERS);
    expect(extractLinkedIssueNumbersWithOverflow(claimed?.body ?? "", "owner/repo").overflow).toBe(true);

    const resynced = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 10, title: "Too many claims", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [] });
    expect(resynced.body).toBe(body);
    expect(resynced.linkedIssues).toHaveLength(MAX_LINKED_ISSUE_NUMBERS);

    const stored = await getPullRequest(env, "owner/repo", 10);
    expect(stored?.body).toBe(body);
    expect(extractLinkedIssueNumbersWithOverflow(stored?.body ?? "", "owner/repo").overflow).toBe(true);
    expect(stored?.linkedIssues).toHaveLength(MAX_LINKED_ISSUE_NUMBERS);
  });

  it("a genuinely empty body (explicit null/\"\", not absent) DOES clear a previously-claimed linked issue", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 8, title: "Fix the bug", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], body: "Closes #42" });
    // The contributor genuinely deleted their PR description -- GitHub reports this as body: null, a real signal
    // distinct from a sparse payload's absent field, and it must still update the stored claim.
    const cleared = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 8, title: "Fix the bug", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], body: null });
    expect(cleared.linkedIssues).toEqual([]);
    const stored = await getPullRequest(env, "owner/repo", 8);
    expect(stored?.linkedIssues).toEqual([]);
    expect(stored?.linkedIssueClaimedAt).toBeNull();
  });

  it("a sparse sync on a brand-new PR (no existing row to preserve) falls through to the empty default", async () => {
    const env = createTestEnv();
    // No prior row exists for PR #9 -- the sparse-preserve branch has nothing to preserve, so this must behave
    // exactly as it always has: derive from the (absent) body, yielding no linked issues.
    const created = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 9, title: "New PR", state: "open", user: { login: "bob" }, labels: [] });
    expect(created.linkedIssues).toEqual([]);
    expect(created.linkedIssueClaimedAt).toBeNull();
    // REGRESSION (#linked-issue-sparse-first-upsert): the empty linkedIssues above is UNVERIFIED, not a
    // confirmed empty body -- bodyObservedAt must stay null so downstream hard-rule enforcement can tell the
    // two apart and skip the "no linked issue" close until a genuine body sync arrives.
    expect(created.bodyObservedAt).toBeNull();
    const stored = await getPullRequest(env, "owner/repo", 9);
    expect(stored?.bodyObservedAt).toBeNull();
  });

  it("REGRESSION (#linked-issue-sparse-first-upsert): a full first-ever sync stamps bodyObservedAt immediately", async () => {
    const env = createTestEnv();
    // A genuinely observed body -- even one with no closing reference -- proves the empty linkedIssues result
    // is trustworthy, so bodyObservedAt is set on the very first (non-sparse) upsert.
    const created = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 11, title: "New PR", state: "open", user: { login: "bob" }, labels: [], body: "no closing reference here" });
    expect(created.linkedIssues).toEqual([]);
    expect(typeof created.bodyObservedAt).toBe("string");
    const stored = await getPullRequest(env, "owner/repo", 11);
    expect(typeof stored?.bodyObservedAt).toBe("string");
  });

  it("REGRESSION (#linked-issue-sparse-first-upsert): a later sparse sync does not clear an already-stamped bodyObservedAt", async () => {
    const env = createTestEnv();
    const first = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 12, title: "New PR", state: "open", user: { login: "bob" }, labels: [], body: "no closing reference here" });
    expect(typeof first.bodyObservedAt).toBe("string");

    // A later narrower webhook event omits body entirely -- the once-set observation timestamp must survive.
    const resynced = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 12, title: "New PR", state: "open", user: { login: "bob" }, labels: [] });
    expect(resynced.bodyObservedAt).toBe(first.bodyObservedAt);
    const stored = await getPullRequest(env, "owner/repo", 12);
    expect(stored?.bodyObservedAt).toBe(first.bodyObservedAt);
  });

  it("REGRESSION (#review-latency-metric): a first-ever sync of a ready (non-draft) open PR stamps headShaObservedAt", async () => {
    const env = createTestEnv();
    const created = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 20, title: "New PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [] });
    expect(typeof created.headShaObservedAt).toBe("string");
    const stored = await getPullRequest(env, "owner/repo", 20);
    expect(typeof stored?.headShaObservedAt).toBe("string");
  });

  it("REGRESSION (#review-latency-metric): a draft PR never gets headShaObservedAt stamped -- draft-sitting time must not count as review latency", async () => {
    const env = createTestEnv();
    const created = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 21, title: "Draft PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], draft: true });
    expect(created.headShaObservedAt).toBeNull();
    // A second sync while still draft (e.g. a title edit) must not start the clock either.
    const resynced = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 21, title: "Draft PR edited", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], draft: true });
    expect(resynced.headShaObservedAt).toBeNull();
  });

  it("REGRESSION (#review-latency-metric): converting draft to ready_for_review with the SAME head SHA starts the clock at that moment", async () => {
    const env = createTestEnv();
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 22, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], draft: true });
    const readied = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 22, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], draft: false });
    expect(typeof readied.headShaObservedAt).toBe("string");
    const stored = await getPullRequest(env, "owner/repo", 22);
    expect(stored?.headShaObservedAt).toBe(readied.headShaObservedAt);
  });

  it("REGRESSION (#review-latency-metric): a fresh commit on an already-ready PR resets headShaObservedAt to a new timestamp", async () => {
    const env = createTestEnv();
    const first = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 23, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [] });
    expect(typeof first.headShaObservedAt).toBe("string");
    const pushed = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 23, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a2" }, labels: [] });
    expect(typeof pushed.headShaObservedAt).toBe("string");
    // Not asserting inequality of the two timestamps (both could land in the same millisecond in a fast test
    // run) -- the meaningful, deterministic assertion is that the SAME-head resync test below preserves the
    // value while this fresh-commit case does NOT skip re-stamping (both are exercised via typeof "string").
  });

  it("REGRESSION (#review-latency-metric): an unrelated resync with an UNCHANGED head SHA preserves the already-stamped headShaObservedAt", async () => {
    const env = createTestEnv();
    const first = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 24, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [] });
    expect(typeof first.headShaObservedAt).toBe("string");
    // A labeled event resyncs the same PR, same head SHA -- must not reset the clock.
    const resynced = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 24, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [{ name: "bug" }] });
    expect(resynced.headShaObservedAt).toBe(first.headShaObservedAt);
    const stored = await getPullRequest(env, "owner/repo", 24);
    expect(stored?.headShaObservedAt).toBe(first.headShaObservedAt);
  });

  it("REGRESSION (#review-latency-metric): a sparse sync (head entirely absent) preserves the already-stamped headShaObservedAt", async () => {
    const env = createTestEnv();
    const first = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 25, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [] });
    expect(typeof first.headShaObservedAt).toBe("string");
    const resynced = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 25, title: "PR", state: "open", user: { login: "bob" }, labels: [] });
    expect(resynced.headShaObservedAt).toBe(first.headShaObservedAt);
  });

  it("REGRESSION (#review-latency-metric): closing the PR does not error and leaves headShaObservedAt as last observed", async () => {
    const env = createTestEnv();
    const first = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 26, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [] });
    expect(typeof first.headShaObservedAt).toBe("string");
    const closed = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 26, title: "PR", state: "closed", user: { login: "bob" }, head: { sha: "a1" }, labels: [] });
    expect(closed.headShaObservedAt).toBe(first.headShaObservedAt);
  });

  describe("out-of-order webhook guard (#webhook-reorder-clobber)", () => {
    it("REGRESSION: a delayed OLDER webhook cannot clobber state/headSha/mergedAt a newer one already wrote", async () => {
      const env = createTestEnv();
      // The real close lands first (job order, not necessarily arrival order).
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 30, title: "PR", state: "closed", user: { login: "bob" }, head: { sha: "a1" }, merged_at: null, labels: [], updated_at: "2026-07-21T12:21:17.000Z",
      });
      // A job for an OLDER event (e.g. review_requested, queued minutes earlier) finally dequeues after
      // sitting behind queue backpressure and processes its own stale, still-"open" embedded snapshot.
      const stale = await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 30, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a0" }, merged_at: null, labels: [], updated_at: "2026-07-21T12:15:52.000Z",
      });

      // The function's OWN return value reflects what was actually persisted, not the stale incoming payload --
      // this is what handlePullRequestWebhookEvent's closed-check (and every other reader of this call's result)
      // sees, so it must agree with the DB or the delayed job would still act on stale data in-process.
      expect(stale.state).toBe("closed");
      expect(stale.headSha).toBe("a1");
      const stored = await getPullRequest(env, "owner/repo", 30);
      expect(stored?.state).toBe("closed");
      expect(stored?.headSha).toBe("a1");
    });

    it("a NEWER webhook (later updated_at) still applies normally", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 31, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], updated_at: "2026-07-21T12:00:00.000Z",
      });
      const fresh = await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 31, title: "PR", state: "closed", user: { login: "bob" }, head: { sha: "a2" }, labels: [], updated_at: "2026-07-21T12:05:00.000Z",
      });

      expect(fresh.state).toBe("closed");
      expect(fresh.headSha).toBe("a2");
    });

    it("fails OPEN when the incoming payload has no updated_at (a sparse webhook sub-object) -- applies the write exactly as before this guard existed", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 32, title: "PR", state: "closed", user: { login: "bob" }, head: { sha: "a1" }, labels: [], updated_at: "2026-07-21T12:21:17.000Z",
      });
      const sparse = await upsertPullRequestFromGitHub(env, "owner/repo", { number: 32, title: "PR reopened by sparse event", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [] });

      expect(sparse.state).toBe("open");
    });

    it("fails OPEN for a pre-migration row with no stored githubUpdatedAt yet -- applies the write exactly as before this guard existed", async () => {
      const env = createTestEnv();
      // Simulates a row created before this migration: no updated_at supplied on the FIRST sync either.
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: 33, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [] });
      const synced = await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 33, title: "PR", state: "closed", user: { login: "bob" }, head: { sha: "a1" }, labels: [], updated_at: "2026-07-21T12:00:00.000Z",
      });

      expect(synced.state).toBe("closed"); // nothing stored to compare against -> guard can't prove staleness, applies the write
    });

    it("mergedAt is guarded the same way -- a stale payload cannot regress a real merge back to null", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 34, title: "PR", state: "closed", user: { login: "bob" }, head: { sha: "a1" }, merged_at: "2026-07-21T12:21:17.000Z", labels: [], updated_at: "2026-07-21T12:21:17.000Z",
      });
      const stale = await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 34, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, merged_at: null, labels: [], updated_at: "2026-07-21T12:00:00.000Z",
      });

      expect(stale.mergedAt).toBe("2026-07-21T12:21:17.000Z");
      const stored = await getPullRequest(env, "owner/repo", 34);
      expect(stored?.mergedAt).toBe("2026-07-21T12:21:17.000Z");
    });

    it("an EQUAL updated_at (a true redelivery/retry of the same event) is not treated as stale", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 35, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], updated_at: "2026-07-21T12:00:00.000Z",
      });
      const redelivered = await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 35, title: "PR redelivered", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], updated_at: "2026-07-21T12:00:00.000Z",
      });

      expect(redelivered.title).toBe("PR redelivered"); // non-guarded fields still apply on an equal-timestamp resync
    });

    it("REGRESSION: a stale payload's rejected head SHA does not reset the review-latency clock (headShaObservedAt) -- the clock must follow the RESOLVED head, not the raw payload's", async () => {
      const env = createTestEnv();
      const first = await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 36, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], updated_at: "2026-07-21T12:00:00.000Z",
      });
      expect(typeof first.headShaObservedAt).toBe("string");
      // A genuine fresh commit lands and is processed promptly -- the real current head is now a2.
      const pushed = await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 36, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a2" }, labels: [], updated_at: "2026-07-21T12:05:00.000Z",
      });
      expect(pushed.headSha).toBe("a2");
      // Not asserting inequality against first.headShaObservedAt (both could land in the same millisecond in
      // a fast test run, matching the same caveat the review-latency-metric tests above already document) --
      // typeof "string" here plus the exact-preservation assertion below is the deterministic, non-flaky check.
      expect(typeof pushed.headShaObservedAt).toBe("string");

      // A delayed job for the OLDER `review_requested` event (before the push) finally dequeues, still carrying
      // the STALE head "a1". Without resolvedHeadSha driving headShaChanged, this would look like "a2 -> a1", a
      // head change, and wrongly reset the clock even though the stored head never actually moved off "a2".
      const stale = await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 36, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], updated_at: "2026-07-21T12:01:00.000Z",
      });

      expect(stale.headSha).toBe("a2"); // still protected by the out-of-order guard
      expect(stale.headShaObservedAt).toBe(pushed.headShaObservedAt); // clock untouched by the stale rejection
    });

    it("REGRESSION: a stale payload claiming state: open does not re-stamp lastSeenOpenAt once the PR has actually closed", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 37, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], updated_at: "2026-07-21T12:00:00.000Z",
      });
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 37, title: "PR", state: "closed", user: { login: "bob" }, head: { sha: "a1" }, labels: [], updated_at: "2026-07-21T12:05:00.000Z",
      });
      // A delayed job for an older still-"open" event dequeues after the real close.
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number: 37, title: "PR", state: "open", user: { login: "bob" }, head: { sha: "a1" }, labels: [], updated_at: "2026-07-21T12:01:00.000Z",
      });

      const row = await env.DB.prepare("select last_seen_open_at from pull_requests where repo_full_name = ? and number = ?")
        .bind("owner/repo", 37)
        .first<{ last_seen_open_at: string | null }>();
      expect(row?.last_seen_open_at).toBeNull(); // not re-stamped as "seen open" by the stale rejection
    });
  });

  it("countRecentDeadLetters counts github_app.dlq_dead_lettered audits since a cutoff, independent of any ops flag (#1276)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, { eventType: "github_app.dlq_dead_lettered", actor: "loopover", targetKey: "dlq:github-webhook:a", outcome: "error", createdAt: "2026-06-24T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.dlq_dead_lettered", actor: "loopover", targetKey: "dlq:backfill-repo-segment:b", outcome: "error", createdAt: "2026-06-24T12:00:00.000Z" });
    // An unrelated audit event must NOT be counted (the event-type filter).
    await recordAuditEvent(env, { eventType: "agent.sweep.regate", actor: "loopover", targetKey: "owner/repo", outcome: "completed", createdAt: "2026-06-24T12:00:00.000Z" });

    expect(await countRecentDeadLetters(env, "2026-06-24T09:00:00.000Z")).toBe(2); // both dead-letters in window
    expect(await countRecentDeadLetters(env, "2026-06-24T11:00:00.000Z")).toBe(1); // only the 12:00 one
    expect(await countRecentDeadLetters(env, "2026-06-24T13:00:00.000Z")).toBe(0); // none after the cutoff → count(*) returns 0
  });

  it("countRecentDeadLettersByType groups recent dead letters by job type in deterministic key order (#1208)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "loopover",
      targetKey: "dlq:github-webhook:a",
      outcome: "error",
      createdAt: "2026-06-24T12:00:00.000Z",
      metadata: { jobType: "github-webhook" },
    });
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "loopover",
      targetKey: "dlq:backfill-repo-segment:b",
      outcome: "error",
      createdAt: "2026-06-24T10:00:00.000Z",
      metadata: { jobType: "backfill-repo-segment" },
    });
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "loopover",
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
      actor: "loopover",
      targetKey: "dlq:refresh-registry:a",
      outcome: "error",
      createdAt: "2026-06-24T10:00:00.000Z",
      metadata: { jobType: "refresh-registry" },
    });
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "loopover",
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
      eventType: "github_app.dlq_dead_lettered",
      actor: "loopover",
      targetKey: "dlq:github-webhook:stale",
      outcome: "error",
      createdAt: "2026-06-24T08:59:59.000Z",
      metadata: { jobType: "github-webhook" },
    });
    await recordAuditEvent(env, {
      eventType: "agent.sweep.regate",
      actor: "loopover",
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
      actor: "loopover",
      targetKey: "dlq:unknown:a",
      outcome: "error",
      createdAt: "2026-06-24T10:00:00.000Z",
    });
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "loopover",
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

  it("countRecentAuditEventsForActorInRepo counts one actor's events across EVERY target within a repo, not just one targetKey (#review-nag-cross-pr-carryover)", async () => {
    const env = createTestEnv();
    // Same actor, TWO different targets (PR #1 and PR #2) within the same repo -- both must count toward the total.
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/repo#1", outcome: "completed", createdAt: "2026-06-24T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/repo#1", outcome: "completed", createdAt: "2026-06-24T10:05:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/repo#2", outcome: "completed", createdAt: "2026-06-24T12:00:00.000Z" });
    // A different actor in the SAME repo must not be counted (the actor filter).
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "someone-else", targetKey: "owner/repo#3", outcome: "completed", createdAt: "2026-06-24T12:00:00.000Z" });
    // The SAME actor pinging a DIFFERENT repo must not be counted (the repo-prefix scope).
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/other-repo#1", outcome: "completed", createdAt: "2026-06-24T12:00:00.000Z" });
    // An unrelated event type on the same actor+repo must not be counted (the eventType filter).
    await recordAuditEvent(env, { eventType: "github_app.agent_command_replied", actor: "chatty", targetKey: "owner/repo#1", outcome: "completed", createdAt: "2026-06-24T12:00:00.000Z" });

    expect(await countRecentAuditEventsForActorInRepo(env, "chatty", "github_app.review_nag_ping", "owner/repo", "2026-06-24T09:00:00.000Z")).toBe(3);
    expect(await countRecentAuditEventsForActorInRepo(env, "chatty", "github_app.review_nag_ping", "owner/repo", "2026-06-24T11:00:00.000Z")).toBe(1); // only the 12:00 owner/repo#2 ping
    expect(await countRecentAuditEventsForActorInRepo(env, "chatty", "github_app.review_nag_ping", "owner/repo", "2026-06-24T13:00:00.000Z")).toBe(0); // none after the cutoff → count(*) returns 0
  });

  it("countRecentAuditEventsForActorInRepo treats repo names as literal LIKE prefixes (regression mirroring findHottestReviewTargetForRepo's #review-burst-scope-pollution fix)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/foo_bar#1", outcome: "completed", createdAt: "2026-06-24T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/foo_bar#2", outcome: "completed", createdAt: "2026-06-24T10:05:00.000Z" });
    // owner/fooXbar is a DIFFERENT repo that would spuriously match "owner/foo_bar#%" if `_` were left as a SQL
    // wildcard instead of being escaped -- must not leak into owner/foo_bar's count.
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/fooXbar#99", outcome: "completed", createdAt: "2026-06-24T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/fooXbar#99", outcome: "completed", createdAt: "2026-06-24T10:05:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.review_nag_ping", actor: "chatty", targetKey: "owner/fooXbar#99", outcome: "completed", createdAt: "2026-06-24T10:10:00.000Z" });

    expect(await countRecentAuditEventsForActorInRepo(env, "chatty", "github_app.review_nag_ping", "owner/foo_bar", "2026-06-24T09:00:00.000Z")).toBe(2);
  });

  it("countRecentAuditEventsForActorInRepoWithTargetSuffix counts across every PR/issue number in a repo while still pinning to ONE exact targetKey suffix (#review-nag-cross-pr-carryover)", async () => {
    const env = createTestEnv();
    // Two different PR numbers within the SAME repo, both suffixed "#mention:jsonbored" -- both count.
    await recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "owner/repo#1#mention:jsonbored", outcome: "completed", createdAt: "2026-06-24T10:00:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "owner/repo#2#mention:jsonbored", outcome: "completed", createdAt: "2026-06-24T10:05:00.000Z" });
    // A DIFFERENT mentioned login's suffix on the SAME repo+actor must NOT bleed into the "jsonbored" count --
    // this is the independent-budget guarantee the plain repo-prefix countRecentAuditEventsForActorInRepo can't
    // provide on its own.
    await recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "owner/repo#3#mention:other-maintainer", outcome: "completed", createdAt: "2026-06-24T10:07:00.000Z" });
    // A different actor with the SAME suffix must not be counted (the actor filter).
    await recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "someone-else", targetKey: "owner/repo#4#mention:jsonbored", outcome: "completed", createdAt: "2026-06-24T10:08:00.000Z" });
    // A different repo with the SAME suffix must not be counted (the repo-prefix scope).
    await recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "owner/other-repo#1#mention:jsonbored", outcome: "completed", createdAt: "2026-06-24T10:09:00.000Z" });

    expect(await countRecentAuditEventsForActorInRepoWithTargetSuffix(env, "chatty", "github_app.monitored_mention_ping", "owner/repo", "mention:jsonbored", "2026-06-24T09:00:00.000Z")).toBe(2);
    expect(await countRecentAuditEventsForActorInRepoWithTargetSuffix(env, "chatty", "github_app.monitored_mention_ping", "owner/repo", "mention:other-maintainer", "2026-06-24T09:00:00.000Z")).toBe(1);
    expect(await countRecentAuditEventsForActorInRepoWithTargetSuffix(env, "chatty", "github_app.monitored_mention_ping", "owner/repo", "mention:jsonbored", "2026-06-24T10:06:00.000Z")).toBe(0); // cutoff after both matching pings
  });

  it("countRecentAuditEventsForActorInRepoWithTargetSuffix escapes BOTH the repo prefix and the suffix before embedding them in the LIKE pattern (regression mirroring countRecentAuditEventsForActorInRepo's escaping fix)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "owner/foo_bar#1#mention:some_login", outcome: "completed", createdAt: "2026-06-24T10:00:00.000Z" });
    // Neither a repo-name collision (fooXbar vs foo_bar) NOR a suffix collision (someXlogin vs some_login) may
    // leak in if `_` were left as an unescaped SQL wildcard in either segment.
    await recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "owner/fooXbar#2#mention:some_login", outcome: "completed", createdAt: "2026-06-24T10:01:00.000Z" });
    await recordAuditEvent(env, { eventType: "github_app.monitored_mention_ping", actor: "chatty", targetKey: "owner/foo_bar#3#mention:someXlogin", outcome: "completed", createdAt: "2026-06-24T10:02:00.000Z" });

    expect(await countRecentAuditEventsForActorInRepoWithTargetSuffix(env, "chatty", "github_app.monitored_mention_ping", "owner/foo_bar", "mention:some_login", "2026-06-24T09:00:00.000Z")).toBe(1);
  });

  it("findHottestReviewTargetForRepo returns the PR with the most published surfaces in the window, scoped to ONE repo (#orb-ci-stuck-repeat)", async () => {
    const env = createTestEnv();
    const publish = (targetKey: string, createdAt: string) =>
      recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", actor: "contributor", targetKey, outcome: "completed", createdAt });
    // owner/repo#1: 3 publishes in-window -- the hottest target for this repo.
    await publish("owner/repo#1", "2026-06-24T10:00:00.000Z");
    await publish("owner/repo#1", "2026-06-24T10:05:00.000Z");
    await publish("owner/repo#1", "2026-06-24T10:10:00.000Z");
    // owner/repo#2: only 1 publish -- must not win over #1.
    await publish("owner/repo#2", "2026-06-24T10:00:00.000Z");
    // A DIFFERENT event type on the SAME PR must not count (the eventType filter).
    await recordAuditEvent(env, { eventType: "github_app.ai_review_cache_hit", actor: "contributor", targetKey: "owner/repo#1", outcome: "completed", createdAt: "2026-06-24T10:07:00.000Z" });
    // A DIFFERENT repo with an overlapping numeric suffix must not leak into this repo's count (the LIKE scope).
    await publish("owner/repo-fork#1", "2026-06-24T10:00:00.000Z");
    await publish("owner/repo-fork#1", "2026-06-24T10:05:00.000Z");
    await publish("owner/repo-fork#1", "2026-06-24T10:06:00.000Z");
    await publish("owner/repo-fork#1", "2026-06-24T10:07:00.000Z");

    const hottest = await findHottestReviewTargetForRepo(env, "owner/repo", "2026-06-24T09:00:00.000Z");
    expect(hottest).toEqual({ targetKey: "owner/repo#1", count: 3 });

    // A cutoff AFTER all the recorded publishes must find nothing.
    expect(await findHottestReviewTargetForRepo(env, "owner/repo", "2026-06-24T11:00:00.000Z")).toBeNull();
    // An unregistered/unpublished repo must find nothing.
    expect(await findHottestReviewTargetForRepo(env, "owner/nothing-here", "2026-06-24T09:00:00.000Z")).toBeNull();
  });

  it("findHottestReviewTargetForRepo treats repo names as literal LIKE prefixes (regression for review-burst scope pollution)", async () => {
    const env = createTestEnv();
    const publish = (targetKey: string, createdAt: string) =>
      recordAuditEvent(env, { eventType: "github_app.pr_public_surface_published", actor: "contributor", targetKey, outcome: "completed", createdAt });

    await publish("owner/foo_bar#1", "2026-06-24T10:00:00.000Z");
    await publish("owner/foo_bar#1", "2026-06-24T10:05:00.000Z");
    await publish("owner/foo_bar#1", "2026-06-24T10:10:00.000Z");
    await publish("owner/fooXbar#99", "2026-06-24T10:00:00.000Z");
    await publish("owner/fooXbar#99", "2026-06-24T10:05:00.000Z");
    await publish("owner/fooXbar#99", "2026-06-24T10:10:00.000Z");
    await publish("owner/fooXbar#99", "2026-06-24T10:15:00.000Z");

    expect(await findHottestReviewTargetForRepo(env, "owner/foo_bar", "2026-06-24T09:00:00.000Z")).toEqual({
      targetKey: "owner/foo_bar#1",
      count: 3,
    });
  });

  it("findHottestInconclusiveReviewTargetForRepo counts only inconclusive:true calls, scoped to ONE repo (#4997 regression: the JSON-boolean comparison must exclude inconclusive:false, not just miss on total volume)", async () => {
    const env = createTestEnv();
    const record = (repoFullName: string, pullNumber: number, inconclusive: boolean) =>
      recordAiUsageEvent(env, {
        feature: "ai_review_pr",
        model: "self-host:claude-code",
        status: "ok",
        estimatedNeurons: 100,
        metadata: { repoFullName, pullNumber, inconclusive },
      });
    // owner/repo#1: 3 inconclusive calls -- the hottest inconclusive target for this repo.
    await record("owner/repo", 1, true);
    await record("owner/repo", 1, true);
    await record("owner/repo", 1, true);
    // owner/repo#1 ALSO has 2 successful (non-inconclusive) calls on the SAME PR -- must not inflate the count.
    await record("owner/repo", 1, false);
    await record("owner/repo", 1, false);
    // owner/repo#2: only 1 inconclusive call -- must not win over #1.
    await record("owner/repo", 2, true);
    // A different repo's inconclusive calls must not leak into this repo's count.
    await record("owner/other", 1, true);
    await record("owner/other", 1, true);

    const hottest = await findHottestInconclusiveReviewTargetForRepo(env, "owner/repo", "2020-01-01T00:00:00.000Z");
    expect(hottest).toEqual({ targetKey: "owner/repo#1", count: 3 });

    // A cutoff after all the recorded events must find nothing.
    expect(await findHottestInconclusiveReviewTargetForRepo(env, "owner/repo", "2099-01-01T00:00:00.000Z")).toBeNull();
    // A repo with only non-inconclusive calls must find nothing.
    await record("owner/all-ok", 1, false);
    expect(await findHottestInconclusiveReviewTargetForRepo(env, "owner/all-ok", "2020-01-01T00:00:00.000Z")).toBeNull();
  });

  it("hasAuditEventForDelivery finds a matching deliveryId inside metadata_json, scoped to actor+eventType+targetKey (#2560)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.command_invocation",
      actor: "maintainer",
      targetKey: "owner/repo#1#help",
      outcome: "completed",
      createdAt: "2026-06-24T10:00:00.000Z",
      metadata: { deliveryId: "delivery-a" },
    });

    expect(await hasAuditEventForDelivery(env, "maintainer", "github_app.command_invocation", "owner/repo#1#help", "delivery-a", "2026-06-24T09:00:00.000Z")).toBe(true);
    // A different deliveryId on the SAME actor+eventType+targetKey must not match.
    expect(await hasAuditEventForDelivery(env, "maintainer", "github_app.command_invocation", "owner/repo#1#help", "delivery-b", "2026-06-24T09:00:00.000Z")).toBe(false);
    // The SAME deliveryId but for a DIFFERENT command's targetKey must not match (each command's own counter).
    expect(await hasAuditEventForDelivery(env, "maintainer", "github_app.command_invocation", "owner/repo#1#ask", "delivery-a", "2026-06-24T09:00:00.000Z")).toBe(false);
    // A cutoff AFTER the recorded event must not match (outside the recent window).
    expect(await hasAuditEventForDelivery(env, "maintainer", "github_app.command_invocation", "owner/repo#1#help", "delivery-a", "2026-06-24T11:00:00.000Z")).toBe(false);
  });

  it("REGRESSION (gate-flagged): hasAuditEventForDelivery still finds the matching deliveryId when MORE than 50 other rows exist in the window (burst/spam scenario)", async () => {
    // A prior version matched deliveryId IN MEMORY over a `.limit(50)` slice with no ORDER BY, so once an
    // actor had more than 50 matching rows in the window, the row carrying the target deliveryId could be
    // excluded from that arbitrary slice -- a false negative right when a burst/spam scenario (the abuse
    // case this feature exists to handle) makes it most likely. The fix pushes the deliveryId match into the
    // SQL predicate itself, so it must still be found regardless of how many OTHER rows exist.
    const env = createTestEnv();
    for (let i = 0; i < 60; i += 1) {
      await recordAuditEvent(env, {
        eventType: "github_app.command_invocation",
        actor: "maintainer",
        targetKey: "owner/repo#1#help",
        outcome: "completed",
        createdAt: "2026-06-24T10:00:00.000Z",
        metadata: { deliveryId: `delivery-noise-${i}` },
      });
    }
    await recordAuditEvent(env, {
      eventType: "github_app.command_invocation",
      actor: "maintainer",
      targetKey: "owner/repo#1#help",
      outcome: "completed",
      createdAt: "2026-06-24T10:00:00.000Z",
      metadata: { deliveryId: "delivery-target" },
    });

    expect(await hasAuditEventForDelivery(env, "maintainer", "github_app.command_invocation", "owner/repo#1#help", "delivery-target", "2026-06-24T09:00:00.000Z")).toBe(true);
    expect(await hasAuditEventForDelivery(env, "maintainer", "github_app.command_invocation", "owner/repo#1#help", "delivery-never-recorded", "2026-06-24T09:00:00.000Z")).toBe(false);
  });

  it("hasAuditEventForHeadSha finds a matching headSha inside metadata_json, scoped to eventType+targetKey, with no time bound (#4196)", async () => {
    const env = createTestEnv();
    await recordAuditEvent(env, {
      eventType: "github_app.e2e_tests_generation",
      actor: "contributor",
      targetKey: "owner/repo#7",
      outcome: "completed",
      createdAt: "2020-01-01T00:00:00.000Z", // ancient -- there is no time window on this lookup at all
      metadata: { headSha: "sha-a" },
    });

    expect(await hasAuditEventForHeadSha(env, "github_app.e2e_tests_generation", "owner/repo#7", "sha-a")).toBe(true);
    // A DIFFERENT head SHA on the same targetKey/eventType must not match -- a genuinely new push is always a fresh miss.
    expect(await hasAuditEventForHeadSha(env, "github_app.e2e_tests_generation", "owner/repo#7", "sha-b")).toBe(false);
    // The SAME headSha but a different targetKey (a different PR) must not match.
    expect(await hasAuditEventForHeadSha(env, "github_app.e2e_tests_generation", "owner/repo#8", "sha-a")).toBe(false);
    // The SAME headSha and targetKey but a different eventType must not match.
    expect(await hasAuditEventForHeadSha(env, "github_app.some_other_event", "owner/repo#7", "sha-a")).toBe(false);
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
              repoFullName: "JSONbored/loopover",
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
              repoFullName: "JSONbored/loopover",
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

// #ops-anomaly-calibration-sample-order: both list functions cap their row count, and a LIMIT with no ORDER BY
// gives no ordering guarantee -- confirmed live on a 2930-row repo, where the resulting arbitrary 500-row slice
// inverted src/services/outcome-calibration.ts's slop-band merge-rate comparison (which reads listPullRequests)
// and fired a false ops_anomaly "score not discriminating" alert, even though the score discriminates correctly
// (monotonically decreasing merge rate by rising severity) over the true full population. Ordering by recency
// fixes this at the source, for every caller, not just calibration.
describe("listPullRequests / listAllPullRequests ordering (#ops-anomaly-calibration-sample-order)", () => {
  it("listPullRequests returns a repo's PRs ordered by DESCENDING number, regardless of insert order", async () => {
    const env = createTestEnv();
    for (const number of [3, 1, 4, 2]) {
      await upsertPullRequestFromGitHub(env, "owner/repo", {
        number,
        title: `PR #${number}`,
        state: "open",
        user: { login: "contributor1" },
        labels: [],
        body: null,
      });
    }

    const numbers = (await listPullRequests(env, "owner/repo")).map((pr) => pr.number);
    expect(numbers).toEqual([4, 3, 2, 1]);
  });

  it("listAllPullRequests returns PRs ordered by DESCENDING createdAt across repos, regardless of insert order", async () => {
    const env = createTestEnv();
    const seeds: Array<{ repoFullName: string; number: number; createdAt: string }> = [
      { repoFullName: "owner/repo-a", number: 1, createdAt: "2026-01-01T00:00:00.000Z" },
      { repoFullName: "owner/repo-b", number: 1, createdAt: "2026-03-01T00:00:00.000Z" },
      { repoFullName: "owner/repo-a", number: 2, createdAt: "2026-02-01T00:00:00.000Z" },
    ];
    for (const seed of seeds) {
      await upsertPullRequestFromGitHub(env, seed.repoFullName, {
        number: seed.number,
        title: `${seed.repoFullName}#${seed.number}`,
        state: "open",
        user: { login: "contributor1" },
        labels: [],
        body: null,
        created_at: seed.createdAt,
      });
    }

    const ordered = (await listAllPullRequests(env)).map((pr) => `${pr.repoFullName}#${pr.number}`);
    expect(ordered).toEqual(["owner/repo-b#1", "owner/repo-a#2", "owner/repo-a#1"]);
  });
});
