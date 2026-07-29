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
import { z } from "zod";
import type { McpToolDefinition } from "./tool-definition.js";

/** Which deployment is answering; the card names it so a reader can tell the two apart. */
export const DISCOVERY_DEPLOYMENTS = ["cloud", "selfhost"] as const;
export type DiscoveryDeployment = (typeof DISCOVERY_DEPLOYMENTS)[number];

/**
 * The documents are ZOD SCHEMAS with their TypeScript types inferred, not types with a hand-written schema
 * beside them (#9526).
 *
 * They are served by specced routes, so the published OpenAPI document needs a schema for each -- and a
 * second, hand-kept declaration of the same shape is the drift this whole epic exists to remove. Declaring
 * the schema and inferring the type means the builders below are type-checked against exactly what the API
 * document promises.
 */
const JsonSchemaLikeSchema = z.looseObject({}).describe("JSON Schema (draft 2020-12) for a tool's arguments or result.");
const ToolAnnotationsSchema = z.object({ readOnlyHint: z.boolean(), destructiveHint: z.boolean() });

export const ServerCardSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  deployment: z.enum(DISCOVERY_DEPLOYMENTS),
  generated_at: z.string(),
  capabilities: z.object({ tools: z.object({ listChanged: z.boolean() }) }),
  remotes: z.array(z.object({ type: z.literal("streamable-http"), url: z.string() })),
  tools: z.array(z.object({ name: z.string(), title: z.string(), description: z.string(), category: z.string(), annotations: ToolAnnotationsSchema })),
});

export const ToolExecutorSchema = z.object({ transport: z.literal("streamable-http"), url: z.string(), method: z.literal("tools/call") });

export const AgentToolsIndexSchema = z.object({
  generated_at: z.string(),
  executor: ToolExecutorSchema,
  tools: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      description: z.string(),
      category: z.string(),
      annotations: ToolAnnotationsSchema,
      input_schema: JsonSchemaLikeSchema,
      output_schema: JsonSchemaLikeSchema,
    }),
  ),
});

export const OpenAiToolsSchema = z.object({
  generated_at: z.string(),
  executor: ToolExecutorSchema,
  tools: z.array(z.object({ type: z.literal("function"), function: z.object({ name: z.string(), description: z.string(), parameters: JsonSchemaLikeSchema }) })),
});

export const AnthropicToolsSchema = z.object({
  generated_at: z.string(),
  executor: ToolExecutorSchema,
  tools: z.array(z.object({ name: z.string(), description: z.string(), input_schema: JsonSchemaLikeSchema })),
});

export type ServerCard = z.infer<typeof ServerCardSchema>;
export type ToolExecutor = z.infer<typeof ToolExecutorSchema>;
export type AgentToolsIndex = z.infer<typeof AgentToolsIndexSchema>;
export type OpenAiTools = z.infer<typeof OpenAiToolsSchema>;
export type AnthropicTools = z.infer<typeof AnthropicToolsSchema>;

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
function executorFor(baseUrl: string): ToolExecutor {
  return { transport: "streamable-http", url: `${trimTrailingSlash(baseUrl)}/mcp`, method: "tools/call" };
}

export type AgentToolsInput = { baseUrl: string; tools: readonly McpToolDefinition[]; generatedAt: string };

/** The neutral index: every tool with both schemas, plus the executor. */
export function buildAgentToolsIndex(input: AgentToolsInput): AgentToolsIndex {
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
export function buildOpenAiTools(input: AgentToolsInput): OpenAiTools {
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
export function buildAnthropicTools(input: AgentToolsInput): AnthropicTools {
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
