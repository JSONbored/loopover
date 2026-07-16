import { describe, expect, it, vi } from "vitest";

import { requestAttempt } from "./lib/attempt";
import { type AttemptApiDeps, attemptApiPlugin, handleAttemptRequest, matchAttemptRoute } from "../vite-attempt-api";

const SUBMITTED_RESULT = { outcome: "attempt_submitted", repoFullName: "acme/widgets", issueNumber: 7 };
const BLOCKED_RESULT = { outcome: "blocked_rejection_signaled", repoFullName: "acme/widgets", issueNumber: 7 };
const VALID_BODY = { repoFullName: "acme/widgets", issueNumber: 7, minerLogin: "alice" };

/** A fake `runAttempt` that reports a structured success via onResult and exits 0 (the clean-submit path). */
function successDeps(): { deps: AttemptApiDeps; runAttempt: ReturnType<typeof vi.fn> } {
  const runAttempt = vi.fn(async (_args: string[], options: { onResult: (r: unknown) => void }) => {
    options.onResult(SUBMITTED_RESULT);
    return 0;
  });
  return { deps: { runAttempt }, runAttempt };
}

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

describe("matchAttemptRoute (#6522)", () => {
  it("matches only POST /api/attempt, and no sibling method/path", () => {
    expect(matchAttemptRoute("POST", "/api/attempt")).toBe("attempt-post");
    expect(matchAttemptRoute("GET", "/api/attempt")).toBeNull();
    expect(matchAttemptRoute("POST", "/api/discover")).toBeNull(); // sibling route path
    expect(matchAttemptRoute("POST", "/api/governor/pause")).toBeNull();
    expect(matchAttemptRoute(undefined, undefined)).toBeNull();
  });
});

describe("handleAttemptRequest (#6522)", () => {
  it("passes a well-formed body to runAttempt and returns the captured result + exit code", async () => {
    const { deps, runAttempt } = successDeps();
    const handled = await handleAttemptRequest(
      "POST",
      "/api/attempt",
      JSON.stringify({ ...VALID_BODY, base: "develop", live: true, dryRun: true, json: true }),
      deps,
    );
    expect(runAttempt).toHaveBeenCalledWith(
      ["acme/widgets", "7", "--miner-login", "alice", "--base", "develop", "--live", "--dry-run", "--json"],
      expect.objectContaining({ onResult: expect.any(Function) }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ result: SUBMITTED_RESULT, exitCode: 0 }) });
  });

  it("returns the structured result together with a NON-zero exit for a governed rejection", async () => {
    const runAttempt = vi.fn(async (_args: string[], options: { onResult: (r: unknown) => void }) => {
      options.onResult(BLOCKED_RESULT);
      return 5; // governed rejection still returns a structured result AND a non-zero exit
    });
    const handled = await handleAttemptRequest("POST", "/api/attempt", JSON.stringify(VALID_BODY), { runAttempt });
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ result: BLOCKED_RESULT, exitCode: 5 }) });
  });

  it("returns 400 for a malformed or requirement-missing body, without ever calling runAttempt", async () => {
    const runAttempt = vi.fn();
    const invalid = { status: 400, body: JSON.stringify({ error: "invalid_request_body" }) };
    expect(await handleAttemptRequest("POST", "/api/attempt", "", { runAttempt })).toEqual(invalid);
    expect(await handleAttemptRequest("POST", "/api/attempt", "not json", { runAttempt })).toEqual(invalid);
    expect(await handleAttemptRequest("POST", "/api/attempt", JSON.stringify(["x"]), { runAttempt })).toEqual(invalid);
    expect(
      await handleAttemptRequest(
        "POST",
        "/api/attempt",
        JSON.stringify({ repoFullName: "acme/widgets", issueNumber: 7 }),
        {
          runAttempt,
        },
      ),
    ).toEqual(invalid); // missing minerLogin
    expect(
      await handleAttemptRequest("POST", "/api/attempt", JSON.stringify({ ...VALID_BODY, issueNumber: 0 }), {
        runAttempt,
      }),
    ).toEqual(invalid); // issueNumber must be a positive integer
    expect(
      await handleAttemptRequest("POST", "/api/attempt", JSON.stringify({ ...VALID_BODY, issueNumber: 1.5 }), {
        runAttempt,
      }),
    ).toEqual(invalid);
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it("returns a structured 502 when runAttempt exits non-zero WITHOUT a structured result", async () => {
    const runAttempt = vi.fn(async () => 1); // parse-error/paused/unexpected branch: never calls onResult
    const handled = await handleAttemptRequest("POST", "/api/attempt", JSON.stringify(VALID_BODY), { runAttempt });
    expect(handled).toEqual({ status: 502, body: JSON.stringify({ error: "attempt_failed", exitCode: 1 }) });
  });

  it("imposes no route-level timeout on a slow attempt (a minutes-long worktree run)", async () => {
    let resolveRun: ((code: number) => void) | undefined;
    let captured: ((r: unknown) => void) | undefined;
    const runAttempt = vi.fn((_args: string[], options: { onResult: (r: unknown) => void }) => {
      captured = options.onResult;
      return new Promise<number>((resolve) => {
        resolveRun = resolve;
      });
    });
    const pending = handleAttemptRequest("POST", "/api/attempt", JSON.stringify(VALID_BODY), { runAttempt });
    // The handler must still be waiting on the injected fake — no timeout fired it early.
    const settledEarly = await Promise.race([pending, Promise.resolve("still-pending")]);
    expect(settledEarly).toBe("still-pending");
    captured?.(SUBMITTED_RESULT);
    resolveRun?.(0);
    expect(await pending).toEqual({ status: 200, body: JSON.stringify({ result: SUBMITTED_RESULT, exitCode: 0 }) });
  });

  it("returns 500 (message + safe fallback) when runAttempt throws", async () => {
    const throwsError = vi.fn(async () => {
      throw new Error("worktree exploded");
    });
    expect(
      await handleAttemptRequest("POST", "/api/attempt", JSON.stringify(VALID_BODY), { runAttempt: throwsError }),
    ).toEqual({ status: 500, body: JSON.stringify({ error: "worktree exploded" }) });
    const throwsNonError = vi.fn(async () => {
      throw "nope";
    });
    expect(
      await handleAttemptRequest("POST", "/api/attempt", JSON.stringify(VALID_BODY), { runAttempt: throwsNonError }),
    ).toEqual({ status: 500, body: JSON.stringify({ error: "failed to run local attempt" }) });
  });

  it("falls through (null) for non-attempt method/path combinations", async () => {
    const { deps } = successDeps();
    expect(await handleAttemptRequest("GET", "/api/attempt", "", deps)).toBeNull();
    expect(await handleAttemptRequest("POST", "/api/other", "", deps)).toBeNull();
  });

  it("never threads a credential-shaped body field into runAttempt", async () => {
    const { deps, runAttempt } = successDeps();
    await handleAttemptRequest(
      "POST",
      "/api/attempt",
      JSON.stringify({ ...VALID_BODY, githubToken: "ghp_secret", token: "t", apiKey: "k" }),
      deps,
    );
    const [args] = runAttempt.mock.calls[0];
    expect(args).toEqual(["acme/widgets", "7", "--miner-login", "alice"]);
    expect(JSON.stringify(runAttempt.mock.calls[0])).not.toContain("ghp_secret");
  });
});

describe("attemptApiPlugin middleware (#6522)", () => {
  it("serves a matching request and passes every other request through to next()", async () => {
    const { deps } = successDeps();
    const plugin = attemptApiPlugin(deps);
    let middleware: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
    const server = { middlewares: { use: (fn: typeof middleware) => (middleware = fn) } };
    (plugin.configureServer as (s: unknown) => void)(server);
    (plugin.configurePreviewServer as (s: unknown) => void)(server);
    expect(middleware).toBeTypeOf("function");

    const next = vi.fn();
    middleware!(fakeReq("GET", "/api/other", ""), {}, next);
    expect(next).toHaveBeenCalledTimes(1);

    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await new Promise<void>((resolve) => {
      res.end = vi.fn(() => resolve());
      middleware!(fakeReq("POST", "/api/attempt", JSON.stringify(VALID_BODY)), res, vi.fn());
    });
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
  });
});

describe("requestAttempt client (#6522)", () => {
  it("POSTs the input to /api/attempt and returns the parsed result on success", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ result: SUBMITTED_RESULT, exitCode: 0 }), { status: 200 }),
    );
    const result = await requestAttempt(VALID_BODY, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, result: SUBMITTED_RESULT, exitCode: 0 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/attempt");
    expect(init.method).toBe("POST");
  });

  it("returns a typed error on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 502 }));
    expect(await requestAttempt(VALID_BODY, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "local attempt API responded 502",
    });
  });

  it("returns a typed error on an unexpected payload shape", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }));
    expect(await requestAttempt(VALID_BODY, fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "local attempt API returned an unexpected payload shape",
    });
  });

  it("returns a typed error when fetch rejects (Error and non-Error)", async () => {
    const rejects = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await requestAttempt(VALID_BODY, rejects as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "offline",
    });
    const rejectsNonError = vi.fn(async () => {
      throw "x";
    });
    expect(await requestAttempt(VALID_BODY, rejectsNonError as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "failed to reach the local attempt API",
    });
  });
});
