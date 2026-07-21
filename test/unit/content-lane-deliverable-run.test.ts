// #content-lane-deliverable: processor wiring for runContentLaneDeliverableCheckForAdvisory. The pure
// detection logic (checkContentLaneDeliverable) is exhaustively covered in
// test/unit/content-lane-registry-logic.test.ts; this file covers the host wiring: mode gating, spec
// resolution (a no-op for a repo with no content-lane spec, matching the "never metagraphed-specific"
// design), the issue fetch, and the finding push.
import { afterEach, describe, expect, it, vi } from "vitest";
import { runContentLaneDeliverableCheckForAdvisory } from "../../src/queue/processors";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import type { Advisory, PullRequestFileRecord, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

describe("runContentLaneDeliverableCheckForAdvisory (processor wiring, #content-lane-deliverable)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearInstallationTokenCacheForTest();
  });

  function advisory(over: Partial<Advisory> = {}): Advisory {
    return {
      id: "adv-deliverable",
      targetType: "pull_request",
      targetKey: "acme/widgets#7",
      repoFullName: "acme/widgets",
      pullNumber: 7,
      headSha: "sha7",
      conclusion: "neutral",
      severity: "info",
      title: "LoopOver advisory available",
      summary: "ok",
      findings: [],
      generatedAt: "2026-07-21T00:00:00.000Z",
      ...over,
    };
  }

  const files: PullRequestFileRecord[] = [
    { repoFullName: "acme/widgets", pullNumber: 7, path: "tests/foo-verify.test.mjs", status: "added", additions: 40, deletions: 0, changes: 40, payload: {} },
  ];
  const pr = { linkedIssues: [1275] };
  const blockMode = { contentLaneDeliverableGateMode: "block" } as RepositorySettings;
  const advisoryMode = { contentLaneDeliverableGateMode: "advisory" } as RepositorySettings;
  const offMode = { contentLaneDeliverableGateMode: "off" } as RepositorySettings;

  async function seedContentLaneRepo(env: Awaited<ReturnType<typeof createTestEnv>>): Promise<void> {
    await upsertRepoFocusManifest(env, "acme/widgets", {
      contentLane: { entryFileGlob: "registry/subnets/*.json", collectionField: "surfaces" },
    });
  }

  function stubIssueFetch(issue: { title?: string; body?: string } = {}): void {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1275")) {
        return Response.json({
          number: 1275,
          state: "open",
          title: issue.title ?? "Add missing surfaces",
          body: issue.body ?? "Missing surfaces to add to registry/subnets/foo.json.",
        });
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("no-ops when contentLaneDeliverableGateMode is off (default) — no fetch attempted", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: offMode, advisory: adv, repoFullName: "acme/widgets", pr, files, installationId: 1 });
    expect(adv.findings).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("REGRESSION (#token-bleed-spend-gate): a paused mode never fetches, even with block mode configured", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "paused", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, files, installationId: 1 });
    expect(adv.findings).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when the PR has no linked issues (defense-in-depth; the call site itself also gates on this)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr: { linkedIssues: [] }, files, installationId: 1 });
    expect(adv.findings).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no-ops when no content-lane spec resolves for this repo (never metagraphed-specific — a repo with no contentLane: config is simply a no-op)", async () => {
    // LOOPOVER_REVIEW_REPOS explicitly cleared -- the test helper's own default allowlist includes
    // "acme/widgets" (matching other content-lane tests' fixtures), which this ONE test must NOT ride on:
    // no contentLane: config and no allowlist entry is exactly the "not a content-lane repo at all" case.
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: "" });
    stubIssueFetch();
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, files, installationId: 1 });
    expect(adv.findings).toEqual([]);
  });

  it("no-ops when the content-lane flag itself is off, even with a contentLane: config present", async () => {
    const env = createTestEnv({}); // LOOPOVER_REVIEW_CONTENT_LANE not set
    await seedContentLaneRepo(env);
    stubIssueFetch();
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, files, installationId: 1 });
    expect(adv.findings).toEqual([]);
  });

  it("no-ops when the linked issue cannot be fetched (fail-safe, never asserts a miss on missing data)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true" });
    await seedContentLaneRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("not found", { status: 404 });
    });
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, files, installationId: 1 });
    expect(adv.findings).toEqual([]);
  });

  it("no-ops when the issue text names no content-lane path at all (not-applicable, an unrelated issue)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true" });
    await seedContentLaneRepo(env);
    stubIssueFetch({ title: "Fix a flaky CI timeout", body: "The Worker API test suite times out intermittently." });
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, files, installationId: 1 });
    expect(adv.findings).toEqual([]);
  });

  it("no-ops when the PR actually delivers the content-lane file the issue names", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true" });
    await seedContentLaneRepo(env);
    stubIssueFetch();
    const adv = advisory();
    const deliveredFiles: PullRequestFileRecord[] = [...files, { repoFullName: "acme/widgets", pullNumber: 7, path: "registry/subnets/foo.json", status: "modified", additions: 3, deletions: 0, changes: 3, payload: {} }];
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, files: deliveredFiles, installationId: 1 });
    expect(adv.findings).toEqual([]);
  });

  it("regression: pushes a warning finding under advisory mode when the PR never touches the named content-lane file (the reported incident's exact shape)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true" });
    await seedContentLaneRepo(env);
    stubIssueFetch();
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: advisoryMode, advisory: adv, repoFullName: "acme/widgets", pr, files, installationId: 1 });
    expect(adv.findings).toHaveLength(1);
    expect(adv.findings[0]).toMatchObject({
      code: "content_lane_deliverable_missing",
      severity: "warning",
      detail: expect.stringContaining("registry/subnets/foo.json"),
    });
  });

  it("also pushes the same finding under block mode (the promotion to a hard blocker happens downstream via isConfiguredGateBlocker)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true" });
    await seedContentLaneRepo(env);
    stubIssueFetch();
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, files, installationId: 1 });
    expect(adv.findings.map((f) => f.code)).toEqual(["content_lane_deliverable_missing"]);
  });

  it("no-ops when the found issue has no usable title/body text at all (empty after trimming)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true" });
    await seedContentLaneRepo(env);
    stubIssueFetch({ title: "   ", body: "" });
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, files, installationId: 1 });
    expect(adv.findings).toEqual([]);
  });

  // #7060-class gap: METAGRAPHED_LANE_SPEC (resolved via the LOOPOVER_REVIEW_REPOS allowlist fallback when no
  // explicit `contentLane:` manifest config is present -- the real production path for JSONbored/metagraphed
  // itself) now catches its ~120 "MCP execute: verify + wire SN*" issues even though their bodies name no
  // literal registry path, via the issue title threaded through from fetchLinkedIssueFacts.
  it("REGRESSION (#7060-class gap): pushes a finding for METAGRAPHED_LANE_SPEC's own issue-title family even when the body names no literal path", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true", LOOPOVER_REVIEW_REPOS: "JSONbored/metagraphed" });
    stubIssueFetch({
      title: "MCP execute: verify + wire SN46 (Zipcode) once Phase 1 ships",
      body: "Fix that surface's entry in `registry/subnets/<slug>.json` and append a note. See https://zipcode.ai/openapi.json.",
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1275")) {
        return Response.json({
          number: 1275,
          state: "open",
          title: "MCP execute: verify + wire SN46 (Zipcode) once Phase 1 ships",
          body: "Fix that surface's entry in `registry/subnets/<slug>.json` and append a note. See https://zipcode.ai/openapi.json.",
        });
      }
      return new Response("not found", { status: 404 });
    });
    const adv = advisory();
    await runContentLaneDeliverableCheckForAdvisory(env, {
      mode: "live",
      settings: blockMode,
      advisory: adv,
      repoFullName: "JSONbored/metagraphed",
      pr,
      files,
      installationId: 1,
    });
    expect(adv.findings.map((f) => f.code)).toEqual(["content_lane_deliverable_missing"]);
  });

  it("fetch_error from fetchLinkedIssueFacts (e.g. the issue request rejecting outright) degrades to no-op, never throws (fetchLinkedIssueFacts's own internal try/catch never rethrows)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_CONTENT_LANE: "true" });
    await seedContentLaneRepo(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      throw new Error("network down");
    });
    const adv = advisory();
    await expect(
      runContentLaneDeliverableCheckForAdvisory(env, { mode: "live", settings: blockMode, advisory: adv, repoFullName: "acme/widgets", pr, files, installationId: 1 }),
    ).resolves.toBeUndefined();
    expect(adv.findings).toEqual([]);
  });
});
