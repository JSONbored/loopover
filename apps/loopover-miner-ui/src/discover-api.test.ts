import { describe, expect, it, vi } from "vitest";

import {
  discoverApiPlugin,
  handleDiscoverRequest,
  matchDiscoverRoute,
  type DiscoverApiDeps,
} from "../vite-discover-api";
import type { DiscoverResult } from "../../../packages/loopover-miner/lib/discover-cli.js";
import { DISCOVER_API_PATH, runDiscoverAction, type DiscoverRunResult } from "./lib/discover";

type FakeReq = { method?: string; url?: string } & NodeJS.ReadableStream;

/** A minimal Node-readable-stream double, mirroring governor.test.tsx's fakeRequest: `.on("data"/"end", ...)`
 *  registration works like a real stream, with the body emitted on a microtask so readRequestBody's listeners
 *  are attached first. */
function fakeRequest(method: string | undefined, url: string | undefined, body = ""): FakeReq {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const req = {
    method,
    url,
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
      return req;
    },
  };
  queueMicrotask(() => {
    if (body) for (const cb of listeners.data ?? []) cb(Buffer.from(body));
    for (const cb of listeners.end ?? []) cb();
  });
  return req as unknown as FakeReq;
}

function fakeResponse() {
  let statusCode = 200;
  let ended: string | undefined;
  const headers: Record<string, string> = {};
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    end: (body: string) => {
      ended = body;
    },
  };
  return { res, headers, getEnded: () => ended, getStatus: () => statusCode };
}

type CapturedRequestHandler = (
  req: FakeReq,
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
  next: () => void,
) => void;

const fakeResult: DiscoverRunResult = {
  fanOutCount: 2,
  ranked: [{ repoFullName: "acme/widgets", issueNumber: 1, title: "Add retry helper", rankScore: 0.9 }],
  enqueueSummary: { enqueued: 2, skippedBelowMinRank: 0, skippedInvalid: 0 },
  warnings: [],
  rateLimitRemaining: 4987,
  rateLimitResetAt: "2026-07-09T13:00:00.000Z",
  usedDefaultGoalSpec: false,
};

/** A fake `runDiscover` that captures the args it received and fires onResult with a structured result, exactly
 *  like the real one does at its two success points. */
function deps(overrides: Partial<DiscoverApiDeps> = {}): { deps: DiscoverApiDeps; calls: string[][] } {
  const calls: string[][] = [];
  const base: DiscoverApiDeps = {
    loadDiscoverCliModule: async () => ({
      runDiscover: async (args, options) => {
        calls.push(args);
        // The fake stands in for the real runDiscover's structured success result; the client-facing loose
        // shape is a structural subset of the CLI's DiscoverResult.
        options?.onResult?.(fakeResult as unknown as DiscoverResult);
        return 0;
      },
    }),
    ...overrides,
  };
  return { deps: base, calls };
}

describe("matchDiscoverRoute (#6522)", () => {
  it("matches only POST /api/discover", () => {
    expect(matchDiscoverRoute("POST", "/api/discover")).toBe("discover-post");
  });

  it("returns null for every other method/path, including the sibling routes' own paths", () => {
    expect(matchDiscoverRoute("GET", "/api/discover")).toBeNull();
    expect(matchDiscoverRoute(undefined, "/api/discover")).toBeNull();
    expect(matchDiscoverRoute("POST", "/api/discover/")).toBeNull();
    expect(matchDiscoverRoute("POST", "/api/attempt")).toBeNull();
    expect(matchDiscoverRoute("POST", "/api/governor/pause")).toBeNull();
    expect(matchDiscoverRoute("POST", "/api/portfolio-queue/release")).toBeNull();
    expect(matchDiscoverRoute("GET", "/api/run-state")).toBeNull();
  });
});

describe("handleDiscoverRequest (#6522)", () => {
  it("falls through (null) for a non-matching request without loading the CLI module", async () => {
    let loaded = false;
    const handled = await handleDiscoverRequest("GET", "/api/discover", "", {
      loadDiscoverCliModule: async () => {
        loaded = true;
        throw new Error("must not load");
      },
    });
    expect(handled).toBeNull();
    expect(loaded).toBe(false);
  });

  it("marshals a well-formed body into runDiscover and returns the captured onResult payload plus the exit code", async () => {
    const { deps: d, calls } = deps();
    const handled = await handleDiscoverRequest(
      "POST",
      "/api/discover",
      JSON.stringify({
        targets: ["acme/widgets"],
        dryRun: true,
        json: true,
        apiBaseUrl: "https://api.example.test",
        tokenEnv: "FORGE_PAT",
      }),
      d,
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ result: fakeResult, exitCode: 0 }) });
    expect(calls).toEqual([
      ["acme/widgets", "--dry-run", "--json", "--api-base-url", "https://api.example.test", "--token-env", "FORGE_PAT"],
    ]);
  });

  it("marshals a --search body into the --search arg", async () => {
    const { deps: d, calls } = deps();
    const handled = await handleDiscoverRequest("POST", "/api/discover", JSON.stringify({ search: "label:bug" }), d);
    expect(handled?.status).toBe(200);
    expect(calls).toEqual([["--search", "label:bug"]]);
  });

  it("returns 400 for a malformed/missing-required-field body WITHOUT ever calling runDiscover", async () => {
    let called = false;
    const d: DiscoverApiDeps = {
      loadDiscoverCliModule: async () => ({
        runDiscover: async () => {
          called = true;
          return 0;
        },
      }),
    };
    // Empty body, invalid JSON, an object with neither targets nor search, and blank-only targets all fail.
    for (const rawBody of [
      "",
      "not json",
      JSON.stringify({}),
      JSON.stringify({ dryRun: true }),
      JSON.stringify({ targets: ["   "] }),
    ]) {
      const handled = await handleDiscoverRequest("POST", "/api/discover", rawBody, d);
      expect(handled).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_request_body" }) });
    }
    expect(called).toBe(false);
  });

  it("handles the exit-code-only branch (non-zero exit, onResult never fired) without throwing", async () => {
    const handled = await handleDiscoverRequest(
      "POST",
      "/api/discover",
      JSON.stringify({ targets: ["acme/widgets"] }),
      {
        loadDiscoverCliModule: async () => ({
          // reportCliFailure path: returns non-zero, never fires onResult.
          runDiscover: async () => 1,
        }),
      },
    );
    expect(handled).toEqual({ status: 502, body: JSON.stringify({ error: "discover_failed", exitCode: 1 }) });
  });

  it("never threads a caller-supplied githubToken/token/apiKey field through to runDiscover", async () => {
    const { deps: d, calls } = deps();
    const handled = await handleDiscoverRequest(
      "POST",
      "/api/discover",
      JSON.stringify({ targets: ["acme/widgets"], githubToken: "ghp_secret", token: "t", apiKey: "k" }),
      d,
    );
    expect(handled?.status).toBe(200);
    const args = calls[0] ?? [];
    expect(args).toEqual(["acme/widgets"]);
    expect(args.join(" ")).not.toContain("ghp_secret");
    expect(args).not.toContain("--token");
  });

  it("surfaces a CLI-module load failure as a 500 with a safe message", async () => {
    const handled = await handleDiscoverRequest(
      "POST",
      "/api/discover",
      JSON.stringify({ targets: ["acme/widgets"] }),
      {
        loadDiscoverCliModule: async () => {
          throw new Error("module load boom");
        },
      },
    );
    expect(handled).toEqual({ status: 500, body: JSON.stringify({ error: "module load boom" }) });
  });
});

describe("discoverApiPlugin middleware (#6522)", () => {
  function captureMiddleware(
    server: { middlewares: { use: (fn: CapturedRequestHandler) => void } },
    deps: DiscoverApiDeps,
  ) {
    const plugin = discoverApiPlugin(deps);
    // @ts-expect-error -- the test double only implements the subset of Vite's server this plugin reads.
    plugin.configureServer(server);
  }

  it("falls through to next() for a non-matching request without ever reading its body", () => {
    let captured: CapturedRequestHandler | undefined;
    captureMiddleware({ middlewares: { use: (fn) => (captured = fn) } }, deps().deps);
    const { res } = fakeResponse();
    let calledNext = false;
    // A body on a non-matching request would hang readRequestBody's Promise if it were (wrongly) read.
    captured?.(fakeRequest("GET", "/api/discover", "should-not-read"), res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(true);
  });

  it("serves POST /api/discover through the middleware, reading the body and writing a JSON response", async () => {
    let captured: CapturedRequestHandler | undefined;
    captureMiddleware({ middlewares: { use: (fn) => (captured = fn) } }, deps().deps);
    const { res, headers, getEnded, getStatus } = fakeResponse();
    captured?.(fakeRequest("POST", "/api/discover", JSON.stringify({ targets: ["acme/widgets"] })), res, () => {
      throw new Error("next() must not be called for a matched route");
    });
    // Let the microtask-emitted body + the async handler chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getStatus()).toBe(200);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(getEnded()).toBe(JSON.stringify({ result: fakeResult, exitCode: 0 }));
  });

  it("also registers via configurePreviewServer", () => {
    let captured: CapturedRequestHandler | undefined;
    const plugin = discoverApiPlugin(deps().deps);
    // @ts-expect-error -- test double for the preview server's middleware stack only.
    plugin.configurePreviewServer({ middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } });
    expect(captured).toBeTypeOf("function");
  });
});

describe("runDiscoverAction client (#6522)", () => {
  it("posts to the discover API and returns the typed result on success", async () => {
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe(DISCOVER_API_PATH);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ targets: ["acme/widgets"], dryRun: true });
      return new Response(JSON.stringify({ result: fakeResult, exitCode: 0 }), { status: 200 });
    });
    const result = await runDiscoverAction(
      { targets: ["acme/widgets"], dryRun: true },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, result: fakeResult, exitCode: 0 });
  });

  it("returns a typed error (not a throw) for an HTTP-level failure, preferring the server error field", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "discover_failed", exitCode: 1 }), { status: 502 }),
    );
    const result = await runDiscoverAction({ targets: ["acme/widgets"] }, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, error: "discover_failed" });
  });

  it("falls back to a status-derived error when a failed response has no error field", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const result = await runDiscoverAction({ targets: ["acme/widgets"] }, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, error: "local discover API responded 500" });
  });

  it("rejects an unexpected success payload shape", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ result: { nope: true }, exitCode: 0 }), { status: 200 }),
    );
    const result = await runDiscoverAction({ targets: ["acme/widgets"] }, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, error: "local discover API returned an unexpected payload shape" });
  });

  it("returns a typed error when the fetch itself throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const result = await runDiscoverAction({ targets: ["acme/widgets"] }, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, error: "connection refused" });
  });
});
