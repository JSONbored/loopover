import { afterEach, describe, expect, it, vi } from "vitest";
import { runVisualVisionForAdvisory } from "../../src/queue/processors";
import * as repositories from "../../src/db/repositories";
import { upsertRepositoryAiKey } from "../../src/db/repositories";
import * as submitterReputation from "../../src/review/submitter-reputation";
import type { CaptureRoute } from "../../src/review/visual/capture";
import type { AdvisoryFinding, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const pr = { number: 3 };
const repoFullName = "acme/widgets";

function byokEnv() {
  return createTestEnv({ TOKEN_ENCRYPTION_SECRET: "vision-test-encryption-secret-32b" });
}

function byokSettings(over: Partial<RepositorySettings> = {}): RepositorySettings {
  return { aiReviewByok: true, ...over } as RepositorySettings;
}

function findingsHolder(): { findings: AdvisoryFinding[] } {
  return { findings: [] };
}

function route(over: Partial<CaptureRoute> & { path: string }): CaptureRoute {
  return { ...over };
}

function findingsResponse(findings: Array<{ path: string; body: string }>) {
  return JSON.stringify({ findings });
}

function anthropicOk(text: string) {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
}

/** Routes fetch (shot PNGs) vs the AI provider call (api.anthropic.com) by URL, mirroring the shot-URL
 *  convention (`/gittensory/shot?key=...`) so a single fetch mock can serve both without a real network. */
function stubShotsAndProvider(providerResponseText: string | null) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "https://api.anthropic.com/v1/messages") {
      return providerResponseText === null
        ? new Response("upstream error", { status: 500 })
        : anthropicOk(providerResponseText);
    }
    if (url.includes("/gittensory/shot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    return new Response("not found", { status: 404 });
  }));
}

describe("runVisualVisionForAdvisory", () => {
  it("no-ops on an empty route list -- never touches D1 or the network", async () => {
    const env = byokEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: [],
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REGRESSION (#token-bleed-spend-gate): a paused mode never reaches the vision call, even with a non-empty route list", async () => {
    const env = byokEnv();
    stubShotsAndProvider(findingsResponse([{ path: "src/Button.tsx", body: "regressed" }]));
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "paused",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: [route({ path: "src/Button.tsx" })],
    });
    expect(adv.findings).toEqual([]);
  });

  it("handles a null author (ghost/deleted account) by treating it as an anonymous submitter, not a crash", async () => {
    const env = byokEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: null,
      confirmedContributor: false,
      settings: byokSettings({ aiReviewByok: false }),
      advisory: adv,
      routes: [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=b", afterUrl: "https://x/gittensory/shot?key=a" })],
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declines when no route crossed the pixel-diff threshold (no_confirmed_regression) -- never resolves BYOK", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: [route({ path: "/app", beforeUrl: "https://x/gittensory/shot?key=b", afterUrl: "https://x/gittensory/shot?key=a" })],
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declines for a low-reputation submitter even with a confirmed regression and BYOK configured", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    // Reputation-signal derivation is submitter-reputation.ts's own concern (see submitter-reputation.test.ts);
    // this test only verifies runVisualVisionForAdvisory correctly DECLINES on a "low" signal.
    vi.spyOn(submitterReputation, "getSubmitterReputation").mockResolvedValueOnce({
      submissions: 6,
      merged: 0,
      closed: 6,
      manual: 0,
      closeRate: 1,
      signal: "low",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "bob",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=b", afterUrl: "https://x/gittensory/shot?key=a" })],
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declines when BYOK is not configured (aiReviewByok off) even with a confirmed regression", async () => {
    const env = byokEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings({ aiReviewByok: false }),
      advisory: adv,
      routes: [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=b", afterUrl: "https://x/gittensory/shot?key=a" })],
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declines when the submitter is not a confirmed contributor, even with BYOK configured", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: false,
      settings: byokSettings(),
      advisory: adv,
      routes: [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=b", afterUrl: "https://x/gittensory/shot?key=a" })],
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips BYOK (declines, falls back to nothing) when the declared provider doesn't match the stored key", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings({ aiReviewProvider: "openai" }),
      advisory: adv,
      routes: [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=b", afterUrl: "https://x/gittensory/shot?key=a" })],
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the BYOK vision provider with before+after images and publishes a returned finding (desktop route)", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    stubShotsAndProvider(findingsResponse([{ path: "/app", body: "The submit button is clipped on the right edge." }]));
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: [
        route({
          path: "/app",
          diffUrl: "https://x/gittensory/shot?key=diff-desktop",
          beforeUrl: "https://x/gittensory/shot?key=before-desktop",
          afterUrl: "https://x/gittensory/shot?key=after-desktop",
          beforeUrlMobile: "https://x/gittensory/shot?key=before-mobile",
          afterUrlMobile: "https://x/gittensory/shot?key=after-mobile",
        }),
      ],
    });
    expect(adv.findings).toEqual([
      {
        code: "visual_regression_finding",
        severity: "warning",
        title: "Possible visual regression: /app",
        detail: "The submit button is clipped on the right edge.",
        action: "Advisory only — verify against the Visual preview screenshots before deciding.",
      },
    ]);
  });

  it("uses the mobile viewport's shots when only diffUrlMobile (not diffUrl) crossed the threshold", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      requestedUrls.push(url);
      if (url === "https://api.anthropic.com/v1/messages") return anthropicOk(findingsResponse([]));
      if (url.includes("/gittensory/shot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response("not found", { status: 404 });
    }));
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: [
        route({
          path: "/app",
          diffUrlMobile: "https://x/gittensory/shot?key=diff-mobile",
          beforeUrl: "https://x/gittensory/shot?key=before-desktop",
          afterUrl: "https://x/gittensory/shot?key=after-desktop",
          beforeUrlMobile: "https://x/gittensory/shot?key=before-mobile",
          afterUrlMobile: "https://x/gittensory/shot?key=after-mobile",
        }),
      ],
    });
    expect(requestedUrls).toContain("https://x/gittensory/shot?key=before-mobile");
    expect(requestedUrls).toContain("https://x/gittensory/shot?key=after-mobile");
    expect(requestedUrls).not.toContain("https://x/gittensory/shot?key=before-desktop");
    expect(requestedUrls).not.toContain("https://x/gittensory/shot?key=after-desktop");
  });

  it("skips a route whose confirmed-changed viewport is missing its before/after shot URLs", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    stubShotsAndProvider(findingsResponse([]));
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      // diffUrl set (confirmed changed) but no beforeUrl/afterUrl at all -- degrades to "no images from this route".
      routes: [route({ path: "/broken", diffUrl: "https://x/gittensory/shot?key=diff" })],
    });
    expect(adv.findings).toEqual([]);
  });

  it("degrades gracefully when a shot image fetch fails -- proceeds with only the images that succeeded", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.anthropic.com/v1/messages") return anthropicOk(findingsResponse([]));
      if (url.includes("key=before")) return new Response("not found", { status: 404 });
      if (url.includes("/gittensory/shot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response("not found", { status: 404 });
    }));
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=before", afterUrl: "https://x/gittensory/shot?key=after" })],
    });
    // The "after" image alone was enough to attempt the call; the model returned no findings either way.
    expect(adv.findings).toEqual([]);
  });

  it("never calls the AI provider when every candidate route's images all fail to fetch", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    const providerCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "https://api.anthropic.com/v1/messages") {
        providerCalls.push(url);
        return anthropicOk(findingsResponse([]));
      }
      return new Response("not found", { status: 404 });
    }));
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=before", afterUrl: "https://x/gittensory/shot?key=after" })],
    });
    expect(providerCalls).toEqual([]);
    expect(adv.findings).toEqual([]);
  });

  it("adds no finding when the model returns a response with no usable JSON (fail-safe parse)", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    stubShotsAndProvider("I looked at the screenshots and everything seems fine, no JSON here.");
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=before", afterUrl: "https://x/gittensory/shot?key=after" })],
    });
    expect(adv.findings).toEqual([]);
  });

  it("adds no finding when the provider call itself fails (non-2xx) -- callAiProvider's own fail-safe", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    stubShotsAndProvider(null);
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=before", afterUrl: "https://x/gittensory/shot?key=after" })],
    });
    expect(adv.findings).toEqual([]);
  });

  it("swallows a thrown error from the BYOK key lookup and never lets it escape (visual_vision_error)", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    vi.spyOn(repositories, "getDecryptedRepositoryAiKey").mockRejectedValueOnce(new Error("D1 unavailable"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await expect(
      runVisualVisionForAdvisory(env, {
        mode: "live",
        repoFullName,
        pr,
        author: "alice",
        confirmedContributor: true,
        settings: byokSettings(),
        advisory: adv,
        routes: [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=before", afterUrl: "https://x/gittensory/shot?key=after" })],
      }),
    ).resolves.toBeUndefined();
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** Only the shot-fetch side of stubShotsAndProvider — the self-host vision path never calls `fetch` for the
 *  AI call itself (it calls `env.AI_VISION.run` directly), so no provider URL needs mocking here. */
function stubShots() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/gittensory/shot")) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    return new Response("not found", { status: 404 });
  }));
}

function selfHostVisionRoutes() {
  return [route({ path: "/app", diffUrl: "https://x/gittensory/shot?key=diff", beforeUrl: "https://x/gittensory/shot?key=before", afterUrl: "https://x/gittensory/shot?key=after" })];
}

describe("runVisualVisionForAdvisory: self-host local vision provider (#4335)", () => {
  it("runs via env.AI_VISION when NO BYOK key is configured at all", async () => {
    const runMock = vi.fn(async (_model: string, _options: { messages: Array<{ role: string; content: unknown }> }) => ({
      response: findingsResponse([{ path: "/app", body: "Nav bar overlaps the logo on the AFTER screenshot." }]),
    }));
    const env = byokEnv();
    (env as unknown as { AI_VISION: unknown }).AI_VISION = { run: runMock };
    stubShots();
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings({ aiReviewByok: false }), // no BYOK configured
      advisory: adv,
      routes: selfHostVisionRoutes(),
    });
    expect(runMock).toHaveBeenCalledTimes(1);
    const [, options] = runMock.mock.calls[0]!;
    expect(options.messages[0]).toMatchObject({ role: "system" });
    expect(options.messages[1]).toMatchObject({ role: "user" });
    expect((options as unknown as { providerOptions?: { num_ctx?: number } }).providerOptions).toEqual({ num_ctx: 4096 });
    expect(adv.findings).toEqual([
      {
        code: "visual_regression_finding",
        severity: "warning",
        title: "Possible visual regression: /app",
        detail: "Nav bar overlaps the logo on the AFTER screenshot.",
        action: "Advisory only — verify against the Visual preview screenshots before deciding.",
      },
    ]);
  });

  it("does not let an unconfirmed contributor spend self-host vision resources unless all-authors is enabled", async () => {
    const runMock = vi.fn(async () => ({ response: findingsResponse([{ path: "/app", body: "should not run" }]) }));
    const env = byokEnv();
    (env as unknown as { AI_VISION: unknown }).AI_VISION = { run: runMock };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: false,
      settings: byokSettings({ aiReviewByok: false, aiReviewAllAuthors: false }),
      advisory: adv,
      routes: selfHostVisionRoutes(),
    });
    expect(runMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adv.findings).toEqual([]);
  });

  it("allows self-host vision for an unconfirmed contributor when all-authors is explicitly enabled", async () => {
    const runMock = vi.fn(async () => ({
      response: findingsResponse([{ path: "/app", body: "All-authors opt-in covers this self-host call." }]),
    }));
    const env = byokEnv();
    (env as unknown as { AI_VISION: unknown }).AI_VISION = { run: runMock };
    stubShots();
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: false,
      settings: byokSettings({ aiReviewByok: false, aiReviewAllAuthors: true }),
      advisory: adv,
      routes: selfHostVisionRoutes(),
    });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(adv.findings[0]).toMatchObject({ detail: "All-authors opt-in covers this self-host call." });
  });

  it("prefers a configured BYOK key over env.AI_VISION when both are available", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    const runMock = vi.fn(async () => ({ response: findingsResponse([{ path: "/app", body: "should not be used" }]) }));
    (env as unknown as { AI_VISION: unknown }).AI_VISION = { run: runMock };
    stubShotsAndProvider(findingsResponse([{ path: "/app", body: "BYOK finding wins." }]));
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings(),
      advisory: adv,
      routes: selfHostVisionRoutes(),
    });
    expect(runMock).not.toHaveBeenCalled();
    expect(adv.findings[0]).toMatchObject({ detail: "BYOK finding wins." });
  });

  it("adds no finding (fail-safe) when env.AI_VISION.run throws", async () => {
    const env = byokEnv();
    (env as unknown as { AI_VISION: unknown }).AI_VISION = { run: vi.fn(async () => { throw new Error("ollama connection refused"); }) };
    stubShots();
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings({ aiReviewByok: false }),
      advisory: adv,
      routes: selfHostVisionRoutes(),
    });
    expect(adv.findings).toEqual([]);
  });

  it("adds no finding when env.AI_VISION.run resolves to an empty/whitespace-only response", async () => {
    const env = byokEnv();
    (env as unknown as { AI_VISION: unknown }).AI_VISION = { run: vi.fn(async () => ({ response: "   " })) };
    stubShots();
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings({ aiReviewByok: false }),
      advisory: adv,
      routes: selfHostVisionRoutes(),
    });
    expect(adv.findings).toEqual([]);
  });

  it("adds no finding when env.AI_VISION is present but has no callable .run (a malformed binding)", async () => {
    const env = byokEnv();
    (env as unknown as { AI_VISION: unknown }).AI_VISION = {};
    stubShots();
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings({ aiReviewByok: false }),
      advisory: adv,
      routes: selfHostVisionRoutes(),
    });
    expect(adv.findings).toEqual([]);
  });

  it("still declines entirely when NEITHER BYOK nor env.AI_VISION is configured", async () => {
    const env = byokEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: "alice",
      confirmedContributor: true,
      settings: byokSettings({ aiReviewByok: false }),
      advisory: adv,
      routes: selfHostVisionRoutes(),
    });
    expect(adv.findings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
