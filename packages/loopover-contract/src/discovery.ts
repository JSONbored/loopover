// The discovery projections every runtime serves (#9526).
//
// `/.well-known/mcp.json` and the `/.well-known/agent-tools/*` trio are COMPUTED AT REQUEST TIME from the
// contract registry, never committed. metagraphed learned that the hard way: a committed server card made
// every concurrent tool PR conflict on the same generated file. There is nothing here to commit and nothing
// to regenerate — the registry is the artifact.
//
// Pure by construction: these take the tool list and a few facts and return plain objects, so the Worker,
// the self-host app, and any test can call them identically. Availability filtering is the CALLER's job —
// a self-host deployment passes its own filtered list, which is what makes the same route serve a truthful
// answer on both deployments.
import type { McpToolDefinition } from "./tool-definition.js";

/** Which deployment is answering; the card names it so a reader can tell the two apart. */
export type DiscoveryDeployment = "cloud" | "selfhost";

export type ServerCardInput = {
  /** The server's semantic version. Sourced from @loopover/mcp's package.json — never hand-bumped here. */
  version: string;
  deployment: DiscoveryDeployment;
  /** Absolute base URL this deployment answers on, e.g. `https://api.loopover.ai`. */
  baseUrl: string;
  tools: readonly McpToolDefinition[];
  /**
   * Timestamp for the card. DETERMINISTIC by contract: the caller passes a value derived from the deploy
   * (the version), not `Date.now()` — a clock-derived field would change the ETag on every request and
   * defeat the 304 path entirely.
   */
  generatedAt: string;
};

export type ServerCard = {
  name: string;
  version: string;
  description: string;
  deployment: DiscoveryDeployment;
  generated_at: string;
  capabilities: { tools: { listChanged: boolean } };
  remotes: Array<{ type: "streamable-http"; url: string }>;
  tools: Array<{ name: string; title: string; description: string; category: string; annotations: McpToolDefinition["annotations"] }>;
};

export const SERVER_CARD_NAME = "io.github.JSONbored/loopover";
export const SERVER_CARD_DESCRIPTION =
  "LoopOver's contribution-intelligence tools: issue ranking, branch and PR preflight, gate prediction, review explanation, and maintainer/operator management.";

/** The MCP server card. Tool entries carry the catalog fields a client picks by, not the full schemas. */
export function buildServerCard(input: ServerCardInput): ServerCard {
  return {
    name: SERVER_CARD_NAME,
    version: input.version,
    description: SERVER_CARD_DESCRIPTION,
    deployment: input.deployment,
    generated_at: input.generatedAt,
    capabilities: { tools: { listChanged: true } },
    remotes: [{ type: "streamable-http", url: `${trimTrailingSlash(input.baseUrl)}/mcp` }],
    tools: input.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      category: tool.category,
      annotations: tool.annotations,
    })),
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * How a caller actually invokes one of these tools. Every agent-tools document carries it, because a tool
 * catalog with no executor is a list a reader cannot act on.
 */
export type ToolExecutor = { transport: "streamable-http"; url: string; method: "tools/call" };

function executorFor(baseUrl: string): ToolExecutor {
  return { transport: "streamable-http", url: `${trimTrailingSlash(baseUrl)}/mcp`, method: "tools/call" };
}

export type AgentToolsInput = { baseUrl: string; tools: readonly McpToolDefinition[]; generatedAt: string };

/** The neutral index: every tool with both schemas, plus the executor. */
export function buildAgentToolsIndex(input: AgentToolsInput) {
  return {
    generated_at: input.generatedAt,
    executor: executorFor(input.baseUrl),
    tools: input.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      category: tool.category,
      annotations: tool.annotations,
      input_schema: tool.inputSchema,
      output_schema: tool.outputSchema,
    })),
  };
}

/** OpenAI's function-tool shape. `parameters` is the input schema verbatim — no second translation. */
export function buildOpenAiTools(input: AgentToolsInput) {
  return {
    generated_at: input.generatedAt,
    executor: executorFor(input.baseUrl),
    tools: input.tools.map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    })),
  };
}

/** Anthropic's tool shape. Same schemas, different key names; still one source. */
export function buildAnthropicTools(input: AgentToolsInput) {
  return {
    generated_at: input.generatedAt,
    executor: executorFor(input.baseUrl),
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  };
}

/**
 * A weak ETag over the document.
 *
 * Weak, not strong: these documents are semantically stable per deploy but their byte encoding is not
 * guaranteed across runtimes. The hash is FNV-1a over the serialized body -- non-cryptographic on purpose,
 * since this identifies a cache entry rather than authenticating anything, and it must run cheaply inside a
 * request on the Workers runtime.
 */
export function weakETag(body: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index);
    // FNV prime, via shifts so this stays in 32-bit integer math rather than overflowing to a float.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return `W/"${hash.toString(16)}"`;
}

/** True when the request's `if-none-match` already names this entity, so the caller may answer 304. */
export function matchesETag(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  // A client may send a list, and may drop the weak prefix; compare on the opaque value alone.
  const wanted = etag.replace(/^W\//, "");
  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === wanted || candidate === "*");
}
