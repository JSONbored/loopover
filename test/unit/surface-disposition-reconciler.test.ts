import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { processJob } from "../../src/queue/processors";
import {
  DISPOSITION_CONSIDERED_EVENT_TYPE,
  reconcileSurfaceWithoutDisposition,
  SURFACE_DISPOSITION_RECONCILE_LIMIT,
  SURFACE_DISPOSITION_RECONCILE_LOOKBACK_MS,
} from "../../src/review/surface-disposition-reconciler";
import { createTestEnv } from "../helpers/d1";
import { generatePrivateKeyPem } from "../helpers/github-app-key";

function envWithQueue(): { env: Env; sent: unknown[] } {
  const sent: unknown[] = [];
  const env = createTestEnv();
  (env as unknown as { JOBS: { send: (msg: unknown) => Promise<void> } }).JOBS = {
    send: async (msg: unknown) => void sent.push(msg),
  };
  return { env, sent };
}

async function seedPr(env: Env, number: number, headSha: string, opts: { lastPublishedSurfaceSha?: string | null; installationId?: number } = {}): Promise<void> {
  const installationId = opts.installationId ?? 77;
  await upsertInstallation(env, {
    installation: { id: installationId, account: { login: "alice", id: installationId, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["pull_request"] },
  });
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "alice/repo", private: false, owner: { login: "alice" } }, installationId);
  await upsertPullRequestFromGitHub(env, "alice/repo", { number, title: `PR ${number}`, state: "open", user: { login: "bob" }, head: { sha: headSha }, labels: [], body: "b" });
  if (opts.lastPublishedSurfaceSha !== undefined) {
    await env.DB.prepare("UPDATE pull_requests SET last_published_surface_sha = ? WHERE repo_full_name = ? AND number = ?")
      .bind(opts.lastPublishedSurfaceSha, "alice/repo", number)
      .run();
  }
}

async function recordDispositionMarker(env: Env, number: number, headSha: string): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_events (id, event_type, actor, target_key, outcome, detail, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(
      crypto.randomUUID(),
      DISPOSITION_CONSIDERED_EVENT_TYPE,
      "loopover",
      `alice/repo#${number}#${headSha}`,
      "completed",
      "maintenance actuation lock claimed; disposition attempt begins for this head",
      "{}",
      new Date().toISOString(),
    )
    .run();
}

// #8997: a deploy restart can kill the pass between the public-surface publish and the disposition
// plan/execute for the SAME head. The panel/check-run/CI aggregate are all current for that head (publish
// completed before the kill), so the ordinary stale-surface repair check sees nothing wrong — the confirmed
// "decisive panel, PR still open" shape (#8965: panel published 14:55:24Z, matching close only landed
// 15:07:53Z, ~12 minutes later, purely because an unrelated later sweep happened to re-run the whole pass).
// The write side of the same fix: maybeRunAgentMaintenance (processors.ts) records the marker the moment it
// claims the per-PR actuation lock for a head — i.e. the moment a real disposition attempt begins — so a real,
// end-to-end pass leaves the exact row the scan above reads.
describe("maybeRunAgentMaintenance records the disposition marker (#8997)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes the marker once a real maintenance pass claims the actuation lock for this head", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    await upsertInstallation(env, {
      action: "created",
      installation: { id: 9500, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] },
    });
    await upsertRepositoryFromGitHub(env, { name: "marker-repo", full_name: "owner/marker-repo", private: false, owner: { login: "owner" } }, 9500);
    await upsertRepositorySettings(env, { repoFullName: "owner/marker-repo", autonomy: { review_state_label: "auto" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (/\/pulls\/40(?:\?|$)/.test(url)) return Response.json({ number: 40, title: "Real pass", state: "open", user: { login: "contributor" }, head: { sha: "m1" }, labels: [] });
      if (url.includes("/commits/m1/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes("/commits/m1/status")) return Response.json({ statuses: [] });
      if (url.includes("/check-runs")) return Response.json({ id: 901 }, { status: 201 });
      return new Response("not found", { status: 404 });
    });

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "marker-1",
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: 9500 },
        repository: { name: "marker-repo", full_name: "owner/marker-repo", private: false, owner: { login: "owner" } },
        pull_request: { number: 40, title: "Real pass", state: "open", user: { login: "contributor" }, head: { sha: "m1" }, labels: [], body: "x" },
      },
    });

    const row = await env.DB.prepare("select target_key as targetKey from audit_events where event_type = ?").bind(DISPOSITION_CONSIDERED_EVENT_TYPE).first<{ targetKey: string }>();
    expect(row?.targetKey).toBe("owner/marker-repo#40#m1");
  });
});

describe("reconcileSurfaceWithoutDisposition (#8997)", () => {
  it("re-enqueues a regate for a PR whose current-head surface has no disposition marker", async () => {
    const { env, sent } = envWithQueue();
    await seedPr(env, 1, "sha1", { lastPublishedSurfaceSha: "sha1" });

    expect(await reconcileSurfaceWithoutDisposition(env)).toEqual({ scanned: 1, requeued: 1 });
    expect(sent).toEqual([{ type: "agent-regate-pr", deliveryId: "surface-without-disposition:alice/repo#1#sha1", repoFullName: "alice/repo", prNumber: 1, installationId: 77 }]);
  });

  it("does NOT re-enqueue once a disposition marker is on record for that exact head", async () => {
    const { env, sent } = envWithQueue();
    await seedPr(env, 2, "sha1", { lastPublishedSurfaceSha: "sha1" });
    await recordDispositionMarker(env, 2, "sha1");

    expect(await reconcileSurfaceWithoutDisposition(env)).toEqual({ scanned: 0, requeued: 0 });
    expect(sent).toEqual([]);
  });

  it("does NOT flag a PR whose surface is stale — that is the pre-existing outage-repair check's job", async () => {
    const { env, sent } = envWithQueue();
    // Surface still describes an OLDER head; publish itself never completed for the current one.
    await seedPr(env, 3, "sha-new", { lastPublishedSurfaceSha: "sha-old" });

    expect(await reconcileSurfaceWithoutDisposition(env)).toEqual({ scanned: 0, requeued: 0 });
    expect(sent).toEqual([]);
  });

  it("a marker is scoped to its own head SHA — a stale marker from a prior commit does not cover a new push", async () => {
    const { env, sent } = envWithQueue();
    await seedPr(env, 4, "sha-new", { lastPublishedSurfaceSha: "sha-new" });
    // The marker was recorded for the PR's PREVIOUS head; a fresh push moved the head with no new marker yet.
    await recordDispositionMarker(env, 4, "sha-old");

    expect(await reconcileSurfaceWithoutDisposition(env)).toEqual({ scanned: 1, requeued: 1 });
    expect(sent).toHaveLength(1);
  });

  it("leaves a closed/merged PR alone — there is no live disposition left to reconcile", async () => {
    const { env, sent } = envWithQueue();
    await seedPr(env, 5, "sha1", { lastPublishedSurfaceSha: "sha1" });
    await env.DB.prepare("UPDATE pull_requests SET state = 'closed' WHERE repo_full_name = ? AND number = ?").bind("alice/repo", 5).run();

    expect(await reconcileSurfaceWithoutDisposition(env)).toEqual({ scanned: 0, requeued: 0 });
    expect(sent).toEqual([]);
  });

  it("ignores anything older than the lookback window", async () => {
    const { env } = envWithQueue();
    await seedPr(env, 6, "sha1", { lastPublishedSurfaceSha: "sha1" });

    expect(await reconcileSurfaceWithoutDisposition(env, Date.now() + SURFACE_DISPOSITION_RECONCILE_LOOKBACK_MS + 60_000)).toEqual({ scanned: 0, requeued: 0 });
  });

  it("does not count a rescue whose enqueue failed", async () => {
    const { env } = envWithQueue();
    await seedPr(env, 7, "sha1", { lastPublishedSurfaceSha: "sha1" });
    (env as unknown as { JOBS: { send: () => Promise<void> } }).JOBS = { send: async () => Promise.reject(new Error("queue down")) };

    expect(await reconcileSurfaceWithoutDisposition(env)).toEqual({ scanned: 1, requeued: 0 });
  });

  it("returns an empty result instead of throwing when the scan fails", async () => {
    const { env } = envWithQueue();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("db unavailable");
    });

    expect(await reconcileSurfaceWithoutDisposition(env)).toEqual({ scanned: 0, requeued: 0 });
    expect(warn.mock.calls.some(([line]) => String(line).includes("surface_disposition_reconcile_scan_failed"))).toBe(true);
    vi.restoreAllMocks();
  });

  it("bounds each run so a large backlog drains across runs instead of blocking one", () => {
    expect(SURFACE_DISPOSITION_RECONCILE_LIMIT).toBeGreaterThan(0);
    expect(SURFACE_DISPOSITION_RECONCILE_LIMIT).toBeLessThanOrEqual(1000);
  });

  it("skips a PR belonging to an uninstalled/unregistered repository — nothing to enqueue against", async () => {
    const { env, sent } = envWithQueue();
    await upsertRepositoryFromGitHub(env, { name: "orphan-repo", full_name: "alice/orphan-repo", private: false, owner: { login: "alice" } });
    await upsertPullRequestFromGitHub(env, "alice/orphan-repo", { number: 8, title: "PR 8", state: "open", user: { login: "bob" }, head: { sha: "sha1" }, labels: [], body: "b" });
    await env.DB.prepare("UPDATE pull_requests SET last_published_surface_sha = ? WHERE repo_full_name = ? AND number = ?").bind("sha1", "alice/orphan-repo", 8).run();

    expect(await reconcileSurfaceWithoutDisposition(env)).toEqual({ scanned: 0, requeued: 0 });
    expect(sent).toEqual([]);
  });
});
