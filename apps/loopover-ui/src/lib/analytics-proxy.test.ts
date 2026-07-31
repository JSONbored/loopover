import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAnalyticsProxy } from "./analytics-proxy";

// The analytics proxy is the first-party relay to PostHog (#8293, replacing the Umami relay #8387
// covered). Its security behaviors -- prefix allowlist, cookie strip, cf-connecting-ip-only
// x-forwarded-for, set-cookie strip, body-size caps -- plus the asset/capture host split and the
// best-effort edge cache are each pinned here against a stubbed upstream fetch.

const API = "https://us.i.posthog.com";
const ASSETS = "https://us-assets.i.posthog.com";

type ForwardedCall = { url: string; method: string; headers: Headers };

/** Stub global fetch to return `response`, recording each forwarded request in a typed, inspectable list. */
function stubUpstream(response: Response) {
  const calls: ForwardedCall[] = [];
  const fetchMock = vi.fn(
    async (url: string | URL, init?: { method?: string; headers?: HeadersInit }) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      });
      return response;
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

/** A POST to the capture endpoint. `content-length` is set by default because the size gate below
 *  rejects a body-bearing request that omits it (411) -- tests that exercise that gate pass their own. */
function send(init: RequestInit & { path?: string; query?: string } = {}) {
  const { path = "/stats/i/v0/e/", query = "", ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("content-length")) headers.set("content-length", "128");
  return new Request(`https://loopover.ai${path}${query}`, { method: "POST", ...rest, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleAnalyticsProxy — routing", () => {
  it("forwards an allowed capture POST to the PostHog capture host, preserving path + query and relaying the response", async () => {
    const { fetchMock, calls } = stubUpstream(
      new Response("ok-body", { status: 202, statusText: "Accepted" }),
    );

    const response = await handleAnalyticsProxy(
      send({ query: "?v=2&ip=1", body: "batch-payload" }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // /stats prefix stripped, path + query preserved onto the real upstream host.
    expect(calls[0]!.url).toBe(`${API}/i/v0/e/?v=2&ip=1`);
    expect(calls[0]!.method).toBe("POST");
    expect(response!.status).toBe(202);
    expect(response!.statusText).toBe("Accepted");
    expect(await response!.text()).toBe("ok-body");
  });

  it.each([
    ["/stats/e/", `${API}/e/`],
    ["/stats/batch/", `${API}/batch/`],
    ["/stats/decide/", `${API}/decide/`],
    ["/stats/flags/", `${API}/flags/`],
    ["/stats/engage/", `${API}/engage/`],
    ["/stats/s/", `${API}/s/`],
  ])("routes the allowlisted capture path %s to the capture host", async (path, expected) => {
    const { calls } = stubUpstream(new Response(null, { status: 200 }));
    await handleAnalyticsProxy(send({ path }));
    expect(calls[0]!.url).toBe(expected);
  });

  it.each([
    ["/stats/static/array.js", `${ASSETS}/static/array.js`],
    ["/stats/array/phc_x/config.js", `${ASSETS}/array/phc_x/config.js`],
  ])("routes the asset path %s to the dedicated asset host", async (path, expected) => {
    const { calls } = stubUpstream(new Response("sdk", { status: 200 }));
    const request = new Request(`https://loopover.ai${path}`);
    await handleAnalyticsProxy(request);
    expect(calls[0]!.url).toBe(expected);
  });

  it("returns undefined (falls through to SSR) and never fetches for a path outside the allowlist", async () => {
    const { fetchMock } = stubUpstream(new Response("should not be used"));

    // The allowlist is load-bearing: nothing outside PostHog's documented ingest surface forwards.
    expect(await handleAnalyticsProxy(send({ path: "/stats/admin" }))).toBeUndefined();
    expect(await handleAnalyticsProxy(send({ path: "/stats/api/send" }))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined for any path outside the /stats prefix entirely", async () => {
    const { fetchMock } = stubUpstream(new Response("should not be used"));

    expect(await handleAnalyticsProxy(send({ path: "/docs" }))).toBeUndefined();
    // The bare prefix with no trailing segment is not an analytics path either.
    expect(await handleAnalyticsProxy(send({ path: "/stats" }))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleAnalyticsProxy — privacy and header hygiene", () => {
  it("strips the visitor's first-party cookie before forwarding (cookieless guarantee, #597)", async () => {
    const { calls } = stubUpstream(new Response(null, { status: 200 }));

    await handleAnalyticsProxy(
      send({ headers: { cookie: "session=secret; theme=dark", "x-keep": "yes" } }),
    );

    expect(calls[0]!.headers.get("cookie")).toBeNull();
    // Non-stripped headers still pass through, so this isn't just dropping everything.
    expect(calls[0]!.headers.get("x-keep")).toBe("yes");
  });

  it("re-derives x-forwarded-for from the trusted cf-connecting-ip and drops any client-supplied value (no geo spoofing)", async () => {
    const { calls } = stubUpstream(new Response(null, { status: 200 }));

    await handleAnalyticsProxy(
      send({ headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "66.66.66.66" } }),
    );

    // This is what preserves PostHog's GeoIP enrichment -- the Umami-parity requirement in #8299.
    expect(calls[0]!.headers.get("x-forwarded-for")).toBe("203.0.113.7");
    // The trusted-IP header itself is not leaked upstream.
    expect(calls[0]!.headers.get("cf-connecting-ip")).toBeNull();
  });

  it("does not set x-forwarded-for when there is no cf-connecting-ip", async () => {
    const { calls } = stubUpstream(new Response(null, { status: 200 }));

    await handleAnalyticsProxy(send({ headers: { "x-forwarded-for": "66.66.66.66" } }));

    expect(calls[0]!.headers.get("x-forwarded-for")).toBeNull();
  });

  it("strips set-cookie from the upstream response before relaying it to the browser", async () => {
    stubUpstream(
      new Response("ok", {
        status: 200,
        headers: { "set-cookie": "ph=1; Path=/", "x-app": "v1" },
      }),
    );

    const response = await handleAnalyticsProxy(send());

    expect(response!.headers.get("set-cookie")).toBeNull();
    expect(response!.headers.get("x-app")).toBe("v1"); // unrelated response headers are still relayed
  });
});

describe("handleAnalyticsProxy — body size gate", () => {
  it("rejects a body-bearing request with no content-length with 411, before buffering or fetching", async () => {
    const { fetchMock } = stubUpstream(new Response("should not be used"));

    const request = new Request("https://loopover.ai/stats/i/v0/e/", {
      method: "POST",
      body: "payload",
    });
    request.headers.delete("content-length");
    const response = await handleAnalyticsProxy(request);

    expect(response!.status).toBe(411);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric content-length with 411 rather than coercing it", async () => {
    const { fetchMock } = stubUpstream(new Response("should not be used"));

    const response = await handleAnalyticsProxy(send({ headers: { "content-length": "abc" } }));

    expect(response!.status).toBe(411);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized capture body with 413, before buffering or fetching", async () => {
    const { fetchMock } = stubUpstream(new Response("should not be used"));

    const response = await handleAnalyticsProxy(
      send({ headers: { "content-length": String(64 * 1024 + 1) } }),
    );

    expect(response!.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a capture body exactly at the cap (boundary is inclusive)", async () => {
    const { fetchMock } = stubUpstream(new Response(null, { status: 200 }));

    const response = await handleAnalyticsProxy(
      send({ headers: { "content-length": String(64 * 1024) } }),
    );

    expect(response!.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives session-replay snapshots (/s/) their own larger ceiling, so enabling replay cannot silently 413", async () => {
    const { calls } = stubUpstream(new Response(null, { status: 200 }));

    // Well past the 64 KiB capture cap, well inside the 2 MiB replay cap.
    const response = await handleAnalyticsProxy(
      send({ path: "/stats/s/", headers: { "content-length": String(512 * 1024) } }),
    );

    expect(response!.status).toBe(200);
    expect(calls[0]!.url).toBe(`${API}/s/`);
  });

  it("still rejects a replay snapshot past the replay ceiling", async () => {
    const { fetchMock } = stubUpstream(new Response("should not be used"));

    const response = await handleAnalyticsProxy(
      send({ path: "/stats/s/", headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    );

    expect(response!.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not apply the content-length gate to a bodyless GET", async () => {
    const { fetchMock } = stubUpstream(new Response(null, { status: 200 }));

    const response = await handleAnalyticsProxy(
      new Request("https://loopover.ai/stats/flags/?v=2"),
    );

    expect(response!.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("handleAnalyticsProxy — asset edge cache", () => {
  const assetRequest = () => new Request("https://loopover.ai/stats/static/array.js");

  it("serves a cache hit without touching the network", async () => {
    const { fetchMock } = stubUpstream(new Response("should not be used"));
    vi.stubGlobal("caches", {
      default: { match: vi.fn(async () => new Response("cached-sdk")), put: vi.fn() },
    });

    const response = await handleAnalyticsProxy(assetRequest(), { waitUntil: () => {} });

    expect(await response!.text()).toBe("cached-sdk");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches and writes through to the cache on a miss", async () => {
    stubUpstream(new Response("fresh-sdk", { status: 200 }));
    const put = vi.fn(async () => {});
    vi.stubGlobal("caches", { default: { match: vi.fn(async () => undefined), put } });
    const deferred: Promise<unknown>[] = [];

    const response = await handleAnalyticsProxy(assetRequest(), {
      waitUntil: (p) => deferred.push(p),
    });

    expect(await response!.text()).toBe("fresh-sdk");
    await Promise.all(deferred);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("degrades to an uncached fetch when ctx is undefined (the #7794 production incident)", async () => {
    const { fetchMock } = stubUpstream(new Response("fresh-sdk", { status: 200 }));
    const match = vi.fn(async () => undefined);
    vi.stubGlobal("caches", { default: { match, put: vi.fn() } });

    // server.ts casts an `unknown` ctx straight through, so the type-level contract carries no
    // runtime guarantee -- an undefined ctx must never throw.
    const response = await handleAnalyticsProxy(assetRequest(), undefined);

    expect(await response!.text()).toBe("fresh-sdk");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(match).not.toHaveBeenCalled();
  });

  it("falls through to a normal fetch when the cache read throws", async () => {
    stubUpstream(new Response("fresh-sdk", { status: 200 }));
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => {
          throw new Error("cache unavailable");
        }),
        put: vi.fn(async () => {}),
      },
    });

    const response = await handleAnalyticsProxy(assetRequest(), { waitUntil: () => {} });

    expect(await response!.text()).toBe("fresh-sdk");
  });

  it("does not fail the request when the background cache write rejects", async () => {
    stubUpstream(new Response("fresh-sdk", { status: 200 }));
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => {
          throw new Error("bad Vary header");
        }),
      },
    });
    const deferred: Promise<unknown>[] = [];

    const response = await handleAnalyticsProxy(assetRequest(), {
      waitUntil: (p) => deferred.push(p),
    });

    expect(await response!.text()).toBe("fresh-sdk");
    // The whole point: an unhandled rejection here previously 500'd the current request.
    await expect(Promise.all(deferred)).resolves.toBeDefined();
  });
});

describe("handleAnalyticsProxy — failure isolation", () => {
  it("fails quietly with 502 when the upstream capture fetch throws (analytics must never take the page down)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const response = await handleAnalyticsProxy(send({ body: "batch" }));

    expect(response!.status).toBe(502);
  });

  it("fails quietly with 502 when an asset fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const response = await handleAnalyticsProxy(
      new Request("https://loopover.ai/stats/static/a.js"),
    );

    expect(response!.status).toBe(502);
  });
});
