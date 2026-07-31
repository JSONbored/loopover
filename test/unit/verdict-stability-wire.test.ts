import { afterEach, describe, expect, it, vi } from "vitest";
import { listAuditEventsByType, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { reReviewStoredPullRequest } from "../../src/queue/processors";
import { verdictStabilityKey, writeVerdictStability } from "../../src/review/verdict-stability";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import { asCloudEnv, createTestEnv } from "../helpers/d1";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

// #10222: the wiring #10204 shipped without a test. The backoff logic itself is covered by
// verdict-stability.test.ts; what was never covered is WHERE the guard sits, and #10204 put it after the
// readiness gate -- which fires onReachedReadiness and consumes the one-shot panel-retrigger marker. These
// tests pin the three properties that placement got wrong.

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

function stubGitHub(onReadiness: () => void) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/access_tokens")) return Response.json({ token: "t" });
    // A files read means the pass got PAST the guard into the publish unit. Readiness itself deliberately
    // runs before the guard (#10061), so it is not the probe.
    if (url.includes("/files")) onReadiness();
    if (url.endsWith("/pulls/77")) return Response.json({ number: 77, title: "settled", state: "open", user: { login: "contributor" }, head: { sha: HEAD }, labels: [], body: "Closes #1", mergeable_state: "clean" });
    if (url.includes("/check-runs")) return Response.json({ total_count: 1, check_runs: [{ name: "t", status: "completed", conclusion: "success", app: { slug: "github-actions" } }] });
    if (url.includes("/status")) return Response.json({ state: "success", statuses: [] });
    if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
    return Response.json({});
  });
}

async function skippedEvents(env: ReturnType<typeof createTestEnv>) {
  return listAuditEventsByType(env, "github_app.review_skipped_stable_verdict", "2000-01-01T00:00:00Z");
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
    let reviewRan = false;
    stubGitHub(() => { reviewRan = true; });

    expect(await reReviewStoredPullRequest(env, "d1", 123, REPO, 77)).toBe(false);
    expect(reviewRan, "a backed-off pass must not reach the publish unit").toBe(false);
    expect(await skippedEvents(env)).toHaveLength(1);
  });

  it("REGRESSION: an explicit force is NEVER backed off", async () => {
    // #10204's guard ignored options.force, so an operator's manual re-gate could be silently suppressed.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    let reviewRan = false;
    stubGitHub(() => { reviewRan = true; });

    await reReviewStoredPullRequest(env, "d2", 123, REPO, 77, undefined, { force: true });
    expect(reviewRan, "a forced pass must proceed into the publish unit").toBe(true);
    expect(await skippedEvents(env)).toHaveLength(0);
  });

  it("REGRESSION: a visual-preview poll tick is NEVER backed off", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    let reviewRan = false;
    stubGitHub(() => { reviewRan = true; });

    await reReviewStoredPullRequest(env, "d3", 123, REPO, 77, 2);
    expect(reviewRan).toBe(true);
    expect(await skippedEvents(env)).toHaveLength(0);
  });

  it("REGRESSION: a backed-off pass does not eat the one-shot panel-retrigger marker (#7626)", async () => {
    // The failure #10204's placement caused: readiness consumed the marker, THEN the guard returned, so the
    // user's "Re-run LoopOver review" click vanished with nothing left to re-trigger it.
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    await env.SELFHOST_TRANSIENT_CACHE?.set(RETRIGGER_KEY, "1", 3600);
    stubGitHub(() => undefined);

    expect(await reReviewStoredPullRequest(env, "d4", 123, REPO, 77)).toBe(false);

    // The marker must still be there for a later pass to consume.
    const stillPending = await env.SELFHOST_TRANSIENT_CACHE?.get(RETRIGGER_KEY);
    expect(stillPending, "the retrigger marker must survive a backed-off pass").toBeTruthy();
  });

  it("never backs off a PR with no head SHA -- there is no key to have settled under", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await seed(env);
    await seedSettledVerdict(env);
    await upsertPullRequestFromGitHub(env, REPO, {
      number: 78, title: "no head", state: "open", user: { login: "contributor" }, author_association: "CONTRIBUTOR",
      base: { ref: "main" }, labels: [], body: "Closes #1", created_at: "2026-07-31T09:00:00Z",
    } as never);
    stubGitHub(() => undefined);

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
    let reviewRan = false;
    stubGitHub(() => { reviewRan = true; });

    await reReviewStoredPullRequest(env, "d5", 123, REPO, 77);
    expect(reviewRan).toBe(true);
    expect(await skippedEvents(env)).toHaveLength(0);
  });
});
