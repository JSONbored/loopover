import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPullRequest,
  upsertInstallation,
  upsertPullRequestFile,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { clearInstallationTokenCacheForTest } from "../../src/github/app";
import { clearGitHubResponseCacheForTest } from "../../src/github/client";
import { fallbackShotR2Key, FALLBACK_ARTIFACT_NAME, isFallbackDispatchInFlight, markFallbackDispatched } from "../../src/review/visual/actions-fallback";
import { processJob } from "../../src/queue/processors";
import { createTestEnv } from "../helpers/d1";

// Mirrors test/unit/queue.test.ts's own generatePrivateKeyPem helper -- createInstallationToken mints a real
// JWT, so the default createTestEnv placeholder key ("test-private-key") won't do for any test that reaches it.
async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Minimal single-entry-per-file ZIP builder (mirrors test/unit/actions-fallback.test.ts's own fixture, kept
 *  file-local rather than shared since it's a small, self-contained test fixture, not production code). */
function buildZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const compressed = new Uint8Array(deflateRawSync(Buffer.from(file.data)));
    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(8, 8, true);
    localHeader.setUint32(18, compressed.length, true);
    localHeader.setUint32(22, file.data.length, true);
    localHeader.setUint16(26, nameBytes.length, true);
    const localEntry = concatBytes([new Uint8Array(localHeader.buffer), nameBytes, compressed]);
    localParts.push(localEntry);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(10, 8, true);
    centralHeader.setUint32(20, compressed.length, true);
    centralHeader.setUint32(24, file.data.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint32(42, offset, true);
    centralParts.push(concatBytes([new Uint8Array(centralHeader.buffer), nameBytes]));

    offset += localEntry.length;
  }
  const centralDirOffset = offset;
  const centralDirBytes = concatBytes(centralParts);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralDirBytes.length, true);
  eocd.setUint32(16, centralDirOffset, true);
  return concatBytes([...localParts, centralDirBytes, new Uint8Array(eocd.buffer)]);
}

function memoryReviewAudit(): R2Bucket {
  const store = new Map<string, Uint8Array>();
  return {
    async get(key: string) {
      const bytes = store.get(key);
      return bytes ? ({ body: new Response(bytes).body } as unknown as R2ObjectBody) : null;
    },
    async put(key: string, value: unknown) {
      const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      store.set(key, bytes);
      return { key } as unknown as R2Object;
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as R2Bucket;
}

async function seedRepoAndPr(env: ReturnType<typeof createTestEnv>, headSha: string): Promise<void> {
  await upsertInstallation(env, {
    action: "created",
    installation: { id: 9101, account: { login: "owner", id: 1, type: "Organization" }, target_type: "Organization", repository_selection: "selected", permissions: {}, events: [] },
  });
  await upsertRepositoryFromGitHub(env, { name: "fallback-repo", full_name: "owner/fallback-repo", private: false, owner: { login: "owner" }, default_branch: "main" }, 9101);
  await upsertRepositorySettings(env, {
    repoFullName: "owner/fallback-repo",
    autonomy: { merge: "observe", update_branch: "observe" },
    aiReviewMode: "off",
    gatePack: "oss-anti-slop",
    gateCheckMode: "off",
    checkRunMode: "off",
    commentMode: "off",
    publicSurface: "off",
  });
  await upsertPullRequestFromGitHub(env, "owner/fallback-repo", {
    number: 55,
    title: "Add a pricing page",
    state: "open",
    user: { login: "contributor" },
    head: { sha: headSha },
    base: { ref: "main" },
    labels: [],
    body: "Closes #1",
  });
}

function baseFetchStub(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (url.includes(pattern)) return handler();
    }
    if (url === "https://api.gittensor.io/miners") return Response.json([]);
    if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
    if (/\/pulls\/55(?:\?|$)/.test(url) && method === "GET") {
      return Response.json({ number: 55, title: "Add a pricing page", state: "open", user: { login: "contributor" }, head: { sha: "cafebabecafebabecafebabecafebabecafebabe" }, mergeable_state: "clean", labels: [], body: "Closes #1" });
    }
    if (url.includes("/pulls/55/files")) return Response.json([]);
    return Response.json({});
  };
}

afterEach(() => {
  clearGitHubResponseCacheForTest();
  clearInstallationTokenCacheForTest();
  vi.unstubAllGlobals();
});

describe("workflow_run webhook -> actions_fallback storage (#4112)", () => {
  it("stores the fallback's captured PNGs in R2 and re-reviews the correlated PR", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");

    const zip = buildZip([
      { name: "root--desktop.png", data: new TextEncoder().encode("desktop-bytes") },
      { name: "root--mobile.png", data: new TextEncoder().encode("mobile-bytes") },
    ]);

    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/501/artifacts": () => Response.json({ artifacts: [{ id: 9, name: FALLBACK_ARTIFACT_NAME, expired: false }] }),
        "/actions/artifacts/9/zip": () => new Response(null, { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/blob.zip" } }),
        "pipelines.actions.githubusercontent.com": () => new Response(zip.buffer as ArrayBuffer, { status: 200 }),
      }),
    );

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "fallback-run-501",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: {
          id: 501,
          name: "Gittensory Visual Capture Fallback",
          event: "workflow_dispatch",
          conclusion: "success",
          display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe",
        },
      },
    } as never);

    const desktopKey = await fallbackShotR2Key("cafebabecafebabecafebabecafebabecafebabe", "/", "desktop");
    const mobileKey = await fallbackShotR2Key("cafebabecafebabecafebabecafebabecafebabe", "/", "mobile");
    const desktopObj = await env.REVIEW_AUDIT!.get(desktopKey);
    const mobileObj = await env.REVIEW_AUDIT!.get(mobileKey);
    expect(desktopObj).not.toBeNull();
    expect(mobileObj).not.toBeNull();
    expect(new TextDecoder().decode(await new Response(desktopObj!.body).arrayBuffer())).toBe("desktop-bytes");

    // The PR row still exists + is untouched in state -- the re-review ran without throwing.
    expect(await getPullRequest(env, "owner/fallback-repo", 55)).toMatchObject({ state: "open" });
  });

  it("stores partial shots when only some route/viewport combinations are present in the artifact", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");

    // Only the desktop shot is present in the artifact -- the mobile one for the same route must be silently
    // skipped (no crash), while desktop still lands in R2.
    const zip = buildZip([{ name: "root--desktop.png", data: new TextEncoder().encode("desktop-only") }]);
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/510/artifacts": () => Response.json({ artifacts: [{ id: 10, name: FALLBACK_ARTIFACT_NAME }] }),
        "/actions/artifacts/10/zip": () => new Response(null, { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/blob.zip" } }),
        "pipelines.actions.githubusercontent.com": () => new Response(zip.buffer as ArrayBuffer, { status: 200 }),
      }),
    );

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "fallback-run-510",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 510, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
      },
    } as never);

    const desktopKey = await fallbackShotR2Key("cafebabecafebabecafebabecafebabecafebabe", "/", "desktop");
    const mobileKey = await fallbackShotR2Key("cafebabecafebabecafebabecafebabecafebabe", "/", "mobile");
    expect(await env.REVIEW_AUDIT!.get(desktopKey)).not.toBeNull();
    expect(await env.REVIEW_AUDIT!.get(mobileKey)).toBeNull();
  });

  it("derives the route from the PR's own stored changed files, not just the default '/'", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    await upsertPullRequestFile(env, {
      repoFullName: "owner/fallback-repo",
      pullNumber: 55,
      path: "apps/gittensory-ui/src/routes/app.index.tsx",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      payload: { patch: "@@\n+export default function App() { return null; }" },
    });

    const zip = buildZip([{ name: "app--desktop.png", data: new TextEncoder().encode("app-desktop") }]);
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/520/artifacts": () => Response.json({ artifacts: [{ id: 20, name: FALLBACK_ARTIFACT_NAME }] }),
        "/actions/artifacts/20/zip": () => new Response(null, { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/blob.zip" } }),
        "pipelines.actions.githubusercontent.com": () => new Response(zip.buffer as ArrayBuffer, { status: 200 }),
      }),
    );

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "fallback-run-520",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 520, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
      },
    } as never);

    const appDesktopKey = await fallbackShotR2Key("cafebabecafebabecafebabecafebabecafebabe", "/app", "desktop");
    const rootDesktopKey = await fallbackShotR2Key("cafebabecafebabecafebabecafebabecafebabe", "/", "desktop");
    expect(await env.REVIEW_AUDIT!.get(appDesktopKey)).not.toBeNull();
    expect(await env.REVIEW_AUDIT!.get(rootDesktopKey)).toBeNull();
  });

  it("stores nothing (never throws) when the run's artifact list comes back empty", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/511/artifacts": () => Response.json({ artifacts: [] }),
      }),
    );

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "fallback-run-511",
        eventName: "workflow_run",
        payload: {
          action: "completed",
          repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
          installation: { id: 9101 },
          workflow_run: { id: 511, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
        },
      } as never),
    ).resolves.toBeUndefined();

    const desktopKey = await fallbackShotR2Key("cafebabecafebabecafebabecafebabecafebabe", "/", "desktop");
    expect(await env.REVIEW_AUDIT!.get(desktopKey)).toBeNull();
  });

  it("stores nothing (never throws) when REVIEW_AUDIT isn't configured", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo" });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    let artifactsListCalled = false;
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/": () => {
          artifactsListCalled = true;
          return Response.json({ artifacts: [] });
        },
      }),
    );

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "fallback-run-512",
        eventName: "workflow_run",
        payload: {
          action: "completed",
          repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
          installation: { id: 9101 },
          workflow_run: { id: 512, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
        },
      } as never),
    ).resolves.toBeUndefined();
    // Never even attempts to list artifacts without a place to store them.
    expect(artifactsListCalled).toBe(false);
  });

  it("stores nothing (never throws) when minting the installation token fails", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/access_tokens": () => new Response("forbidden", { status: 403 }),
      }),
    );

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "fallback-run-513",
        eventName: "workflow_run",
        payload: {
          action: "completed",
          repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
          installation: { id: 9101 },
          workflow_run: { id: 513, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
        },
      } as never),
    ).resolves.toBeUndefined();

    const desktopKey = await fallbackShotR2Key("cafebabecafebabecafebabecafebabecafebabe", "/", "desktop");
    expect(await env.REVIEW_AUDIT!.get(desktopKey)).toBeNull();
  });

  it("still returns the stored shot even when persisting it to R2 fails (fire-and-forget put, mirrors capture.ts's own pattern)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo" });
    const failingAudit: R2Bucket = {
      async get() {
        return null;
      },
      async put() {
        throw new Error("simulated R2 write failure");
      },
    } as unknown as R2Bucket;
    env.REVIEW_AUDIT = failingAudit;
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    const zip = buildZip([{ name: "root--desktop.png", data: new TextEncoder().encode("x") }]);
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/514/artifacts": () => Response.json({ artifacts: [{ id: 14, name: FALLBACK_ARTIFACT_NAME }] }),
        "/actions/artifacts/14/zip": () => new Response(null, { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/blob.zip" } }),
        "pipelines.actions.githubusercontent.com": () => new Response(zip.buffer as ArrayBuffer, { status: 200 }),
      }),
    );

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "fallback-run-514",
        eventName: "workflow_run",
        payload: {
          action: "completed",
          repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
          installation: { id: 9101 },
          workflow_run: { id: 514, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
        },
      } as never),
    ).resolves.toBeUndefined();
  });

  it("ignores a workflow_run whose name doesn't match this module's own workflow", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    let artifactsListCalled = false;
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/": () => {
          artifactsListCalled = true;
          return Response.json({ artifacts: [] });
        },
      }),
    );

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "unrelated-run",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 502, name: "CI", event: "workflow_dispatch", conclusion: "success", display_title: "CI" },
      },
    } as never);

    expect(artifactsListCalled).toBe(false);
  });

  it("ignores a matching-name run that was NOT triggered by workflow_dispatch", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    let artifactsListCalled = false;
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/": () => {
          artifactsListCalled = true;
          return Response.json({ artifacts: [] });
        },
      }),
    );

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "wrong-trigger",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 503, name: "Gittensory Visual Capture Fallback", event: "pull_request", conclusion: "success", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
      },
    } as never);

    expect(artifactsListCalled).toBe(false);
  });

  it("records the webhook and does nothing further when the matching run FAILED", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    let artifactsListCalled = false;
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/": () => {
          artifactsListCalled = true;
          return Response.json({ artifacts: [] });
        },
      }),
    );

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "failed-run",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 504, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "failure", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
      },
    } as never);

    expect(artifactsListCalled).toBe(false);
  });

  it("does not clear the dispatch marker for a non-terminal workflow_run activity", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    await markFallbackDispatched(env, "cafebabecafebabecafebabecafebabecafebabe");
    let artifactsListCalled = false;
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/": () => {
          artifactsListCalled = true;
          return Response.json({ artifacts: [] });
        },
      }),
    );

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "requested-run-keeps-marker",
      eventName: "workflow_run",
      payload: {
        action: "requested",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 589, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: null, display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
      },
    } as never);

    expect(artifactsListCalled).toBe(false);
    await expect(isFallbackDispatchInFlight(env, "cafebabecafebabecafebabecafebabecafebabe")).resolves.toBe(true);
  });

  it("clears the dispatch marker on a FAILED run too (#4112 review fix -- a failed run shouldn't block a retry for the rest of the max-age window)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    await markFallbackDispatched(env, "cafebabecafebabecafebabecafebabecafebabe");
    await expect(isFallbackDispatchInFlight(env, "cafebabecafebabecafebabecafebabecafebabe")).resolves.toBe(true);
    vi.stubGlobal("fetch", baseFetchStub({}));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "failed-run-clears-marker",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 590, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "failure", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
      },
    } as never);

    await expect(isFallbackDispatchInFlight(env, "cafebabecafebabecafebabecafebabecafebabe")).resolves.toBe(false);
  });

  it("clears the dispatch marker on a SUCCESSFUL run as well", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    await markFallbackDispatched(env, "cafebabecafebabecafebabecafebabecafebabe");
    vi.stubGlobal("fetch", baseFetchStub({ "/actions/runs/": () => Response.json({ artifacts: [] }) }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "success-run-clears-marker",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 591, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
      },
    } as never);

    await expect(isFallbackDispatchInFlight(env, "cafebabecafebabecafebabecafebabecafebabe")).resolves.toBe(false);
  });

  it("does not clear any marker when the run's display_title doesn't correlate to a PR (nothing to key the clear on)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    await markFallbackDispatched(env, "cafebabecafebabecafebabecafebabecafebabe");
    vi.stubGlobal("fetch", baseFetchStub({}));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "uncorrelated-run-leaves-marker",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 592, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success", display_title: "manually triggered" },
      },
    } as never);

    // The marker is keyed by headSha "cafebabe...", which this run's uncorrelated title can't recover --
    // it must stay untouched (still in flight) rather than being guessed/cleared.
    await expect(isFallbackDispatchInFlight(env, "cafebabecafebabecafebabecafebabecafebabe")).resolves.toBe(true);
  });

  it("does nothing when the run's display_title doesn't correlate to a PR (never guesses)", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), GITTENSORY_REVIEW_REPOS: "owner/fallback-repo", REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    let artifactsListCalled = false;
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/": () => {
          artifactsListCalled = true;
          return Response.json({ artifacts: [] });
        },
      }),
    );

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "no-correlation",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 505, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success", display_title: "manually triggered" },
      },
    } as never);

    expect(artifactsListCalled).toBe(false);
  });

  it("does nothing when the repo isn't on the convergence allowlist", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(), REVIEW_AUDIT: memoryReviewAudit() });
    await seedRepoAndPr(env, "cafebabecafebabecafebabecafebabecafebabe");
    let artifactsListCalled = false;
    vi.stubGlobal(
      "fetch",
      baseFetchStub({
        "/actions/runs/": () => {
          artifactsListCalled = true;
          return Response.json({ artifacts: [] });
        },
      }),
    );

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "not-allowlisted",
      eventName: "workflow_run",
      payload: {
        action: "completed",
        repository: { name: "fallback-repo", full_name: "owner/fallback-repo", owner: { login: "owner" } },
        installation: { id: 9101 },
        workflow_run: { id: 506, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success", display_title: "gittensory-visual-fallback pr=55 sha=cafebabecafebabecafebabecafebabecafebabe" },
      },
    } as never);

    expect(artifactsListCalled).toBe(false);
  });

  it("does not process a workflow_run event with no repository/installation on the payload", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
    vi.stubGlobal("fetch", async () => new Response("unexpected", { status: 500 }));

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "no-repo",
        eventName: "workflow_run",
        payload: { action: "completed", workflow_run: { id: 507, name: "Gittensory Visual Capture Fallback", event: "workflow_dispatch", conclusion: "success" } },
      } as never),
    ).resolves.toBeUndefined();
  });
});
