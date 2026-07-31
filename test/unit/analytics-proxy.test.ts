import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAnalyticsProxy } from "../../apps/loopover-ui/src/lib/analytics-proxy";

// The privacy invariants of the UI's first-party analytics relay, asserted from the ROOT suite --
// deliberately a different vantage point from the module's own colocated tests
// (apps/loopover-ui/src/lib/analytics-proxy.test.ts), which cover the full routing/size/cache matrix.
// What is pinned here is only the small set of properties that must hold no matter how the proxy is
// refactored: no visitor cookie reaches the analytics host, no set-cookie reaches the browser, geo
// cannot be spoofed, and nothing outside the allowlist forwards at all.
//
// Repointed from Umami to PostHog in #8293/#8299. One assertion INVERTED in that move and is called
// out rather than quietly rewritten: the Umami-era version asserted that the remote tracker script
// was never proxied as first-party JavaScript. PostHog's documented proxy design requires exactly
// that (posthog-js bootstraps from /static/array.js), so the modern equivalent is that the SDK is
// served from PostHog's dedicated immutable ASSET host, never the capture host.

const API = "https://us.i.posthog.com";
const ASSETS = "https://us-assets.i.posthog.com";

function captureUpstream() {
  const calls: Array<{ url: string; init: RequestInit; headers: Headers }> = [];
  vi.stubGlobal(
    "fetch",
    async (url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({
        url: url.toString(),
        init,
        headers: new Headers(init.headers),
      });
      return new Response("ok", {
        status: 200,
        headers: { "set-cookie": "ph=1", "content-type": "application/json" },
      });
    },
  );
  return calls;
}

function capture(headers: Record<string, string>) {
  return new Request("https://loopover.ai/stats/i/v0/e/", {
    method: "POST",
    headers: { "content-length": "2", ...headers },
    body: "{}",
  });
}

describe("handleAnalyticsProxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not forward the visitor's cookies to the analytics upstream", async () => {
    const calls = captureUpstream();
    const response = await handleAnalyticsProxy(
      capture({
        cookie: "loopover_session=secret; gh_oauth_state=abc",
        "cf-connecting-ip": "203.0.113.7",
      }),
    );

    expect(response?.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API}/i/v0/e/`);
    // The first-party session cookie must never reach the analytics host.
    expect(calls[0]?.headers.has("cookie")).toBe(false);
    // The upstream set-cookie must never be relayed back to the browser.
    expect(response?.headers.has("set-cookie")).toBe(false);
  });

  it("forwards only the trusted client IP, ignoring a spoofed x-forwarded-for", async () => {
    const calls = captureUpstream();
    await handleAnalyticsProxy(
      capture({
        "x-forwarded-for": "1.2.3.4",
        "cf-connecting-ip": "203.0.113.7",
        "content-type": "application/json",
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("serves the SDK bundle from PostHog's asset host, never the capture host", async () => {
    const calls = captureUpstream();

    await handleAnalyticsProxy(
      new Request("https://loopover.ai/stats/static/array.js"),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${ASSETS}/static/array.js`);
  });

  it("returns undefined for anything outside the allowlist, without touching the network", async () => {
    const calls = captureUpstream();

    // Not a PostHog ingest path -- including the retired Umami collect endpoint.
    expect(
      await handleAnalyticsProxy(
        new Request("https://loopover.ai/stats/api/send"),
      ),
    ).toBeUndefined();
    expect(
      await handleAnalyticsProxy(
        new Request("https://loopover.ai/stats/admin"),
      ),
    ).toBeUndefined();
    // Not an analytics path at all.
    expect(
      await handleAnalyticsProxy(new Request("https://loopover.ai/about")),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
