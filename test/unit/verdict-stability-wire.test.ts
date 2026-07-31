import { afterEach, describe, expect, it, vi } from "vitest";
import { listAuditEventsByType, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import * as visualCaptureModule from "../../src/review/visual/capture";
import { MAX_CAPTURE_RETRY_ATTEMPTS } from "../../src/review/visual/preview-poll-budget";
import { processJob, reReviewStoredPullRequest } from "../../src/queue/processors";
import { verdictStabilityKey, writeVerdictStability } from "../../src/review/verdict-stability";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { asCloudEnv, createTestEnv } from "../helpers/d1";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

// #10222/#10227: the wiring #10204 shipped without a test. The backoff logic itself is covered by
// verdict-stability.test.ts; what was never covered is WHERE the guard sits. #10204 put it after the readiness
// gate, #10229 moved it one step earlier, and #10227 moved it OFF the pass entry entirely and onto the verdict-
// derivation choke point inside maybePublishPrPublicSurface. These tests pin what that placement must mean.

const REPO = "JSONbored/gittensory";
const HEAD = "sha-settled";

async function seed(env: ReturnType<typeof createTestEnv>) {
  await persistRegistrySnapshot(
    asCloudEnv(env),
    normalizeRegistryPayload({ [REPO]: { emission_share: 0.01, issue_discovery_share: 0 } }, { kind: "raw-github", url: "https://example.test" }, "2026-05-23T00:00:00.000Z"),
  );
  await upsertInstallation(env, {
    action: "created",
    installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "selected", permissions: {}, events: [] },
  });
  await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: REPO, private: false, owner: { login: "JSONbored" } }, 123);
  await upsertRepositorySettings(env, { repoFullName: REPO, autoLabelEnabled: false, autonomy: { label: "auto" } });
  await upsertPullRequestFromGitHub(env, REPO, {
    number: 77, title: "settled", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR",
    head: { sha: HEAD }, base: { ref: "main" }, labels: [], body: "Closes #1", created_at: "2026-07-31T09:00:00Z",
  } as never);
}

/** A verdict that has repeated enough to be settled, evaluated a moment ago -- so the backoff is engaged. */
async function seedSettledVerdict(env: ReturnType<typeof createTestEnv>) {
  await writeVerdictStability(env.SELFHOST_TRANSIENT_CACHE, verdictStabilityKey(REPO, 77, HEAD), {
    fingerprint: "hold|missing_linked_issue|",
    repeats: 8,
    lastEvaluatedMs: Date.now(),
  });
}

function stubGitHub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/access_tokens")) return Response.json({ token: "t" });
    if (url.endsWith("/pulls/77")) return Response.json({ number: 77, title: "settled", state: "open", user: { login: "contributor" }, head: { sha: HEAD }, labels: [], body: "Closes #1", mergeable_state: "clean" });
    if (url.includes("/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "t", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
    if (url.includes("/status")) return Response.json({ state: "success", statuses: [] });
    if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
    // The webhook path refreshes PR details before the publish unit, and those readers page over ARRAYS.
    if (/\/(files|reviews|commits|comments|labels|issues)(\?|$)/.test(url)) return Response.json([]);
    return Response.json({});
  });
}

async function skippedEvents(env: ReturnType<typeof createTestEnv>) {
  return listAuditEventsByType(env, "github_app.review_skipped_stable_verdict", "2000-01-01T00:00:00Z");
}

/** Did the pass DERIVE a verdict? #10227 moved the guard below readiness, the advisory build, miner detection
 *  and the type-label decision -- all of which a backed-off pass still owes and still runs -- so "did GitHub
 *  get read" is no longer a probe for anything. The maintenance pass is: it runs only on a DEFINED gate, and
 *  it is where persistDecisionRecord writes the ledger row `records_per_head` counts (#10184). So this event
 *  answers the only question the guard is about, and it is the metric the guard exists to move. */
async function verdictDerivedEvents(env: ReturnType<typeof createTestEnv>) {
  return listAuditEventsByType(env, "agent.maintenance.disposition_considered", "2000-01-01T00:00:00Z");
}

/** The same key processors.ts's pendingPrPanelRetriggerKey builds -- written directly because the marker
 *  writer is module-private to processors.ts. */
const RETRIGGER_KEY = `pr-panel-retrigger-pending:${REPO.toLowerCase()}#77:${HEAD}`;

describe("verdict-stability backoff wiring (#10222)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("backs off a settled verdict, and records why", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    stubGitHub();

    await reReviewStoredPullRequest(env, "d1", 123, REPO, 77);
    expect(await verdictDerivedEvents(env), "a backed-off pass must not derive a verdict or write a decision record").toHaveLength(0);
    expect(await skippedEvents(env)).toHaveLength(1);
  });

  it("REGRESSION: an explicit force is NEVER backed off", async () => {
    // #10204's guard ignored options.force, so an operator's manual re-gate could be silently suppressed.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    stubGitHub();

    await reReviewStoredPullRequest(env, "d2", 123, REPO, 77, undefined, { force: true });
    expect(await verdictDerivedEvents(env), "a forced pass must derive a fresh verdict").toHaveLength(1);
    expect(await skippedEvents(env)).toHaveLength(0);
  });

  it("#10227: a visual-preview poll tick no longer needs an exemption -- it is backed off, and its chain still runs", async () => {
    // INVERTED from #10229 on purpose, and this is the whole point of the redesign. previewPollAttempt was in
    // the allowlist only because the old guard sat at pass ENTRY, above the recapture chain, so exempting the
    // tick was the only way to keep the chain alive. A poll tick is machine-paced, not human-asked, so it has
    // no business in an escape hatch whose meaning is "a human asked for this pass". With the guard on the
    // derivation instead, the chain runs ABOVE it and the tick can be backed off like any other machine pass.
    // The chain-still-completes half is what the two `screenshot-table gate (#10061)` cases in
    // test/unit/queue-3.test.ts assert, end-to-end and against the real 5-attempt budget.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    stubGitHub();

    await reReviewStoredPullRequest(env, "d3", 123, REPO, 77, 2);
    expect(await verdictDerivedEvents(env)).toHaveLength(0);
    expect(await skippedEvents(env)).toHaveLength(1);
  });

  it("REGRESSION: a consumed panel-retrigger click gets the review it asked for, same pass (#7626)", async () => {
    // The failure #10204's placement caused: readiness consumed the one-shot marker, THEN the guard returned,
    // so the user's "Re-run LoopOver review" click vanished with nothing left to re-trigger it. #10229 fixed
    // that by making the marker SURVIVE the backed-off pass -- correct, but it still cost the user a round
    // trip. Consuming the marker threads forceAiReview, which is now exactly what the escape hatch keys on, so
    // the click is honoured by the very pass that consumed it. Strictly stronger than "the marker survives".
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    await env.SELFHOST_TRANSIENT_CACHE?.set(RETRIGGER_KEY, "1", 3600);
    stubGitHub();

    await reReviewStoredPullRequest(env, "d4", 123, REPO, 77);
    expect(await verdictDerivedEvents(env), "the pass the user clicked for must actually run").toHaveLength(1);
    expect(await skippedEvents(env)).toHaveLength(0);
  });

  it("never backs off a PR with no head SHA -- there is no key to have settled under", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    await upsertPullRequestFromGitHub(env, REPO, {
      number: 78, title: "no head", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR",
      base: { ref: "main" }, labels: [], body: "Closes #1", created_at: "2026-07-31T09:00:00Z",
    } as never);
    stubGitHub();

    await reReviewStoredPullRequest(env, "d6", 123, REPO, 78);
    expect(await skippedEvents(env)).toHaveLength(0);
  });

  it("does not back off a verdict that has not settled yet", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await writeVerdictStability(env.SELFHOST_TRANSIENT_CACHE, verdictStabilityKey(REPO, 77, HEAD), {
      fingerprint: "hold|missing_linked_issue|",
      repeats: 1,
      lastEvaluatedMs: Date.now(),
    });
    stubGitHub();

    await reReviewStoredPullRequest(env, "d5", 123, REPO, 77);
    expect(await verdictDerivedEvents(env)).toHaveLength(1);
    expect(await skippedEvents(env)).toHaveLength(0);
  });

  it("#10227: the WEBHOOK path is backed off too -- it was never guarded before", async () => {
    // The whole reason #10227 exists. 293 of 344 repeat evaluations in a 24h Orb window carried
    // `upstream_state_change` (deriveReevaluationReason's mapping for a RAW GitHub delivery), so the webhook
    // path is the DOMINANT churn source -- and #10204/#10229 guarded only reReviewStoredPullRequest, because
    // no pass-entry guard on this path could be made to spare #10061's recapture chain. Neither entry point
    // opts in now: both reach a verdict only through maybePublishPrPublicSurface's choke point.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    stubGitHub();

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "wh1",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: REPO, private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 77, title: "settled", state: "open", user: { login: "contributor" }, head: { sha: HEAD }, base: { ref: "main" }, labels: [], body: "Closes #1", mergeable_state: "clean" },
      },
    } as never);

    expect(await verdictDerivedEvents(env), "a settled webhook delivery must not re-derive the verdict").toHaveLength(0);
    expect(await skippedEvents(env)).toHaveLength(1);
  });

  it("#10227: the same webhook delivery DOES derive a verdict while the answer is still moving", async () => {
    // The other side of the branch above: backoff engages on a settled verdict, not on the webhook path as
    // such. Without this, the test above would also pass if the guard simply broke the webhook path.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    stubGitHub();

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "wh2",
      eventName: "pull_request",
      payload: {
        action: "synchronize",
        installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
        repository: { name: "gittensory", full_name: REPO, private: false, owner: { login: "JSONbored" } },
        pull_request: { number: 77, title: "settled", state: "open", user: { login: "contributor" }, head: { sha: HEAD }, base: { ref: "main" }, labels: [], body: "Closes #1", mergeable_state: "clean" },
      },
    } as never);

    expect(await verdictDerivedEvents(env)).toHaveLength(1);
    expect(await skippedEvents(env)).toHaveLength(0);
  });

  it("#10227: a backed-off pass still CHARGES the regate repair budget, deliberately", async () => {
    // A reversal of one of #10229's three fixes, made on purpose and pinned here so it stays a decision.
    // regatePullRequest charges its bounded repair budget on `onReachedReadiness`, whose documented rule is
    // "count executions, not deferrals" -- a pass that got PAST prReadyForReview executed. Under #10229's
    // pass-entry guard a backed-off pass was a deferral, so not charging was right. Under the choke point it
    // is an execution: readiness passed, the type-label decision ran, the capture chain advanced, and only the
    // verdict was skipped. Charging is also the anti-starvation direction -- a repair on a PR whose verdict is
    // permanently settled (#8886's shape: a hold that can never clear) would otherwise reselect on every sweep
    // tick forever without ever exhausting, which is the exact churn #10184 exists to stop.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    stubGitHub();

    let reachedReadiness = false;
    await reReviewStoredPullRequest(env, "d7", 123, REPO, 77, undefined, { onReachedReadiness: () => { reachedReadiness = true; } });
    expect(reachedReadiness, "a backed-off pass is an execution, not a deferral").toBe(true);
    expect(await verdictDerivedEvents(env)).toHaveLength(0);
    expect(await skippedEvents(env)).toHaveLength(1);
  });
});

// #10227: the property the redesign is FOR, stated once and generally. A bounded retry chain runs above the
// choke point, so an engaged backoff must not shorten it -- not by one attempt, and not for a chain nobody
// remembered to exempt. The #10061 chain is the instance that exists today and the one #10204's placement
// actually broke (5 attempts truncated to 3), so it is the instance measured here. Unlike the end-to-end cases
// in queue-3.test.ts, the backoff here is seeded ENGAGED before the first pass, so every pass in the loop is a
// backed-off one and the budget is spent entirely by passes that derived no verdict.

/** A minimal etag-aware in-memory R2 stand-in for the durable capture-retry budget (mirrors queue-3.test.ts's
 *  and preview-poll-budget.test.ts's own). */
function memoryBudgetStore(): R2Bucket {
  const store = new Map<string, { value: string; etag: string }>();
  let etagSeq = 0;
  return {
    async get(key: string) {
      const entry = store.get(key);
      return entry === undefined ? null : ({ body: new Response(entry.value).body, httpEtag: entry.etag } as unknown as R2ObjectBody);
    },
    async put(key: string, value: unknown, putOptions?: R2PutOptions) {
      const onlyIf = putOptions?.onlyIf as R2Conditional | undefined;
      const current = store.get(key);
      if (onlyIf?.etagMatches !== undefined && current?.etag !== onlyIf.etagMatches) return null;
      if (onlyIf?.etagDoesNotMatch === "*" && current !== undefined) return null;
      etagSeq += 1;
      const etag = `etag-${etagSeq}`;
      store.set(key, { value: await new Response(value as BodyInit).text(), etag });
      return { key, etag } as unknown as R2Object;
    },
  } as unknown as R2Bucket;
}

describe("bounded retry chains under an engaged backoff (#10227)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("spends its FULL budget even when every single pass is backed off", async () => {
    const capture = vi.spyOn(visualCaptureModule, "buildCapture").mockResolvedValue({
      routes: [{ path: "/app", afterUrl: "https://worker.example/loopover/shot?url=x", afterUrlMobile: "https://worker.example/loopover/shot?url=x" }],
      interactions: [],
      previewPending: false,
      renderFailed: true,
      previewUnobtainable: false,
    });
    const env = createTestEnv({
      GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
      LOOPOVER_REVIEW_SCREENSHOTS: "true",
      REVIEW_AUDIT: memoryBudgetStore(),
    });
    const sentJobs: Array<Record<string, unknown>> = [];
    env.JOBS = { async send(message: Record<string, unknown>) { sentJobs.push(message); } } as unknown as Queue;
    await seed(env);
    await upsertRepoFocusManifest(env, REPO, { settings: { commentMode: "all_prs", publicSurface: "comment_only", checkRunMode: "off", screenshotTableGate: { enabled: true }, reviewCheckMode: "required" } }, "repo_file");
    await seedSettledVerdict(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      if (url.endsWith("/pulls/77")) return Response.json({ number: 77, title: "settled", state: "open", user: { login: "contributor" }, head: { sha: HEAD }, labels: [], body: "Closes #1", mergeable_state: "clean" });
      if (url.includes("/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "t", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
      if (url.includes("/status")) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes("/pulls/77/files")) return Response.json([{ filename: "apps/loopover-ui/src/routes/app.index.tsx", status: "modified", additions: 5, deletions: 1, changes: 6, patch: "@@\n+const ok = true;" }]);
      if (/\/(files|reviews|commits|comments|labels|issues)(\?|$)/.test(url)) return Response.json([]);
      return Response.json({});
    });

    try {
      for (let attempt = 0; attempt < MAX_CAPTURE_RETRY_ATTEMPTS + 2; attempt += 1) {
        await reReviewStoredPullRequest(env, `chain-${attempt}`, 123, REPO, 77);
      }
    } finally {
      capture.mockRestore();
    }

    expect(await skippedEvents(env), "every pass in the loop must have been backed off").toHaveLength(MAX_CAPTURE_RETRY_ATTEMPTS + 2);
    expect(await verdictDerivedEvents(env), "and none of them derived a verdict").toHaveLength(0);
    expect(
      sentJobs.filter((job) => job.type === "recapture-preview"),
      "the chain must still complete its full budget -- not the VERDICT_BACKOFF_MIN_REPEATS truncation #10204 caused",
    ).toHaveLength(MAX_CAPTURE_RETRY_ATTEMPTS);
  });
});
