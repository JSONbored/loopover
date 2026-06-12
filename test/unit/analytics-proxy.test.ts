import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAnalyticsProxy } from "../../apps/gittensory-ui/src/lib/analytics-proxy";

const UPSTREAM = "https://tasty.aethereal.dev";

function captureUpstream() {
  const calls: Array<{ url: string; init: RequestInit; headers: Headers }> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: url.toString(), init, headers: new Headers(init.headers) });
    return new Response("ok", { status: 200, headers: { "set-cookie": "umami=1", "content-type": "application/javascript" } });
  });
  return calls;
}

describe("handleAnalyticsProxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not forward the visitor's cookies to the analytics upstream", async () => {
    const calls = captureUpstream();
    const response = await handleAnalyticsProxy(
      new Request("https://gittensory.aethereal.dev/stats/script.js", {
        method: "GET",
        headers: { cookie: "gittensory_session=secret; gh_oauth_state=abc", "cf-connecting-ip": "203.0.113.7" },
      }),
    );

    expect(response?.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${UPSTREAM}/script.js`);
    // The first-party cookie must never reach the analytics host.
    expect(calls[0]?.headers.has("cookie")).toBe(false);
    // The upstream set-cookie must never be relayed back to the browser.
    expect(response?.headers.has("set-cookie")).toBe(false);
  });

  it("forwards only the trusted client IP, ignoring a spoofed x-forwarded-for", async () => {
    const calls = captureUpstream();
    await handleAnalyticsProxy(
      new Request("https://gittensory.aethereal.dev/stats/api/send", {
        method: "POST",
        headers: { "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "203.0.113.7", "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${UPSTREAM}/api/send`);
    expect(calls[0]?.headers.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("returns undefined for non-allowlisted paths and 405 for disallowed methods", async () => {
    captureUpstream();
    expect(await handleAnalyticsProxy(new Request("https://gittensory.aethereal.dev/stats/api/admin"))).toBeUndefined();
    expect(await handleAnalyticsProxy(new Request("https://gittensory.aethereal.dev/about"))).toBeUndefined();
    const notAllowed = await handleAnalyticsProxy(new Request("https://gittensory.aethereal.dev/stats/script.js", { method: "POST" }));
    expect(notAllowed?.status).toBe(405);
  });
});
