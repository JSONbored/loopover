import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  defaultGovernorPauseState,
  fetchGovernorPauseState,
  GOVERNOR_PAUSE_API_PATH,
  GOVERNOR_PAUSE_STATE_API_PATH,
  GOVERNOR_RESUME_API_PATH,
  pauseGovernor,
  resumeGovernor,
  type GovernorPauseState,
  type GovernorPauseStateResult,
} from "./lib/governor";
import { GovernorControlSection } from "./routes/ledgers";
import {
  governorApiPlugin,
  handleGovernorRequest,
  matchGovernorRoute,
  type GovernorApiDeps,
} from "../vite-governor-api";

const pausedState: GovernorPauseState = {
  paused: true,
  reason: "investigating a bad PR",
  pausedAt: "2026-07-13T12:00:00.000Z",
};

describe("defaultGovernorPauseState (#4857)", () => {
  it("is the not-paused state with no reason/timestamp", () => {
    expect(defaultGovernorPauseState()).toEqual({ paused: false, reason: null, pausedAt: null });
  });
});

describe("GovernorControlSection (#4857)", () => {
  it("renders the loading state before the first result arrives", () => {
    render(
      <GovernorControlSection result={null} pending={false} onPause={() => undefined} onResume={() => undefined} />,
    );
    expect(screen.getByText(/Loading governor state/i)).toBeTruthy();
  });

  it("renders an error message when the local API is unreachable", () => {
    render(
      <GovernorControlSection
        result={{ ok: false, error: "connection refused" }}
        pending={false}
        onPause={() => undefined}
        onResume={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("connection refused");
  });

  it("shows a Pause button and calls onPause when not currently paused", () => {
    const onPause = vi.fn();
    render(
      <GovernorControlSection
        result={{ ok: true, pauseState: defaultGovernorPauseState() }}
        pending={false}
        onPause={onPause}
        onResume={() => undefined}
      />,
    );
    expect(screen.getByText("Not paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause governor" }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it("shows the pause reason/timestamp and a Resume button and calls onResume when currently paused", () => {
    const onResume = vi.fn();
    render(
      <GovernorControlSection
        result={{ ok: true, pauseState: pausedState }}
        pending={false}
        onPause={() => undefined}
        onResume={onResume}
      />,
    );
    expect(screen.getByText(/Paused since 2026-07-13T12:00:00.000Z \(investigating a bad PR\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume governor" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("disables the action button while an action is pending", () => {
    render(
      <GovernorControlSection
        result={{ ok: true, pauseState: defaultGovernorPauseState() }}
        pending={true}
        onPause={() => undefined}
        onResume={() => undefined}
      />,
    );
    expect((screen.getByRole("button", { name: "Pause governor" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("fetchGovernorPauseState / pauseGovernor / resumeGovernor (#4857)", () => {
  const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

  it("fetchGovernorPauseState returns a typed pause state from a well-formed payload, requesting the local API path", async () => {
    let requested: string | undefined;
    const result = await fetchGovernorPauseState(async (input) => {
      requested = String(input);
      return jsonResponse(200, { pauseState: pausedState });
    });
    expect(requested).toBe(GOVERNOR_PAUSE_STATE_API_PATH);
    expect(result).toEqual({ ok: true, pauseState: pausedState });
  });

  it("fetchGovernorPauseState surfaces non-2xx, malformed payloads, and thrown fetches as typed errors", async () => {
    expect(await fetchGovernorPauseState(async () => jsonResponse(500, {}))).toEqual({
      ok: false,
      error: "local governor pause-state API responded 500",
    });
    expect(
      await fetchGovernorPauseState(async () => jsonResponse(200, { pauseState: { paused: "yes" } })),
    ).toMatchObject({
      ok: false,
    });
    expect(
      await fetchGovernorPauseState(async () => {
        throw new Error("connection refused");
      }),
    ).toEqual({ ok: false, error: "connection refused" });
  });

  it("pauseGovernor POSTs a reason body to the pause path and returns the resulting pause state", async () => {
    let requested: { input: string; init: RequestInit | undefined } | undefined;
    const result = await pauseGovernor("bad PR", async (input, init) => {
      requested = { input: String(input), init };
      return jsonResponse(200, { pauseState: pausedState });
    });
    expect(requested?.input).toBe(GOVERNOR_PAUSE_API_PATH);
    expect(requested?.init?.method).toBe("POST");
    expect(JSON.parse(String(requested?.init?.body))).toEqual({ reason: "bad PR" });
    expect(result).toEqual({ ok: true, pauseState: pausedState });
  });

  it("pauseGovernor omits reason from the body when not given", async () => {
    let requested: { init: RequestInit | undefined } | undefined;
    await pauseGovernor(undefined, async (input, init) => {
      requested = { init };
      return jsonResponse(200, { pauseState: pausedState });
    });
    expect(JSON.parse(String(requested?.init?.body))).toEqual({});
  });

  it("resumeGovernor POSTs to the resume path with an empty body and returns the resulting pause state", async () => {
    let requested: { input: string; init: RequestInit | undefined } | undefined;
    const result = await resumeGovernor(async (input, init) => {
      requested = { input: String(input), init };
      return jsonResponse(200, { pauseState: defaultGovernorPauseState() });
    });
    expect(requested?.input).toBe(GOVERNOR_RESUME_API_PATH);
    expect(requested?.init?.method).toBe("POST");
    expect(JSON.parse(String(requested?.init?.body))).toEqual({});
    expect(result).toEqual({ ok: true, pauseState: defaultGovernorPauseState() });
  });

  it("pauseGovernor/resumeGovernor surface a thrown fetch as a typed error", async () => {
    const failing: GovernorPauseStateResult = { ok: false, error: "connection refused" };
    expect(
      await pauseGovernor("x", async () => {
        throw new Error("connection refused");
      }),
    ).toEqual(failing);
    expect(
      await resumeGovernor(async () => {
        throw new Error("connection refused");
      }),
    ).toEqual(failing);
  });
});

describe("matchGovernorRoute (#4857)", () => {
  it("matches GET (or method-less) requests to /api/governor/pause-state", () => {
    expect(matchGovernorRoute("GET", "/api/governor/pause-state")).toBe("pause-state-get");
    expect(matchGovernorRoute(undefined, "/api/governor/pause-state")).toBe("pause-state-get");
  });

  it("matches POST /api/governor/pause and /api/governor/resume", () => {
    expect(matchGovernorRoute("POST", "/api/governor/pause")).toBe("pause-post");
    expect(matchGovernorRoute("POST", "/api/governor/resume")).toBe("resume-post");
  });

  it("matches nothing for any other method/path combination", () => {
    expect(matchGovernorRoute("POST", "/api/governor/pause-state")).toBeNull();
    expect(matchGovernorRoute("GET", "/api/governor/pause")).toBeNull();
    expect(matchGovernorRoute("GET", "/api/portfolio-queue")).toBeNull();
  });
});

describe("handleGovernorRequest (#4857)", () => {
  function deps(overrides: Partial<GovernorApiDeps> = {}): GovernorApiDeps {
    return {
      loadGovernorStateModule: async () => ({
        resolveGovernorStateDbPath: () => "/home/miner/.config/gittensory-miner/governor-state.sqlite3",
        loadPauseState: () => pausedState,
        savePauseState: (input) => ({
          paused: input.paused,
          reason: input.paused ? (input.reason ?? null) : null,
          pausedAt: input.paused ? "2026-07-13T12:30:00.000Z" : null,
        }),
      }),
      fileExists: () => true,
      ...overrides,
    };
  }

  it("falls through (null) for a request that matches none of the three governor routes", async () => {
    expect(await handleGovernorRequest("GET", "/api/portfolio-queue", "", deps())).toBeNull();
    expect(await handleGovernorRequest("POST", "/api/governor/pause-state", "", deps())).toBeNull();
  });

  it("GET pause-state serves the real store's pause state", async () => {
    const handled = await handleGovernorRequest("GET", "/api/governor/pause-state", "", deps());
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ pauseState: pausedState }) });
  });

  it("GET pause-state serves the not-paused default on a fresh install WITHOUT calling loadPauseState", async () => {
    // Mirrors the sibling read-only endpoints' fresh-install test shape: the module import itself (needed to
    // read resolveGovernorStateDbPath for the fileExists check) is expected, but the STORE-touching call
    // (loadPauseState) must never fire once fileExists says there is nothing to read yet.
    let loaded = false;
    const handled = await handleGovernorRequest(
      "GET",
      "/api/governor/pause-state",
      "",
      deps({
        fileExists: () => false,
        loadGovernorStateModule: async () => ({
          resolveGovernorStateDbPath: () => "/nowhere/governor-state.sqlite3",
          loadPauseState: () => {
            loaded = true;
            return pausedState;
          },
          savePauseState: () => defaultGovernorPauseState(),
        }),
      }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ pauseState: defaultGovernorPauseState() }) });
    expect(loaded).toBe(false);
  });

  it("POST pause parses an optional reason from the request body and returns the saved pause state", async () => {
    const handled = await handleGovernorRequest(
      "POST",
      "/api/governor/pause",
      JSON.stringify({ reason: "bad PR" }),
      deps(),
    );
    expect(handled).toEqual({
      status: 200,
      body: JSON.stringify({ pauseState: { paused: true, reason: "bad PR", pausedAt: "2026-07-13T12:30:00.000Z" } }),
    });
  });

  it("POST pause tolerates an empty or malformed body (no reason)", async () => {
    const empty = await handleGovernorRequest("POST", "/api/governor/pause", "", deps());
    expect(empty).toEqual({
      status: 200,
      body: JSON.stringify({ pauseState: { paused: true, reason: null, pausedAt: "2026-07-13T12:30:00.000Z" } }),
    });
    const malformed = await handleGovernorRequest("POST", "/api/governor/pause", "{not json", deps());
    expect(malformed).toEqual({
      status: 200,
      body: JSON.stringify({ pauseState: { paused: true, reason: null, pausedAt: "2026-07-13T12:30:00.000Z" } }),
    });
    const nonStringReason = await handleGovernorRequest(
      "POST",
      "/api/governor/pause",
      JSON.stringify({ reason: 42 }),
      deps(),
    );
    expect(nonStringReason).toEqual({
      status: 200,
      body: JSON.stringify({ pauseState: { paused: true, reason: null, pausedAt: "2026-07-13T12:30:00.000Z" } }),
    });
  });

  it("POST resume saves the not-paused state, ignoring any body", async () => {
    const handled = await handleGovernorRequest("POST", "/api/governor/resume", "", deps());
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ pauseState: defaultGovernorPauseState() }) });
  });

  it("surfaces a store failure as a 500 with a safe message, for both read and write routes", async () => {
    const brokenDeps = deps({
      loadGovernorStateModule: async () => {
        throw new Error("sqlite locked");
      },
    });
    expect(await handleGovernorRequest("GET", "/api/governor/pause-state", "", brokenDeps)).toEqual({
      status: 500,
      body: JSON.stringify({ error: "sqlite locked" }),
    });
    expect(await handleGovernorRequest("POST", "/api/governor/pause", "", brokenDeps)).toEqual({
      status: 500,
      body: JSON.stringify({ error: "sqlite locked" }),
    });
  });
});

type FakeReq = { method?: string; url?: string } & NodeJS.ReadableStream;

/** A minimal Node-readable-stream double: `.on("data"/"end", ...)` registration works like a real stream, with
 *  the body (if any) emitted on a microtask so `readRequestBody`'s listeners are attached first, exactly like a
 *  real Node stream defers emission past the current synchronous tick. */
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

type CapturedRequestHandler = (
  req: FakeReq,
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
  next: () => void,
) => void;

function captureMiddleware(deps?: Partial<GovernorApiDeps>): CapturedRequestHandler {
  let captured: CapturedRequestHandler | undefined;
  const plugin = governorApiPlugin(
    deps
      ? {
          loadGovernorStateModule: async () => ({
            resolveGovernorStateDbPath: () => "/home/miner/.config/gittensory-miner/governor-state.sqlite3",
            loadPauseState: () => defaultGovernorPauseState(),
            savePauseState: (input) => ({ paused: input.paused, reason: input.reason ?? null, pausedAt: null }),
          }),
          fileExists: () => true,
          ...deps,
        }
      : undefined,
  );
  const server = { middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } };
  // @ts-expect-error -- the test double only implements the subset of Vite's ViteDevServer this plugin reads.
  plugin.configureServer(server);
  if (!captured) throw new Error("governorApiPlugin did not register a middleware");
  return captured;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let ended: string | undefined;
  return {
    res: {
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
    },
    headers,
    getEnded: () => ended,
    getStatus: () => statusCode,
  };
}

describe("governorApiPlugin (#4857)", () => {
  it("falls through to next() for a request that matches none of the three governor routes, never reading its body", async () => {
    const middleware = captureMiddleware();
    const { res } = fakeResponse();
    let calledNext = false;
    // A body on a non-matching request would hang readRequestBody's Promise if it were (wrongly) read, since
    // this fake request only ever emits once; calling next() synchronously here proves the body was never touched.
    middleware(fakeRequest("GET", "/api/portfolio-queue"), res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(true);
  });

  it("serves GET /api/governor/pause-state from the real (injected) store", async () => {
    const middleware = captureMiddleware({
      loadGovernorStateModule: async () => ({
        resolveGovernorStateDbPath: () => "/home/miner/.config/gittensory-miner/governor-state.sqlite3",
        loadPauseState: () => pausedState,
        savePauseState: () => defaultGovernorPauseState(),
      }),
    });
    const { res, getEnded, getStatus } = fakeResponse();
    middleware(fakeRequest("GET", "/api/governor/pause-state"), res, () => undefined);
    await vi.waitFor(() => expect(getEnded()).toBeDefined());
    expect(getStatus()).toBe(200);
    expect(JSON.parse(getEnded() ?? "{}")).toEqual({ pauseState: pausedState });
  });

  it("reads a POST body and pauses via the real (injected) store", async () => {
    const middleware = captureMiddleware({
      loadGovernorStateModule: async () => ({
        resolveGovernorStateDbPath: () => "/home/miner/.config/gittensory-miner/governor-state.sqlite3",
        loadPauseState: () => defaultGovernorPauseState(),
        savePauseState: (input) => ({
          paused: input.paused,
          reason: input.reason ?? null,
          pausedAt: input.paused ? "2026-07-13T12:30:00.000Z" : null,
        }),
      }),
    });
    const { res, getEnded, getStatus } = fakeResponse();
    middleware(fakeRequest("POST", "/api/governor/pause", JSON.stringify({ reason: "bad PR" })), res, () => undefined);
    await vi.waitFor(() => expect(getEnded()).toBeDefined());
    expect(getStatus()).toBe(200);
    expect(JSON.parse(getEnded() ?? "{}")).toEqual({
      pauseState: { paused: true, reason: "bad PR", pausedAt: "2026-07-13T12:30:00.000Z" },
    });
  });

  it("also attaches via configurePreviewServer for `vite preview`", () => {
    let captured: CapturedRequestHandler | undefined;
    const plugin = governorApiPlugin();
    const server = { middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } };
    // @ts-expect-error -- same partial test double as configureServer above.
    plugin.configurePreviewServer(server);
    expect(captured).toBeTypeOf("function");
  });
});
