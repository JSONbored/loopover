import { afterEach, describe, expect, it, vi } from "vitest";
import { runVisualVisionForAdvisory } from "../../src/queue/processors";
import * as repositories from "../../src/db/repositories";
import { countByokAiEventsForRepoSince, upsertRepositoryAiKey } from "../../src/db/repositories";
import * as submitterReputation from "../../src/review/submitter-reputation";
import type { CaptureRoute } from "../../src/review/visual/capture";
import type { AdvisoryFinding, RepositorySettings } from "../../src/types";
import { utcDayStartIso } from "../../src/services/ai-review";
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

/** #4513: getEffectiveSubmitterReputation now checks confirmed-official-miner identity (a fetch to
 *  api.gittensor.io/miners) whenever a submitter's PER-REPO reputation signal is "neutral" -- i.e. in every
 *  scenario below that doesn't already mock getSubmitterReputation to a non-neutral signal. That identity
 *  check is unrelated to whether this function goes on to spend on a vision call, so a bare `vi.fn()`
 *  asserting NO fetch at all is no longer accurate; this resolves the miner check to "not a miner" (an empty
 *  roster) so the rest of each test's decline/self-host logic runs exactly as before. */
function stubMinerCheckOnly() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "https://api.gittensor.io/miners") return Response.json([]);
    return new Response("not found", { status: 404 });
  });
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
    const fetchMock = stubMinerCheckOnly();
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
    // The only network activity is the (unrelated) confirmed-official-miner identity check -- never a
    // real BYOK/vision-spend call.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://api.gittensor.io/miners"]);
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
    const fetchMock = stubMinerCheckOnly();
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
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://api.gittensor.io/miners"]);
  });

  it("declines when the submitter is not a confirmed contributor, even with BYOK configured", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    const fetchMock = stubMinerCheckOnly();
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
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://api.gittensor.io/miners"]);
  });

  it("skips BYOK (declines, falls back to nothing) when the declared provider doesn't match the stored key", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    const fetchMock = stubMinerCheckOnly();
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
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://api.gittensor.io/miners"]);
  });

  it("enforces the shared BYOK daily cap before fetching screenshots or calling the vision provider", async () => {
    const env = createTestEnv({
      TOKEN_ENCRYPTION_SECRET: "vision-test-encryption-secret-32b",
      AI_BYOK_DAILY_REPO_LIMIT: "0",
    });
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    // #4513: the reputation/miner-identity check at the top of runVisualVisionForAdvisory runs regardless of
    // the BYOK cap outcome -- only the shot fetches and the provider call are gated by the cap.
    const fetchMock = stubMinerCheckOnly();
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
      routes: [
        route({
          path: "/app",
          diffUrl: "https://x/gittensory/shot?key=diff",
          beforeUrl: "https://x/gittensory/shot?key=before",
          afterUrl: "https://x/gittensory/shot?key=after",
        }),
      ],
    });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://api.gittensor.io/miners"]);
    expect(adv.findings).toEqual([]);
    expect(await countByokAiEventsForRepoSince(env, repoFullName, utcDayStartIso())).toBe(0);
  });

  // REGRESSION guard: `ai_usage_events` is shared with BYOK key-lifecycle audit rows (recordAiKeyChange's
  // "set"/"replace"/"delete", src/db/repositories.ts) whose `model` is ALSO `byok:<provider>`-prefixed, so
  // they match this query's model filter too -- only their `status` (never "ok" or "error") keeps them out.
  // upsertRepositoryAiKey (used by nearly every test in this file to seed a BYOK key) always writes exactly
  // one such "set" row, so this asserts it alone never counts toward the cap.
  it("does not count a BYOK key-lifecycle audit event (upsertRepositoryAiKey's own 'set' row) toward the daily cap", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    const keyChangeEvents = await env.DB.prepare("select status, feature, model from ai_usage_events").all<{ status: string; feature: string; model: string }>();
    expect(keyChangeEvents.results).toEqual([{ status: "set", feature: "ai_key_change", model: "byok:anthropic" }]);
    expect(await countByokAiEventsForRepoSince(env, repoFullName, utcDayStartIso())).toBe(0);
  });

  it("records successful visual BYOK calls so later passes count toward the shared daily cap", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, {
      repoFullName,
      provider: "anthropic",
      key: "sk-ant-vision-key",
      model: null,
    });
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
      routes: [
        route({
          path: "/app",
          diffUrl: "https://x/gittensory/shot?key=diff",
          beforeUrl: "https://x/gittensory/shot?key=before",
          afterUrl: "https://x/gittensory/shot?key=after",
        }),
      ],
    });
    expect(adv.findings).toEqual([]);
    expect(await countByokAiEventsForRepoSince(env, repoFullName, utcDayStartIso())).toBe(1);
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

  it("adds no finding when the provider call itself fails (non-2xx) -- callAiProvider's own fail-safe, but STILL records the attempt as a distinct 'error' status that counts toward the daily cap", async () => {
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
    // A genuine provider failure is a distinct "error" status (not "ok") -- but it's still a real request
    // against the maintainer's key, so it must still count toward the shared daily cap (see
    // BYOK_SPEND_ATTEMPT_STATUSES's doc comment, src/db/repositories.ts): a repo hitting a flaky/misconfigured
    // provider must not get unlimited free retries just because every attempt happens to fail.
    const events = await env.DB.prepare("select status, detail from ai_usage_events where feature = 'visual_vision'").all<{ status: string; detail: string }>();
    expect(events.results).toEqual([{ status: "error", detail: "provider failure: http_error" }]);
    expect(await countByokAiEventsForRepoSince(env, repoFullName, utcDayStartIso())).toBe(1);
  });

  it("adds no finding when the provider returns 200 with no usable text (distinct from an http_error failure)", async () => {
    const env = byokEnv();
    await upsertRepositoryAiKey(env, { repoFullName, provider: "anthropic", key: "sk-ant-vision-key", model: null });
    // An empty string is a genuine 2xx response, unlike stubShotsAndProvider(null)'s 500 -- callAiProvider
    // returns { text: "", failure: undefined } here (no "http_error"), exercising the "no usable output"
    // fallback in recordVisualVisionUsage's detail message rather than the provider-failure one. Also uses a
    // null author (ghost/deleted account, `args.author ?? undefined` short-circuits the reputation/miner
    // check to neutral with no fetch) to exercise recordVisualVisionUsage's own `actor: args.author ?? null`
    // fallback alongside it.
    stubShotsAndProvider("");
    const adv = findingsHolder();
    await runVisualVisionForAdvisory(env, {
      mode: "live",
      repoFullName,
      pr,
      author: null,
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
    const fetchMock = stubMinerCheckOnly();
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
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://api.gittensor.io/miners"]);
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
    const fetchMock = stubMinerCheckOnly();
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
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://api.gittensor.io/miners"]);
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

  it("records the self-host call under `visual_vision` with the REAL reported provider/model, not silently dropped (2026-07 fix)", async () => {
    const env = byokEnv();
    const runMock = vi.fn(async () => ({
      response: findingsResponse([{ path: "/app", body: "Nav bar overlaps the logo." }]),
      usage: { provider: "ollama", model: "qwen3-vl:8b" },
    }));
    (env as unknown as { AI_VISION: unknown }).AI_VISION = { run: runMock };
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
    const row = await env.DB.prepare("select feature, model, provider, status from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("visual_vision")
      .first<{ feature: string; model: string; provider: string | null; status: string }>();
    expect(row).toMatchObject({ feature: "visual_vision", model: "qwen3-vl:8b", provider: "ollama", status: "ok" });
  });

  it("records a self-host call with no usable output under the fallback model label when the provider reports no usage", async () => {
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
    const row = await env.DB.prepare("select feature, model, provider, status, detail from ai_usage_events where feature = ? order by rowid desc limit 1")
      .bind("visual_vision")
      .first<{ feature: string; model: string; provider: string | null; status: string; detail: string | null }>();
    expect(row).toMatchObject({ feature: "visual_vision", model: "ollama:visual-vision", provider: null, status: "ok", detail: "no usable output" });
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
    const fetchMock = stubMinerCheckOnly();
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
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["https://api.gittensor.io/miners"]);
  });
});
