import type { Plugin } from "vite";

// Streaming chat endpoint for the miner-ui chat rail (#6517). `POST /api/chat` grounds answers in the miner's own
// read-only `loopover_miner_*` MCP tools via the engine's chat-grounding module — this file is transport only:
// route match, body validation, and re-emitting the engine's events as Server-Sent Events. No grounding logic,
// no tool knowledge, and no action-dispatch lives here.
//
// Transport notes:
//  - `text/event-stream`, one `data: <json>\n\n` line per event, consumed client-side via fetch() + ReadableStream
//    (not the native EventSource API, which cannot send a POST body).
//  - A malformed/empty `messages` body is rejected as a plain non-streamed 4xx JSON error, before any model call.
//  - `{"type":"done"}` always terminates a started stream — the engine guarantees it, including on its error paths.
//  - Registered after authPlugin() in vite.config.ts, so vite-auth.ts's (#4858) session-cookie gate already rejects
//    unauthenticated requests before this middleware is reached — no new auth mechanism here.

/** Wire events mirrored from the engine's ChatGroundingEvent union; re-emitted verbatim as SSE data lines. */
export type ChatSseEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

/**
 * Hand-written view of the sibling engine package's surface (same convention as vite-run-state-api.ts's
 * RunStateModule) — the app deliberately does not depend on the engine's emitted .d.ts.
 */
type ChatGroundingModule = {
  isValidChatMessages: (value: unknown) => boolean;
  runChatGrounding: (
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options?: Record<string, unknown>,
  ) => AsyncIterable<ChatSseEvent>;
};

export type ChatApiDeps = {
  loadChatGroundingModule: () => Promise<ChatGroundingModule>;
};

const defaultDeps: ChatApiDeps = {
  // The built engine output, not its TypeScript source — mirrors how vite-run-state-api.ts reaches into the
  // sibling package (`packages/loopover-miner/lib/run-state.js`).
  loadChatGroundingModule: () => import("../../packages/loopover-engine/dist/index.js") as Promise<ChatGroundingModule>,
};

/** A buffered JSON reply (validation failures) or a live event stream. */
export type ChatApiResult =
  { kind: "json"; status: number; body: string } | { kind: "stream"; events: AsyncIterable<ChatSseEvent> };

/** Serializes one event as an SSE frame. One named place so the wire format can't drift between call sites. */
export function formatSseEvent(event: ChatSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function matchesChatRoute(method: string | undefined, url: string | undefined): boolean {
  return url === "/api/chat" && method === "POST";
}

function invalidBody(message: string): ChatApiResult {
  return { kind: "json", status: 400, body: JSON.stringify({ error: message }) };
}

/**
 * Factored out of the plugin for testing (the vite-run-state-api.ts convention). Returns `null` when this is not
 * the chat route, so the middleware falls through.
 */
export async function handleChatRequest(
  method: string | undefined,
  url: string | undefined,
  rawBody: string,
  deps: ChatApiDeps = defaultDeps,
): Promise<ChatApiResult | null> {
  if (!matchesChatRoute(method, url)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return invalidBody("invalid_json: request body must be JSON");
  }

  const messages = (parsed as { messages?: unknown } | null)?.messages;
  const chatModule = await deps.loadChatGroundingModule();
  if (!chatModule.isValidChatMessages(messages)) {
    return invalidBody(
      "invalid_messages: expected a non-empty messages array of {role: 'user'|'assistant', content: string} whose last entry is a user message",
    );
  }

  return {
    kind: "stream",
    events: chatModule.runChatGrounding(messages as Array<{ role: "user" | "assistant"; content: string }>),
  };
}

type ChatResponse = {
  statusCode: number;
  setHeader: (key: string, value: string) => void;
  write: (chunk: string) => void;
  end: (body?: string) => void;
};

/** Writes an event stream out as SSE frames. Exported for testing against a response double. */
export async function writeSseStream(res: ChatResponse, events: AsyncIterable<ChatSseEvent>): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  for await (const event of events) {
    res.write(formatSseEvent(event));
  }
  res.end();
}

/** Vite dev/preview middleware for the streaming read-only chat endpoint. */
export function chatApiPlugin(deps: ChatApiDeps = defaultDeps): Plugin {
  const attach = (middlewares: {
    use: (
      fn: (req: { method?: string; url?: string } & NodeJS.ReadableStream, res: ChatResponse, next: () => void) => void,
    ) => void;
  }) => {
    middlewares.use((req, res, next) => {
      if (!matchesChatRoute(req.method, req.url)) return next();
      void readRequestBody(req)
        .then((rawBody) => handleChatRequest(req.method, req.url, rawBody, deps))
        .then(async (handled) => {
          if (!handled) return next();
          if (handled.kind === "json") {
            res.statusCode = handled.status;
            res.setHeader("Content-Type", "application/json");
            res.end(handled.body);
            return;
          }
          await writeSseStream(res, handled.events);
        });
    });
  };
  return {
    name: "gittensory-miner-ui:chat-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}

function readRequestBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
