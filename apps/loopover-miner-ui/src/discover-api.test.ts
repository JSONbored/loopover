import { describe, expect, it, vi } from "vitest";

import { requestDiscover } from "./lib/discover";
import {
  type DiscoverApiDeps,
  discoverApiPlugin,
  handleDiscoverRequest,
  matchDiscoverRoute,
} from "../vite-discover-api";

const SAMPLE_RESULT = { fanOutCount: 2, ranked: [], enqueueSummary: { enqueued: 2 } };

/** A fake `runDiscover` that reports a structured success via onResult and exits 0 (the happy path). */
function successDeps(): { deps: DiscoverApiDeps; runDiscover: ReturnType<typeof vi.fn> } {
  const runDiscover = vi.fn(async (_args: string[], options: { onResult: (r: unknown) => void }) => {
    options.onResult(SAMPLE_RESULT);
    return 0;
  });
  return { deps: { runDiscover }, runDiscover };
}

/** Minimal readable-request stub: replays the body to the `data` listener when `end` is subscribed, matching how
 *  the plugin's readRequestBody consumes the stream. */
function fakeReq(method: string, url: string, body: string) {
  let dataCb: ((chunk: Buffer) => void) | undefined;
  return {
    method,
    url,
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === "data") dataCb = cb as (chunk: Buffer) => void;
      else if (event === "end") {
        if (body) dataCb?.(Buffer.from(body));
        cb();
      }
      return this;
    },
  } as unknown as { method?: string; url?: string } & NodeJS.ReadableStream;
}

describe("matchDiscoverRoute (#6522)", () => {
  it("matches only POST /api/discover, and no sibling method/path", () => {
    expect(matchDiscoverRoute("POST", "/api/discover")).toBe("discover-post");
    expect(matchDiscoverRoute("GET", "/api/discover")).toBeNull();
    expect(matchDiscoverRoute("POST", "/api/attempt")).toBeNull(); // sibling route path
    expect(matchDiscoverRoute("POST", "/api/governor/pause")).toBeNull();
    expect(matchDiscoverRoute(undefined, undefined)).toBeNull();
  });
});

describe("handleDiscoverRequest (#6522)", () => {
  it("passes a well-formed body to runDiscover and returns the captured structured result", async () => {
    const { deps, runDiscover } = successDeps();
    const handled = await handleDiscoverRequest(
      "POST",
      "/api/discover",
      JSON.stringify({ targets: ["acme/widgets"], dryRun: true, json: true }),
      deps,
    );
    expect(runDiscover).toHaveBeenCalledWith(
      ["acme/widgets", "--dry-run", "--json"],
      expect.objectContaining({ onResult: expect.any(Function) }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ result: SAMPLE_RESULT, exitCode: 0 }) });
  });

  it("builds --search / --api-base-url / --token-env args from the body", async () => {
    const { deps, runDiscover } = successDeps();
    await handleDiscoverRequest(
      "POST",
      "/api/discover",
      JSON.stringify({ search: "label:bug", apiBaseUrl: "https://forge.example", tokenEnv: "FORGE_PAT" }),
      deps,
    );
    expect(runDiscover).toHaveBeenCalledWith(
      ["--search", "label:bug", "--api-base-url", "https://forge.example", "--token-env", "FORGE_PAT"],
      expect.anything(),
    );
  });

  it("returns 400 for a malformed or requirement-missing body, without ever calling runDiscover", async () => {
    const runDiscover = vi.fn();
    const invalid = { status: 400, body: JSON.stringify({ error: "invalid_request_body" }) };
    expect(
      await handleDiscoverRequest("POST", "/api/discover", JSON.stringify({ dryRun: true }), { runDiscover }),
    ).toEqual(invalid);
    expect(await handleDiscoverRequest("POST", "/api/discover", "not json", { runDiscover })).toEqual(invalid);
    expect(await handleDiscoverRequest("POST", "/api/discover", "", { runDiscover })).toEqual(invalid);
    expect(await handleDiscoverRequest("POST", "/api/discover", JSON.stringify(["a"]), { runDiscover })).toEqual(
      invalid,
    );
    expect(
      await handleDiscoverRequest("POST", "/api/discover", JSON.stringify({ targets: [""] }), { runDiscover }),
    ).toEqual(invalid);
    expect(runDiscover).not.toHaveBeenCalled();
  });

  it("returns a structured 502 when runDiscover exits non-zero without a structured result", async () => {
    const runDiscover = vi.fn(async () => 2); // never calls onResult
    const handled = await handleDiscoverRequest(
      "POST",
      "/api/discover",
      JSON.stringify({ targets: ["acme/widgets"] }),
      { runDiscover },
    );
    expect(handled).toEqual({ status: 502, body: JSON.stringify({ error: "discover_failed", exitCode: 2 }) });
  });

  it("returns 500 with the error message when runDiscover throws", async () => {
    const runDiscover = vi.fn(async () => {
      throw new Error("sqlite locked");
    });
    expect(
      await handleDiscoverRequest("POST", "/api/discover", JSON.stringify({ targets: ["acme/widgets"] }), {
        runDiscover,
      }),
    ).toEqual({ status: 500, body: JSON.stringify({ error: "sqlite locked" }) });
  });

  it("returns 500 with a safe message when runDiscover throws a non-Error", async () => {
    const runDiscover = vi.fn(async () => {
      throw "nope";
    });
    expect(
      await handleDiscoverRequest("POST", "/api/discover", JSON.stringify({ targets: ["acme/widgets"] }), {
        runDiscover,
      }),
    ).toEqual({ status: 500, body: JSON.stringify({ error: "failed to run local discover" }) });
  });

  it("falls through (null) for non-discover method/path combinations", async () => {
    const { deps } = successDeps();
    expect(await handleDiscoverRequest("GET", "/api/discover", "", deps)).toBeNull();
    expect(await handleDiscoverRequest("POST", "/api/other", "", deps)).toBeNull();
  });

  it("never threads a credential-shaped body field into runDiscover", async () => {
    const { deps, runDiscover } = successDeps();
    await handleDiscoverRequest(
      "POST",
      "/api/discover",
      JSON.stringify({ targets: ["acme/widgets"], githubToken: "ghp_secret", token: "t", apiKey: "k" }),
      deps,
    );
    const [args] = runDiscover.mock.calls[0];
    expect(args).toEqual(["acme/widgets"]); // no credential flag threaded through
    expect(JSON.stringify(runDiscover.mock.calls[0])).not.toContain("ghp_secret");
  });
});

describe("discoverApiPlugin middleware (#6522)", () => {
  it("serves a matching request and passes every other request through to next()", async () => {
    const { deps } = successDeps();
    const plugin = discoverApiPlugin(deps);
    let middleware: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
    const server = { middlewares: { use: (fn: typeof middleware) => (middleware = fn) } };
    (plugin.configureServer as (s: unknown) => void)(server);
    (plugin.configurePreviewServer as (s: unknown) => void)(server); // same attach path, exercised for coverage
    expect(middleware).toBeTypeOf("function");

    const next = vi.fn();
    middleware!(fakeReq("GET", "/api/other", ""), {}, next);
    expect(next).toHaveBeenCalledTimes(1);

    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await new Promise<void>((resolve) => {
      res.end = vi.fn(() => resolve());
      middleware!(fakeReq("POST", "/api/discover", JSON.stringify({ targets: ["acme/widgets"] })), res, vi.fn());
    });
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
  });
});

describe("requestDiscover client (#6522)", () => {
  it("POSTs the input to /api/discover and returns the parsed result on success", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ result: SAMPLE_RESULT, exitCode: 0 }), { status: 200 }),
    );
    const result = await requestDiscover({ targets: ["acme/widgets"] }, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, result: SAMPLE_RESULT, exitCode: 0 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/discover");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ targets: ["acme/widgets"] }));
  });

  it("returns a typed error on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 502 }));
    expect(await requestDiscover({ search: "x" }, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "local discover API responded 502",
    });
  });

  it("returns a typed error on an unexpected payload shape", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    expect(await requestDiscover({ search: "x" }, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "local discover API returned an unexpected payload shape",
    });
  });

  it("returns a typed error when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await requestDiscover({ search: "x" }, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "offline",
    });
  });

  it("returns a safe error message when fetch rejects with a non-Error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw "x";
    });
    expect(await requestDiscover({ search: "x" }, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "failed to reach the local discover API",
    });
  });
});
