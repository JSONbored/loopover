import { describe, expect, it } from "vitest";

import { handleAuthRequest } from "../vite-auth";
import {
  chatApiPlugin,
  formatSseEvent,
  handleChatRequest,
  writeSseStream,
  type ChatApiDeps,
  type ChatSseEvent,
} from "../vite-chat-api";

// Transport-level coverage for the streaming chat endpoint (#6517). The grounding itself is the engine's
// (packages/loopover-engine/src/miner/chat-grounding.ts, covered by test/unit/chat-grounding-engine.test.ts);
// these tests only prove route matching, body validation, and SSE re-emission.

function deps(overrides: Partial<ChatApiDeps> = {}): ChatApiDeps {
  return {
    loadChatGroundingModule: async () => ({
      isValidChatMessages: (value: unknown) => Array.isArray(value) && value.length > 0,
      runChatGrounding: () =>
        (async function* (): AsyncGenerator<ChatSseEvent> {
          yield { type: "text", text: "hi" };
          yield { type: "done" };
        })(),
    }),
    ...overrides,
  };
}

const VALID_BODY = JSON.stringify({ messages: [{ role: "user", content: "status?" }] });

describe("the auth gate covers /api/chat (#6517)", () => {
  // The chat plugin is registered after authPlugin() in vite.config.ts, so it inherits the existing
  // session-cookie gate (#4858) with no new auth mechanism — an unauthenticated request is rejected in the
  // Connect chain before this endpoint's middleware ever runs.
  const TOKEN = "deterministic-test-token";

  it("rejects an unauthenticated /api/chat request with a 401, before the handler", () => {
    expect(handleAuthRequest("/api/chat", undefined, TOKEN)).toEqual({
      status: 401,
      body: JSON.stringify({ error: "unauthenticated: missing or invalid local miner-ui session cookie" }),
    });
  });

  it("falls through for an authenticated /api/chat request so the chat middleware runs", () => {
    expect(handleAuthRequest("/api/chat", `loopover_miner_ui_token=${TOKEN}`, TOKEN)).toBeNull();
  });
});

describe("handleChatRequest routing (#6517)", () => {
  it("falls through for a different path or a non-POST method", async () => {
    expect(await handleChatRequest("POST", "/api/other", VALID_BODY, deps())).toBeNull();
    expect(await handleChatRequest("GET", "/api/chat", VALID_BODY, deps())).toBeNull();
    expect(await handleChatRequest(undefined, "/api/chat", VALID_BODY, deps())).toBeNull();
  });

  it("never loads the grounding module for a non-matching route", async () => {
    let loaded = false;
    await handleChatRequest("GET", "/api/chat", VALID_BODY, {
      loadChatGroundingModule: async () => {
        loaded = true;
        throw new Error("must not load");
      },
    });
    expect(loaded).toBe(false);
  });
});

describe("handleChatRequest validation (#6517)", () => {
  it("rejects a non-JSON body with a non-streamed 400", async () => {
    expect(await handleChatRequest("POST", "/api/chat", "not json", deps())).toEqual({
      kind: "json",
      status: 400,
      body: JSON.stringify({ error: "invalid_json: request body must be JSON" }),
    });
  });

  it("rejects an empty/malformed messages array with a non-streamed 400", async () => {
    const rejected = await handleChatRequest("POST", "/api/chat", JSON.stringify({ messages: [] }), deps());
    expect(rejected?.kind).toBe("json");
    expect((rejected as { status: number }).status).toBe(400);
    const missing = await handleChatRequest("POST", "/api/chat", JSON.stringify({}), deps());
    expect((missing as { status: number }).status).toBe(400);
    const nullBody = await handleChatRequest("POST", "/api/chat", "null", deps());
    expect((nullBody as { status: number }).status).toBe(400);
  });

  it("delegates validation to the engine, not a second local copy", async () => {
    // The engine's isValidChatMessages is the single source of truth; a module that rejects everything must
    // make the endpoint reject too, with no local override.
    const rejected = await handleChatRequest(
      "POST",
      "/api/chat",
      VALID_BODY,
      deps({
        loadChatGroundingModule: async () => ({
          isValidChatMessages: () => false,
          runChatGrounding: () => (async function* (): AsyncGenerator<ChatSseEvent> {})(),
        }),
      }),
    );
    expect((rejected as { status: number }).status).toBe(400);
  });

  it("returns a stream for a valid body", async () => {
    const handled = await handleChatRequest("POST", "/api/chat", VALID_BODY, deps());
    expect(handled?.kind).toBe("stream");
  });
});

describe("SSE wire format (#6517)", () => {
  it("serializes one event per data line terminated by a blank line", () => {
    expect(formatSseEvent({ type: "text", text: "hi" })).toBe('data: {"type":"text","text":"hi"}\n\n');
    expect(formatSseEvent({ type: "done" })).toBe('data: {"type":"done"}\n\n');
  });

  it("re-emits an upstream stream as SSE lines terminated by done", async () => {
    const written: string[] = [];
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 0,
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      write: (chunk: string) => written.push(chunk),
      end: () => {},
    };
    await writeSseStream(
      res,
      (async function* (): AsyncGenerator<ChatSseEvent> {
        yield { type: "tool_call", tool: "loopover_miner_status", input: {} };
        yield { type: "text", text: "idle" };
        yield { type: "done" };
      })(),
    );
    expect(res.statusCode).toBe(200);
    expect(headers["Content-Type"]).toBe("text/event-stream");
    expect(headers["Cache-Control"]).toBe("no-cache");
    expect(written).toEqual([
      'data: {"type":"tool_call","tool":"loopover_miner_status","input":{}}\n\n',
      'data: {"type":"text","text":"idle"}\n\n',
      'data: {"type":"done"}\n\n',
    ]);
  });

  it("forwards an engine error event verbatim rather than throwing", async () => {
    const written: string[] = [];
    const res = {
      statusCode: 0,
      setHeader: () => {},
      write: (chunk: string) => written.push(chunk),
      end: () => {},
    };
    await writeSseStream(
      res,
      (async function* (): AsyncGenerator<ChatSseEvent> {
        yield { type: "error", code: "no_coding_agent_configured", message: "not configured" };
        yield { type: "done" };
      })(),
    );
    expect(written[0]).toContain('"type":"error"');
    expect(written[0]).toContain("no_coding_agent_configured");
    expect(written.at(-1)).toBe('data: {"type":"done"}\n\n');
  });
});

describe("chatApiPlugin middleware (#6517)", () => {
  type CapturedHandler = (
    req: { method?: string; url?: string; on: (event: string, cb: (chunk?: unknown) => void) => void },
    res: {
      statusCode: number;
      setHeader: (k: string, v: string) => void;
      write: (chunk: string) => void;
      end: (body?: string) => void;
    },
    next: () => void,
  ) => void;

  function captureMiddleware(): CapturedHandler {
    let captured: CapturedHandler | undefined;
    const plugin = chatApiPlugin(deps());
    const server = { middlewares: { use: (fn: CapturedHandler) => (captured = fn) } };
    // @ts-expect-error -- the test double only implements the subset of Vite's ViteDevServer this plugin reads.
    plugin.configureServer(server);
    if (!captured) throw new Error("chatApiPlugin did not register a middleware");
    return captured;
  }

  function fakeReq(method: string, url: string, body: string) {
    return {
      method,
      url,
      on(event: string, cb: (chunk?: unknown) => void) {
        if (event === "data") cb(body);
        if (event === "end") cb();
      },
    };
  }

  it("registers on both the dev and preview servers", () => {
    const plugin = chatApiPlugin(deps());
    expect(plugin.name).toBe("gittensory-miner-ui:chat-api");
    expect(typeof plugin.configureServer).toBe("function");
    expect(typeof plugin.configurePreviewServer).toBe("function");
  });

  it("calls next() for a non-chat route without reading a body", () => {
    const middleware = captureMiddleware();
    let nexted = false;
    middleware(
      fakeReq("GET", "/api/run-state", ""),
      { statusCode: 0, setHeader: () => {}, write: () => {}, end: () => {} },
      () => {
        nexted = true;
      },
    );
    expect(nexted).toBe(true);
  });

  it("streams SSE frames for a valid POST", async () => {
    const middleware = captureMiddleware();
    const written: string[] = [];
    let ended = false;
    const res = {
      statusCode: 0,
      setHeader: () => {},
      write: (chunk: string) => written.push(chunk),
      end: () => {
        ended = true;
      },
    };
    middleware(fakeReq("POST", "/api/chat", VALID_BODY), res, () => {});
    await vi_waitFor(() => ended);
    expect(res.statusCode).toBe(200);
    expect(written.at(-1)).toBe('data: {"type":"done"}\n\n');
  });

  it("answers a malformed POST with a buffered JSON 400, not a stream", async () => {
    const middleware = captureMiddleware();
    let body: string | undefined;
    const res = {
      statusCode: 0,
      setHeader: () => {},
      write: () => {
        throw new Error("must not stream a validation failure");
      },
      end: (value?: string) => {
        body = value;
      },
    };
    middleware(fakeReq("POST", "/api/chat", "not json"), res, () => {});
    await vi_waitFor(() => body !== undefined);
    expect(res.statusCode).toBe(400);
    expect(body).toContain("invalid_json");
  });
});

/** Minimal poll helper — the middleware resolves its promise chain out of band. */
async function vi_waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the middleware to settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
