import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  upsertInstallation,
  upsertOfficialMinerDetection,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { processJob, reReviewStoredPullRequest } from "../../src/queue/processors";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { asCloudEnv, createTestEnv } from "../helpers/d1";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

// #9000, the lost-click half. Three checkbox states looked identical to a maintainer: processed (panel
// republished, box reset), deferred for CI (box stays ticked, honored later via the #7626 pending marker),
// and DELIVERY LOST (box stays ticked, nothing recorded, nothing will ever happen -- three such losses
// observed live on #8972). Recovery intercepts the panel republish, which already fetches the existing
// comment for its marker search: a ticked box in the body being overwritten, with no recent processing and
// no pending marker, IS the lost intent -- and the overwrite was previously the moment it got erased.

function queueMinerSnapshot(login: string) {
  return {
    source: "gittensor_api" as const,
    githubId: "123",
    githubUsername: login,
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
      pullRequests: 3,
      mergedPullRequests: 2,
      openPullRequests: 1,
      closedPullRequests: 0,
      openIssues: 0,
      closedIssues: 0,
      solvedIssues: 0,
      validSolvedIssues: 0,
    },
    repositories: [],
    pullRequests: [],
    issueLabels: [],
  };
}

// Same fixture shape as pr-panel-retrigger-pending-force-review.test.ts (#7626), this suite's sibling: it is
// the proven minimal seed that drives a real publish (comment surface on, AI in block mode) without needing
// merge/approve endpoint mocks.
async function seedRecoveryRepo(env: Env) {
  await persistRegistrySnapshot(
    asCloudEnv(env),
    normalizeRegistryPayload(
      { "JSONbored/gittensory": { emission_share: 0.01, issue_discovery_share: 0 } },
      { kind: "raw-github", url: "https://example.test" },
      "2026-05-23T00:00:00.000Z",
    ),
  );
  await upsertInstallation(env, { action: "created", installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "selected", permissions: {}, events: [] } });
  await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 123);
  await upsertRepositorySettings(env, {
    repoFullName: "JSONbored/gittensory",
    autoLabelEnabled: false,
    gatePack: "oss-anti-slop",
    autonomy: { label: "auto" },
  });
  await upsertRepoFocusManifest(env, "JSONbored/gittensory", {
    settings: {
      commentMode: "all_prs",
      publicSurface: "comment_only",
      checkRunMode: "off",
      reviewCheckMode: "required",
      aiReviewMode: "block",
    },
  });
  await upsertOfficialMinerDetection(env, "contributor", { status: "confirmed", snapshot: queueMinerSnapshot("contributor") }, 60_000);
}

/** The live panel body as GitHub would return it after a click whose webhook was lost: ticked box, our bot. */
const TICKED_LIVE_PANEL = [
  "<!-- gittensory-pr-panel:v1 -->",
  "",
  "Stale review content from an earlier pass.",
  "",
  "- [x] <!-- gittensory-rerun-review:v1 --> Re-run LoopOver review",
].join("\n");

const UNTICKED_LIVE_PANEL = TICKED_LIVE_PANEL.replace("- [x]", "- [ ]");

function stubGitHub(prNumber: number, sha: string, livePanelBody: string | null, opts: { ciPending?: boolean } = {}) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (url.includes("/access_tokens")) return Response.json({ token: "fake-installation-token" });
    if (url.includes(`/pulls/${prNumber}/files`)) return Response.json([{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@\n+export const ok = true;" }]);
    // sha "" models the no-head ghost PR: the resync would otherwise self-heal the fixture from this
    // live read and the recovery would never see a SHA-less record.
    if (url.endsWith(`/pulls/${prNumber}`)) return Response.json({ number: prNumber, title: "Recovery PR", state: "open", user: { login: "contributor" }, head: sha === "" ? {} : { sha }, labels: [], body: "Closes #1", mergeable_state: "clean" });
    if (url.includes(`/commits/${sha}/check-runs`)) {
      return opts.ciPending
        ? Response.json({ total_count: 1, check_runs: [{ name: "test", status: "in_progress", conclusion: null, app: { slug: "github-actions" } }] })
        : Response.json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
    }
    if (url.includes(`/commits/${sha}/status`)) return Response.json({ state: opts.ciPending ? "pending" : "success", statuses: [] });
    if (url.includes("/issues/1")) return Response.json({ number: 1, title: "Issue", state: "open", labels: [], user: { login: "reporter" } });
    if (url.includes(`/issues/${prNumber}/comments`) && method === "GET") {
      return Response.json(
        livePanelBody === null ? [] : [{ id: 900, body: livePanelBody, user: { login: "loopover-orb[bot]", type: "Bot" } }],
      );
    }
    if (url.includes("/comments") && (method === "POST" || method === "PATCH")) return Response.json({ id: 900 }, { status: 201 });
    if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
    return Response.json({});
  });
}

async function recoveryEnv(onAi?: () => void) {
  return createTestEnv({
    GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
    AI: { run: async () => { onAi?.(); return { response: JSON.stringify({ assessment: "Fresh opinion.", blockers: [], nits: [], suggestions: [] }) }; } } as unknown as Ai,
    AI_SUMMARIES_ENABLED: "true",
    AI_PUBLIC_COMMENTS_ENABLED: "true",
    AI_DAILY_NEURON_BUDGET: "100000",
  });
}

async function seedPr(env: Env, prNumber: number, sha: string) {
  await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
    number: prNumber,
    title: "Recovery PR",
    state: "open",
    user: { login: "contributor" },
    author_association: "CONTRIBUTOR",
    head: { sha },
    base: { ref: "main" },
    labels: [],
    body: "Closes #1",
    created_at: "2026-07-20T00:00:00Z",
  });
}

async function recoveredEventCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("select count(*) as n from audit_events where event_type = ?")
    .bind("github_app.pr_panel_retrigger_recovered")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("PR-panel retrigger lost-click recovery (#9000)", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("REGRESSION (#8972 shape): a ticked box with no matching processing is recovered, not erased — event + marker + prompt re-review job", async () => {
    const env = await recoveryEnv();
    const sent: unknown[] = [];
    (env as { JOBS: Queue }).JOBS = { send: async (job: unknown) => { sent.push(job); } } as unknown as Queue;
    await seedRecoveryRepo(env);
    await seedPr(env, 801, "shaLost");
    stubGitHub(801, "shaLost", TICKED_LIVE_PANEL);

    // A NATURAL pass — a sweep re-review, not a retrigger webhook (the webhook is the thing that was lost).
    await reReviewStoredPullRequest(env, "sweep-natural-801", 123, "JSONbored/gittensory", 801);

    // The recovery named itself (#9003's invariant) rather than silently erasing the tick with `- [ ]`.
    expect(await recoveredEventCount(env)).toBe(1);
    // ...and enqueued a prompt follow-up pass, since a PR with a lost click cannot count on a natural one.
    const recovery = sent.find((job) => (job as { deliveryId?: string }).deliveryId?.startsWith("panel-retrigger-recovery:"));
    expect(recovery).toMatchObject({
      type: "agent-regate-pr",
      repoFullName: "JSONbored/gittensory",
      prNumber: 801,
      installationId: 123,
      prCreatedAt: expect.any(String), // the #9499 oldest-first sort key — omitting it INVERTS queue order
    });
  });

  it("end-to-end: the recovery job's pass consumes the marker, forces a FRESH AI review, and does not re-fire", async () => {
    let aiCalls = 0;
    const env = await recoveryEnv(() => { aiCalls += 1; });
    const sent: Array<{ deliveryId?: string }> = [];
    (env as { JOBS: Queue }).JOBS = { send: async (job: unknown) => { sent.push(job as { deliveryId?: string }); } } as unknown as Queue;
    await seedRecoveryRepo(env);
    await seedPr(env, 802, "shaLost2");
    stubGitHub(802, "shaLost2", TICKED_LIVE_PANEL);

    await reReviewStoredPullRequest(env, "sweep-natural-802", 123, "JSONbored/gittensory", 802);
    const aiCallsAfterDetection = aiCalls;
    const recovery = sent.find((job) => job.deliveryId?.startsWith("panel-retrigger-recovery:"));
    expect(recovery).toBeDefined();

    // GitHub now shows the box unticked (the detection pass republished the panel) — so the recovery pass
    // must take its intent from the CONSUMED MARKER, not from re-reading the comment.
    stubGitHub(802, "shaLost2", UNTICKED_LIVE_PANEL);
    await processJob(env, recovery as Parameters<typeof processJob>[1]);

    // The lost click bought exactly one fresh review (the #7626 marker is one-shot)...
    expect(aiCalls).toBeGreaterThan(aiCallsAfterDetection);
    // ...and the recovery pass did not diagnose ITS own republish as a second lost click.
    expect(await recoveredEventCount(env)).toBe(1);
  });

  it("INVARIANT: a recently-PROCESSED retrigger is not re-recovered — the delivery raced the pass, it was not lost", async () => {
    const env = await recoveryEnv();
    await seedRecoveryRepo(env);
    await seedPr(env, 803, "shaRaced");
    // The processed event a real retrigger records, moments ago.
    await env.DB.prepare(
      `INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at)
       VALUES ('race1', 'github_app.pr_panel_retriggered', 'maintainer', 'JSONbored/gittensory#803', 'completed', 'x', '{}', ?)`,
    ).bind(new Date(Date.now() - 60_000).toISOString()).run();
    stubGitHub(803, "shaRaced", TICKED_LIVE_PANEL);

    await reReviewStoredPullRequest(env, "sweep-natural-803", 123, "JSONbored/gittensory", 803);

    expect(await recoveredEventCount(env)).toBe(0);
  });

  it("INVARIANT: a DEFERRED click (pending marker present) is not double-recovered — it is already being honored", async () => {
    // The #7626 flow: the retrigger handler marks the pending marker BEFORE its readiness check, so any panel
    // republish that happens while the click is deferred (including the CI-wait placeholder inside that very
    // pass) sees the marker and stands down. Without this guard, every deferral would also spawn a recovery.
    // Same injected-cache seam the sibling #7626 suite uses -- putTransientKey is module-private, so the
    // marker is seeded exactly as markPendingPrPanelRetrigger writes it (lowercased repo, same value).
    const cache = {
      values: new Map<string, string>([["pr-panel-retrigger-pending:jsonbored/gittensory#806:shaDeferred", "1"]]),
      async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; },
      async set(key: string, value: string): Promise<void> { this.values.set(key, value); },
      async del(key: string): Promise<void> { this.values.delete(key); },
    };
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
    AI: { run: async () => ({ response: JSON.stringify({ assessment: "Fresh opinion.", blockers: [], nits: [], suggestions: [] }) }) } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
      SELFHOST_TRANSIENT_CACHE: cache,
    });
    await seedRecoveryRepo(env);
    await seedPr(env, 806, "shaDeferred");
    // CI PENDING is the load-bearing part: the pass defers inside prReadyForReview and its CI-wait
    // placeholder republishes the ticked panel BEFORE the #7626 marker would be consumed -- exactly the
    // window in which a deferring retrigger's own click must not be misread as lost.
    stubGitHub(806, "shaDeferred", TICKED_LIVE_PANEL, { ciPending: true });

    await reReviewStoredPullRequest(env, "sweep-natural-806", 123, "JSONbored/gittensory", 806);

    expect(await recoveredEventCount(env)).toBe(0);
    // ...and the marker survives untouched for the pass that WILL honor it once CI settles.
    expect(cache.values.get("pr-panel-retrigger-pending:jsonbored/gittensory#806:shaDeferred")).toBe("1");
  });

  it("a ghost PR (no head SHA, no created_at) still recovers — the marker guard is skipped, never crashed", async () => {
    // The no-head-ghost-PR shape the placeholder logic already special-cases: recovery cannot key a pending
    // marker without a SHA, so it proceeds straight to recovering (the safe direction for an explicit click),
    // and the enqueued job simply omits the optional prCreatedAt sort key.
    const env = await recoveryEnv();
    const sent: Array<{ deliveryId?: string; prCreatedAt?: string }> = [];
    (env as { JOBS: Queue }).JOBS = { send: async (job: unknown) => { sent.push(job as never); } } as unknown as Queue;
    await seedRecoveryRepo(env);
    await upsertPullRequestFromGitHub(env, "JSONbored/gittensory", {
      number: 807,
      title: "Ghost PR",
      state: "open",
      user: { login: "contributor" },
      author_association: "CONTRIBUTOR",
      head: { sha: "" },
      base: { ref: "main" },
      labels: [],
      body: "Closes #1",
    } as never);
    stubGitHub(807, "", TICKED_LIVE_PANEL);

    await reReviewStoredPullRequest(env, "sweep-ghost-807", 123, "JSONbored/gittensory", 807);

    expect(await recoveredEventCount(env)).toBe(1);
    const recovery = sent.find((job) => job.deliveryId?.startsWith("panel-retrigger-recovery:"));
    expect(recovery).toBeDefined();
    expect(recovery?.prCreatedAt).toBeUndefined(); // the conditional-spread arm: no createdAt, no sort key
  });

  it("countAuditEventsForTargetSince returns 0 for an empty event-type list without touching the DB", async () => {
    const { countAuditEventsForTargetSince } = await import("../../src/db/repositories");
    const env = await recoveryEnv();
    expect(await countAuditEventsForTargetSince(env, [], "o/r#1", new Date(0).toISOString())).toBe(0);
  });

  it("INVARIANT: a box the panel shows UNTICKED recovers nothing — the common case costs one string scan", async () => {
    const env = await recoveryEnv();
    await seedRecoveryRepo(env);
    await seedPr(env, 804, "shaClean");
    stubGitHub(804, "shaClean", UNTICKED_LIVE_PANEL);

    await reReviewStoredPullRequest(env, "sweep-natural-804", 123, "JSONbored/gittensory", 804);

    expect(await recoveredEventCount(env)).toBe(0);
  });

  it("INVARIANT: no prior panel comment at all (first publish) recovers nothing", async () => {
    const env = await recoveryEnv();
    await seedRecoveryRepo(env);
    await seedPr(env, 805, "shaFirst");
    stubGitHub(805, "shaFirst", null);

    await reReviewStoredPullRequest(env, "sweep-first-805", 123, "JSONbored/gittensory", 805);

    expect(await recoveredEventCount(env)).toBe(0);
  });
});
