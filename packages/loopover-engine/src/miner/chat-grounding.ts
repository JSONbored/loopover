// Read-only conversational grounding for the miner-ui chat rail (#6517). Answers natural-language questions about
// the miner's OWN local state by driving `@anthropic-ai/claude-agent-sdk`'s `query()` against the miner's existing
// read-only MCP server (packages/loopover-miner/bin/loopover-miner-mcp.js), so the 11 tools' implementations are
// called directly and never reimplemented here.
//
// Boundaries this module enforces, in order:
//  1. Provider fail-closed. Only the `agent-sdk` provider is usable: driver-factory.ts's `claude-cli`/`codex-cli`
//     drivers are task-shaped, single-turn, buffered CodingAgentDriverResult interfaces built for one-shot coding
//     attempts — not a conversational streaming tool-calling loop. Any other/absent provider emits one `error`
//     event and `done`, never a partial/mock/echoed answer.
//  2. Tool allowlist. The session may only reach the 11 read-only `loopover_miner_*` tools below — no write-capable
//     `loopover_*` tool (local-write-tools.ts's LOCAL_WRITE_BOUNDARY) and no action-dispatch route.
//  3. Privacy. A conversational surface adds a leak vector the tools themselves don't have: a user can simply ASK
//     "what's my trust score" and an ungrounded model could hallucinate one. The system prompt instructs the model
//     to decline those terms, and — because a prompt is not enforcement — every outgoing `text` chunk is checked
//     against track-record-summary.ts's PUBLIC_FIELD_BLOCKLIST and redacted on a hit.
//
// The endpoint is stateless: the caller supplies the full message history per request (no conversation store).

import { PUBLIC_FIELD_BLOCKLIST } from "../track-record-summary.js";
import { resolveFirstConfiguredCodingAgentDriverName } from "./driver-factory.js";

/**
 * The exact read-only tools this endpoint may call — one `server.registerTool(...)` call each in
 * packages/loopover-miner/bin/loopover-miner-mcp.js. Frozen and asserted by an invariant test so a future
 * accidental addition of a 12th tool (or a write-capable one) fails the suite, not just code review.
 */
export const CHAT_GROUNDING_TOOL_NAMES = Object.freeze([
  "loopover_miner_ping",
  "loopover_miner_get_portfolio_dashboard",
  "loopover_miner_get_manage_status",
  "loopover_miner_list_claims",
  "loopover_miner_get_audit_feed",
  "loopover_miner_get_run_state",
  "loopover_miner_list_plans",
  "loopover_miner_get_plan",
  "loopover_miner_get_governor_decisions",
  "loopover_miner_status",
  "loopover_miner_get_calibration_report",
] as const);

/** The MCP server name the session registers the miner tools under. */
export const CHAT_GROUNDING_MCP_SERVER_NAME = "loopover-miner";

/** Ceiling on a single conversational session's tool-calling turns. */
const CHAT_MAX_TURNS = 12;

/** Replacement written in place of any `text` chunk that trips the privacy backstop. */
export const CHAT_REDACTED_TEXT =
  "[redacted: this assistant has no access to wallet, hotkey, coldkey, reward, payout, or trust-score data]";

/**
 * System prompt. The declined-term sentence is derived from track-record-summary.ts's PUBLIC_FIELD_BLOCKLIST —
 * the same term set the output-side backstop enforces, so the instruction and the enforcement can't drift.
 */
export const CHAT_SYSTEM_PROMPT = [
  "You are the Loopover miner's local assistant. You answer questions about this miner's own local state only.",
  "",
  "Ground every answer in the read-only loopover_miner_* tools available to you. If a tool cannot answer the",
  "question, say so plainly — never guess, estimate, or invent a value.",
  "",
  "You have no access to wallet, hotkey, coldkey, reward, payout, ranking, or trust-score data: none of the",
  "available tools expose it. If asked for any of those, say plainly that this data is not available to you",
  "rather than producing a number.",
  "",
  "You are read-only. You cannot open pull requests, file issues, pause or resume the governor, or release or",
  "requeue portfolio work. If asked to do any of those, explain that this chat cannot take actions.",
].join("\n");

/** A single conversational turn supplied by the caller. */
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

/** The wire events this module yields; the transport re-emits each one verbatim as an SSE `data:` line. */
export type ChatGroundingEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

/** The exact option subset this module puts on a chat `query()` session. */
export type ChatQueryOptions = {
  systemPrompt: string;
  allowedTools: readonly string[];
  mcpServers: Record<string, { command: string; args: string[] }>;
  maxTurns: number;
};

/**
 * Injected `query()`-shaped function — mirrors agent-sdk-driver.ts's AgentSdkQueryFn convention so tests drive a
 * fake async-iterable and CI never makes a real model call. Messages are consumed structurally (plain records).
 */
export type ChatQueryFn = (input: {
  prompt: string;
  options: ChatQueryOptions;
}) => AsyncIterable<Record<string, unknown>>;

export type RunChatGroundingOptions = {
  /** Injected `query()` loop; defaults to the real `@anthropic-ai/claude-agent-sdk` export. */
  query?: ChatQueryFn | undefined;
  /** Env used for provider resolution; defaults to `process.env`. */
  env?: Record<string, string | undefined> | undefined;
  /** Command/args that start the miner's read-only MCP server over stdio. */
  mcpServer?: { command: string; args: string[] } | undefined;
};

/* v8 ignore start -- real-SDK path: imports @anthropic-ai/claude-agent-sdk and opens a live session; tests inject
   a fake ChatQueryFn instead (same convention as agent-sdk-driver.ts's injected AgentSdkQueryFn). */
const defaultQuery: ChatQueryFn = (input) => {
  async function* stream(): AsyncGenerator<Record<string, unknown>> {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
      query: (params: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown>;
    };
    for await (const message of sdk.query({ prompt: input.prompt, options: input.options })) {
      yield message as Record<string, unknown>;
    }
  }
  return stream();
};
/* v8 ignore stop */

/** Default stdio command for the miner's own MCP server — the bin `packages/loopover-miner/package.json` exposes. */
const DEFAULT_MCP_SERVER = Object.freeze({
  command: "npx",
  args: Object.freeze(["-y", "@loopover/miner", "loopover-miner-mcp"]) as unknown as string[],
});

/**
 * Resolves the injected seam, defaulting to the real SDK loop. Split out of `runChatGrounding` (which would invoke
 * the result immediately) so the default arm is exercised by binding it, never by opening a live session —
 * mirroring how agent-sdk-driver.ts's factory resolves `options.query ?? defaultQuery` without calling it.
 */
export function resolveChatQuery(options: RunChatGroundingOptions = {}): ChatQueryFn {
  return options.query ?? defaultQuery;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** True when any blocked term appears — the enforcement half of the privacy boundary. */
export function containsBlockedTerm(text: string): boolean {
  return PUBLIC_FIELD_BLOCKLIST.some((pattern) => pattern.test(text));
}

/**
 * Output-side backstop: a chunk mentioning a blocked term is replaced wholesale rather than forwarded. Replacing
 * (not filtering) keeps the stream well-formed and makes the refusal visible to the user.
 */
export function redactBlockedText(text: string): string {
  return containsBlockedTerm(text) ? CHAT_REDACTED_TEXT : text;
}

/** Validates the caller-supplied history. Stateless endpoint: the full history arrives per request. */
export function isValidChatMessages(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) return false;
    if (record.role !== "user" && record.role !== "assistant") return false;
    if (typeof record.content !== "string" || record.content.length === 0) return false;
  }
  return asRecord(value[value.length - 1])?.role === "user";
}

/**
 * Serializes the caller's history into a single prompt. The SDK session is opened per request (stateless), so the
 * prior turns are replayed as labelled context ahead of the live question.
 */
export function buildChatPrompt(messages: ChatMessage[]): string {
  const history = messages.slice(0, -1);
  const latest = messages[messages.length - 1];
  const lines: string[] = [];
  if (history.length > 0) {
    lines.push("Conversation so far:");
    for (const message of history) {
      lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${message.content}`);
    }
    lines.push("");
  }
  lines.push(`User: ${latest?.content ?? ""}`);
  return lines.join("\n");
}

/**
 * Resolves the provider and returns the fail-closed error code when chat is not usable, or `undefined` when the
 * configured provider is `agent-sdk`. Reuses driver-factory.ts's resolution rather than reading MINER_CODING_AGENT_*
 * directly, so provider parsing lives in exactly one place.
 */
export function resolveChatProviderError(
  env: Record<string, string | undefined>,
): { code: string; message: string } | undefined {
  const provider = resolveFirstConfiguredCodingAgentDriverName(env);
  if (provider === undefined) {
    return {
      code: "no_coding_agent_configured",
      message:
        "No coding-agent provider is configured. Chat requires the agent-sdk provider — set MINER_CODING_AGENT_PROVIDER=agent-sdk.",
    };
  }
  if (provider !== "agent-sdk") {
    return {
      code: "chat_requires_agent_sdk_provider",
      message: `Chat requires the agent-sdk provider; the configured provider is ${provider}, which is a single-turn, buffered coding driver.`,
    };
  }
  return undefined;
}

/** Folds one assistant message's content blocks into wire events. */
function* foldAssistantMessage(message: Record<string, unknown>): Generator<ChatGroundingEvent> {
  const content = asRecord(message.message)?.content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      yield { type: "text", text: redactBlockedText(block.text) };
      continue;
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      yield { type: "tool_call", tool: block.name, input: asRecord(block.input) ?? {} };
    }
  }
}

/** Folds one user message's tool-result blocks (the SDK reports tool output on a `user`-role message). */
function* foldToolResultMessage(message: Record<string, unknown>): Generator<ChatGroundingEvent> {
  const content = asRecord(message.message)?.content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block || block.type !== "tool_result") continue;
    const tool = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    yield { type: "tool_result", tool, output: block.content };
  }
}

/**
 * Drives one grounded conversational turn, yielding wire events. Never throws: an SDK failure becomes an `error`
 * event, and `done` always terminates the stream — including on the fail-closed provider paths.
 */
export async function* runChatGrounding(
  messages: ChatMessage[],
  options: RunChatGroundingOptions = {},
): AsyncGenerator<ChatGroundingEvent> {
  const env = options.env ?? process.env;
  const providerError = resolveChatProviderError(env);
  if (providerError) {
    yield { type: "error", code: providerError.code, message: providerError.message };
    yield { type: "done" };
    return;
  }

  const query = resolveChatQuery(options);
  const mcpServer = options.mcpServer ?? DEFAULT_MCP_SERVER;
  try {
    const stream = query({
      prompt: buildChatPrompt(messages),
      options: {
        systemPrompt: CHAT_SYSTEM_PROMPT,
        allowedTools: CHAT_GROUNDING_TOOL_NAMES,
        mcpServers: { [CHAT_GROUNDING_MCP_SERVER_NAME]: mcpServer },
        maxTurns: CHAT_MAX_TURNS,
      },
    });
    for await (const message of stream) {
      if (message.type === "assistant") {
        yield* foldAssistantMessage(message);
        continue;
      }
      if (message.type === "user") {
        yield* foldToolResultMessage(message);
      }
    }
  } catch (error) {
    yield {
      type: "error",
      code: "chat_grounding_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  yield { type: "done" };
}
