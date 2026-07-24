import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAnalyticsProxy } from "./analytics-proxy";

// #8387: the analytics proxy is the cookieless-beacon relay to the Umami-compatible upstream. Its four
// security behaviors (strict allowlist, cookie strip, cf-connecting-ip-only x-forwarded-for, set-cookie
// strip) had zero coverage. These pin each one against a stubbed upstream fetch.

const UPSTREAM = "https://tasty.aethereal.dev";

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

function send(init: RequestInit & { path?: string; query?: string } = {}) {
  const { path = "/stats/api/send", query = "", ...rest } = init;
  return new Request(`https://loopover.ai${path}${query}`, { method: "POST", ...rest });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleAnalyticsProxy", () => {
  it("forwards an allowed POST to the upstream collect endpoint, preserving the query and relaying the response", async () => {
    const { fetchMock, calls } = stubUpstream(
      new Response("ok-body", { status: 202, statusText: "Accepted" }),
    );

    const response = await handleAnalyticsProxy(
      send({ query: "?v=2&cache=abc", body: "beacon-payload" }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // /stats prefix stripped, path + query preserved onto the real upstream host.
    expect(calls[0]!.url).toBe(`${UPSTREAM}/api/send?v=2&cache=abc`);
    expect(calls[0]!.method).toBe("POST");
    // Upstream status/statusText/body are relayed back untouched.
    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(202);
    expect(response!.statusText).toBe("Accepted");
    expect(await response!.text()).toBe("ok-body");
  });

  it("rejects a disallowed method with 405 + an allow header, without ever calling fetch (method gate)", async () => {
    const { fetchMock } = stubUpstream(new Response("should not be used"));

    const response = await handleAnalyticsProxy(send({ method: "GET" }));

    expect(response!.status).toBe(405);
    expect(response!.headers.get("allow")).toBe("POST");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined (falls through to SSR) and never fetches for a path outside the allowlist", async () => {
    const { fetchMock } = stubUpstream(new Response("should not be used"));

    // The admin/auth API lives on the same upstream origin as the collect endpoint -- must NOT be proxied.
    expect(await handleAnalyticsProxy(send({ path: "/stats/admin" }))).toBeUndefined();
    expect(await handleAnalyticsProxy(send({ path: "/stats/api/collect" }))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
        headers: { "set-cookie": "umami=1; Path=/", "x-app": "v1" },
      }),
    );

    const response = await handleAnalyticsProxy(send());

    expect(response!.headers.get("set-cookie")).toBeNull();
    expect(response!.headers.get("x-app")).toBe("v1"); // unrelated response headers are still relayed
  });

  it("fails quietly with 502 when the upstream fetch throws (analytics must never take the page down)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const response = await handleAnalyticsProxy(send({ body: "beacon" }));

    expect(response!.status).toBe(502);
  });
});
