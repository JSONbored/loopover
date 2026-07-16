import { describe, expect, it, vi } from "vitest";

import { attemptApiPlugin, handleAttemptRequest, matchAttemptRoute, type AttemptApiDeps } from "../vite-attempt-api";
import type { AttemptCliResult } from "../../../packages/loopover-miner/lib/attempt-cli.js";
import { ATTEMPT_API_PATH, runAttemptAction, type AttemptRunResult } from "./lib/attempt";

type FakeReq = { method?: string; url?: string } & NodeJS.ReadableStream;

/** A minimal Node-readable-stream double, mirroring governor.test.tsx's fakeRequest. */
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

const fakeResult: AttemptRunResult = {
  outcome: "attempt_submitted",
  repoFullName: "acme/widgets",
  issueNumber: 42,
  minerLogin: "alice",
  base: "main",
  mode: "live",
  attemptId: "acme_widgets-42-1",
};

/** A fake `runAttempt` that captures the args it received and fires onResult with a structured result, exactly
 *  like the real one does at each genuine return point. */
function deps(overrides: Partial<AttemptApiDeps> = {}): { deps: AttemptApiDeps; calls: string[][] } {
  const calls: string[][] = [];
  const base: AttemptApiDeps = {
    loadAttemptCliModule: async () => ({
      runAttempt: async (args, options) => {
        calls.push(args);
        // The fake stands in for the real runAttempt's structured result; the client-facing loose shape is a
        // structural subset of the CLI's AttemptCliResult.
        options?.onResult?.(fakeResult as unknown as AttemptCliResult);
        return 0;
      },
    }),
    ...overrides,
  };
  return { deps: base, calls };
}

describe("matchAttemptRoute (#6522)", () => {
  it("matches only POST /api/attempt", () => {
    expect(matchAttemptRoute("POST", "/api/attempt")).toBe("attempt-post");
  });

  it("returns null for every other method/path, including the sibling routes' own paths", () => {
    expect(matchAttemptRoute("GET", "/api/attempt")).toBeNull();
    expect(matchAttemptRoute(undefined, "/api/attempt")).toBeNull();
    expect(matchAttemptRoute("POST", "/api/attempt/")).toBeNull();
    expect(matchAttemptRoute("POST", "/api/discover")).toBeNull();
    expect(matchAttemptRoute("POST", "/api/governor/resume")).toBeNull();
    expect(matchAttemptRoute("POST", "/api/portfolio-queue/requeue")).toBeNull();
    expect(matchAttemptRoute("GET", "/api/run-state")).toBeNull();
  });
});

describe("handleAttemptRequest (#6522)", () => {
  it("falls through (null) for a non-matching request without loading the CLI module", async () => {
    let loaded = false;
    const handled = await handleAttemptRequest("GET", "/api/attempt", "", {
      loadAttemptCliModule: async () => {
        loaded = true;
        throw new Error("must not load");
      },
    });
    expect(handled).toBeNull();
    expect(loaded).toBe(false);
  });

  it("marshals a well-formed body into runAttempt and returns the captured onResult payload plus the exit code", async () => {
    const { deps: d, calls } = deps();
    const handled = await handleAttemptRequest(
      "POST",
      "/api/attempt",
      JSON.stringify({
        repoFullName: "acme/widgets",
        issueNumber: 42,
        minerLogin: "alice",
        base: "dev",
        live: true,
        dryRun: false,
        json: true,
      }),
      d,
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ result: fakeResult, exitCode: 0 }) });
    expect(calls).toEqual([["acme/widgets", "42", "--miner-login", "alice", "--base", "dev", "--live", "--json"]]);
  });

  it("returns 400 for a malformed/missing-required-field body WITHOUT ever calling runAttempt", async () => {
    let called = false;
    const d: AttemptApiDeps = {
      loadAttemptCliModule: async () => ({
        runAttempt: async () => {
          called = true;
          return 0;
        },
      }),
    };
    for (const rawBody of [
      "",
      "not json",
      JSON.stringify({}),
      JSON.stringify({ issueNumber: 42 }),
      JSON.stringify({ repoFullName: "acme/widgets" }),
      JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 0 }),
      JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 4.2 }),
      JSON.stringify({ repoFullName: "acme/widgets", issueNumber: "42" }),
    ]) {
      const handled = await handleAttemptRequest("POST", "/api/attempt", rawBody, d);
      expect(handled).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_request_body" }) });
    }
    expect(called).toBe(false);
  });

  it("handles the exit-code-only branch (non-zero exit, onResult never fired) without throwing", async () => {
    const handled = await handleAttemptRequest(
      "POST",
      "/api/attempt",
      JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "alice" }),
      {
        loadAttemptCliModule: async () => ({
          // reportCliFailure path (parse-error/paused/unexpected-error): returns non-zero, never fires onResult.
          runAttempt: async () => 3,
        }),
      },
    );
    expect(handled).toEqual({ status: 502, body: JSON.stringify({ error: "attempt_failed", exitCode: 3 }) });
  });

  it("imposes no artificial timeout — it awaits a slow-resolving runAttempt driven by a manual promise", async () => {
    let resolveRun: ((exitCode: number) => void) | undefined;
    const runPromise = new Promise<number>((resolve) => {
      resolveRun = resolve;
    });
    let settled = false;
    const handledPromise = handleAttemptRequest(
      "POST",
      "/api/attempt",
      JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "alice" }),
      {
        loadAttemptCliModule: async () => ({
          runAttempt: async (_args, options) => {
            options?.onResult?.(fakeResult as unknown as AttemptCliResult);
            return runPromise;
          },
        }),
      },
    ).then((value) => {
      settled = true;
      return value;
    });

    // The handler must still be pending until the injected fake resolves — proving no route-layer timeout fired.
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveRun?.(0);
    const handled = await handledPromise;
    expect(settled).toBe(true);
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ result: fakeResult, exitCode: 0 }) });
  });

  it("never threads a caller-supplied githubToken/token/apiKey field through to runAttempt", async () => {
    const { deps: d, calls } = deps();
    const handled = await handleAttemptRequest(
      "POST",
      "/api/attempt",
      JSON.stringify({
        repoFullName: "acme/widgets",
        issueNumber: 42,
        minerLogin: "alice",
        githubToken: "ghp_secret",
        token: "t",
        apiKey: "k",
      }),
      d,
    );
    expect(handled?.status).toBe(200);
    const args = calls[0] ?? [];
    expect(args).toEqual(["acme/widgets", "42", "--miner-login", "alice"]);
    expect(args.join(" ")).not.toContain("ghp_secret");
    expect(args).not.toContain("--token");
  });

  it("surfaces a CLI-module load failure as a 500 with a safe message", async () => {
    const handled = await handleAttemptRequest(
      "POST",
      "/api/attempt",
      JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "alice" }),
      {
        loadAttemptCliModule: async () => {
          throw new Error("module load boom");
        },
      },
    );
    expect(handled).toEqual({ status: 500, body: JSON.stringify({ error: "module load boom" }) });
  });
});

describe("attemptApiPlugin middleware (#6522)", () => {
  function captureMiddleware(
    server: { middlewares: { use: (fn: CapturedRequestHandler) => void } },
    d: AttemptApiDeps,
  ) {
    const plugin = attemptApiPlugin(d);
    // @ts-expect-error -- the test double only implements the subset of Vite's server this plugin reads.
    plugin.configureServer(server);
  }

  it("falls through to next() for a non-matching request without ever reading its body", () => {
    let captured: CapturedRequestHandler | undefined;
    captureMiddleware({ middlewares: { use: (fn) => (captured = fn) } }, deps().deps);
    const { res } = fakeResponse();
    let calledNext = false;
    captured?.(fakeRequest("GET", "/api/attempt", "should-not-read"), res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(true);
  });

  it("serves POST /api/attempt through the middleware, reading the body and writing a JSON response", async () => {
    let captured: CapturedRequestHandler | undefined;
    captureMiddleware({ middlewares: { use: (fn) => (captured = fn) } }, deps().deps);
    const { res, headers, getEnded, getStatus } = fakeResponse();
    captured?.(
      fakeRequest(
        "POST",
        "/api/attempt",
        JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "alice" }),
      ),
      res,
      () => {
        throw new Error("next() must not be called for a matched route");
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getStatus()).toBe(200);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(getEnded()).toBe(JSON.stringify({ result: fakeResult, exitCode: 0 }));
  });

  it("also registers via configurePreviewServer", () => {
    let captured: CapturedRequestHandler | undefined;
    const plugin = attemptApiPlugin(deps().deps);
    // @ts-expect-error -- test double for the preview server's middleware stack only.
    plugin.configurePreviewServer({ middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } });
    expect(captured).toBeTypeOf("function");
  });
});

describe("runAttemptAction client (#6522)", () => {
  it("posts to the attempt API and returns the typed result on success", async () => {
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe(ATTEMPT_API_PATH);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        repoFullName: "acme/widgets",
        issueNumber: 42,
        minerLogin: "alice",
      });
      return new Response(JSON.stringify({ result: fakeResult, exitCode: 0 }), { status: 200 });
    });
    const result = await runAttemptAction(
      { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "alice" },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, result: fakeResult, exitCode: 0 });
  });

  it("returns a typed error (not a throw) for an HTTP-level failure, preferring the server error field", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "attempt_failed", exitCode: 3 }), { status: 502 }),
    );
    const result = await runAttemptAction(
      { repoFullName: "acme/widgets", issueNumber: 42 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: "attempt_failed" });
  });

  it("falls back to a status-derived error when a failed response has no error field", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const result = await runAttemptAction(
      { repoFullName: "acme/widgets", issueNumber: 42 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: "local attempt API responded 500" });
  });

  it("rejects an unexpected success payload shape", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ result: { nope: true }, exitCode: 0 }), { status: 200 }),
    );
    const result = await runAttemptAction(
      { repoFullName: "acme/widgets", issueNumber: 42 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: "local attempt API returned an unexpected payload shape" });
  });

  it("returns a typed error when the fetch itself throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const result = await runAttemptAction(
      { repoFullName: "acme/widgets", issueNumber: 42 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: false, error: "connection refused" });
  });
});
