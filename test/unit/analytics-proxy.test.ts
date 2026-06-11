import { afterEach, describe, expect, it, vi } from "vitest";

import { handleAnalyticsProxy } from "../../apps/gittensory-ui/src/lib/analytics-proxy";

describe("analytics proxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not forward first-party credentials to the analytics upstream", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("ok"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleAnalyticsProxy(
      new Request("https://gittensory.aethereal.dev/stats/api/send", {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer ui-token",
          cookie: "session=secret",
          "cf-connecting-ip": "203.0.113.10",
          "proxy-authorization": "Basic proxy-secret",
          "x-forwarded-for": "198.51.100.25",
        },
        body: JSON.stringify({ type: "event" }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const init = call?.[1];
    expect(init).toBeDefined();
    const forwardedHeaders = new Headers(init?.headers);

    expect(forwardedHeaders.get("accept")).toBe("application/json");
    expect(forwardedHeaders.get("x-forwarded-for")).toBe(
      "198.51.100.25, 203.0.113.10",
    );
    expect(forwardedHeaders.has("authorization")).toBe(false);
    expect(forwardedHeaders.has("cookie")).toBe(false);
    expect(forwardedHeaders.has("proxy-authorization")).toBe(false);
  });
});
