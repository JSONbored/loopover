// The tool-contract model (#9517). One entry per MCP tool, carrying its schemas AND the metadata
// every runtime needs to decide whether it may serve that tool at all.
//
// Two rules this file exists to enforce, both learned from surfaces that drifted:
//
//  1. Schemas live ON the entry, never in a name-keyed side map. metagraphed keeps its output
//     schemas in a `TOOL_OUTPUT_SCHEMAS[name]` lookup, where a typo'd key silently drops the
//     schema and nothing fails. Here a tool without an output schema is a type error.
//  2. `listToolDefinitions()` is the only projection. Nothing downstream reads TOOL_CONTRACTS
//     directly, so cross-cutting concerns (JSON Schema conversion, annotation defaults) are
//     applied exactly once instead of per consumer.
import { z } from "zod";

/** Categories a tool can belong to, mirroring the ids the servers already advertise as
 *  `_meta.category` and the stdio CLI groups its `tools` output by. */
/**
 * Canonical category order for grouped rendering: contributor-facing surfaces first, operator ones last.
 * `ops`, `fleet`, and `tenant` are #9522's management families -- one instance's queue/safety controls, the
 * cross-instance fleet, and the hosted control plane's tenants respectively. Kept ordered so every display
 * consumer inherits one ordering instead of inventing its own.
 */
export const TOOL_CATEGORIES = ["maintainer", "review", "branch", "discovery", "agent", "utility", "admin", "ops", "fleet", "tenant"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Who a caller must be for a tool to run. Mirrors the identity kinds `src/auth/security.ts`
 *  actually authenticates -- this is the declaration a runtime enforces against, not a hint. */
export const TOOL_AUTH_LEVELS = ["public", "token", "session", "maintainer", "operator", "mcp-admin", "internal"] as const;
export type ToolAuthLevel = (typeof TOOL_AUTH_LEVELS)[number];

/** Where the state a tool reads physically lives. This is why LoopOver runs more than one MCP
 *  server and cannot collapse to one process: `local-git` tools read the caller's uncommitted
 *  working tree, `miner` tools read the miner box's local stores, and neither is reachable from
 *  a hosted Worker. A runtime registers only the localities it can actually serve. */
export const TOOL_LOCALITIES = ["remote", "local-git", "miner"] as const;
export type ToolLocality = (typeof TOOL_LOCALITIES)[number];

/** Which deployments expose the tool. `selfhost`-only tools depend on capabilities the Cloudflare
 *  bundle has no way to provide (fs-backed config, a redeploy socket); `cloud`-only tools depend
 *  on fleet/tenant state a single self-hosted instance does not have. */
export const TOOL_AVAILABILITIES = ["cloud", "selfhost", "both"] as const;
export type ToolAvailability = (typeof TOOL_AVAILABILITIES)[number];

/** MCP tool annotations advertised in `tools/list`. Defaults are applied in the projection, so an
 *  entry only states what differs from "safe, read-only". */
export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
};

/**
 * One tool's complete contract.
 *
 * `input`/`output` are `ZodObject`s rather than raw shapes because both consumers need something
 * different from them and each conversion must happen in exactly one place: the MCP SDK's
 * `registerTool` wants `.shape`, while the agent-spec builders and any Ajv validator want JSON
 * Schema via `z.toJSONSchema`. Storing the object keeps both derivable; storing a bare shape
 * would not.
 *
 * `output` is intentionally typed as a loose object (`z.looseObject`, i.e. `additionalProperties`
 * open). An MCP output schema is a *floor*, not a fence: a server that starts returning an extra
 * field must not retroactively invalidate a client validating against the older schema. This is
 * the wire-compatibility constraint metagraphed hit head-on when it tried to reuse its strict REST
 * schemas for MCP output and found the tighter contract was a regression.
 */
export type ToolContract = {
  name: string;
  title: string;
  description: string;
  category: ToolCategory;
  auth: ToolAuthLevel;
  locality: ToolLocality;
  availability: ToolAvailability;
  annotations?: Partial<ToolAnnotations>;
  input: z.ZodObject;
  output: z.ZodObject;
};

/** JSON Schema as emitted by `z.toJSONSchema` -- structurally open because draft-2020-12 allows
 *  keywords we neither enumerate nor interpret here. */
export type JsonSchemaLike = Record<string, unknown>;

/** A tool as advertised over the wire: schemas converted to JSON Schema, annotations defaulted. */
export type McpToolDefinition = {
  name: string;
  title: string;
  description: string;
  category: ToolCategory;
  auth: ToolAuthLevel;
  locality: ToolLocality;
  availability: ToolAvailability;
  annotations: ToolAnnotations;
  inputSchema: JsonSchemaLike;
  outputSchema: JsonSchemaLike;
};

/** Read-only, non-destructive: the default posture. A tool that mutates anything must say so. */
const DEFAULT_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };

/** `target` is pinned to draft-2020-12 because that is the dialect the MCP spec's `outputSchema`
 *  is validated under, and the dialect Ajv2020 compiles in the contract validator. */
export function toJsonSchema(schema: z.ZodObject): JsonSchemaLike {
  return z.toJSONSchema(schema, { target: "draft-2020-12" }) as JsonSchemaLike;
}

/**
 * Filter for a runtime's own slice of the registry.
 *
 * Omitting a field means "do not filter on it" rather than "match nothing", so a caller asks only
 * about the axes it actually constrains -- the self-host MCP server filters on availability but
 * serves every locality it can reach, while the stdio server filters on locality but runs against
 * both deployments.
 */
export type ToolFilter = {
  locality?: readonly ToolLocality[];
  availability?: readonly ToolAvailability[];
  category?: readonly ToolCategory[];
};

function matchesFilter(contract: ToolContract, filter: ToolFilter): boolean {
  if (filter.locality && !filter.locality.includes(contract.locality)) return false;
  // `both` satisfies any availability constraint -- it is the absence of a restriction, not a
  // third deployment, so a `selfhost` filter must still return it.
  if (filter.availability && contract.availability !== "both" && !filter.availability.includes(contract.availability)) {
    return false;
  }
  if (filter.category && !filter.category.includes(contract.category)) return false;
  return true;
}

/**
 * The single projection point. Every consumer -- MCP registration on all three servers, the
 * OpenAI/Anthropic spec builders, the generated tool-reference docs, the contract validator --
 * derives from this and never from the raw contract array.
 */
export function projectToolDefinitions(contracts: readonly ToolContract[], filter: ToolFilter = {}): McpToolDefinition[] {
  return contracts.filter((contract) => matchesFilter(contract, filter)).map((contract) => ({
    name: contract.name,
    title: contract.title,
    description: contract.description,
    category: contract.category,
    auth: contract.auth,
    locality: contract.locality,
    availability: contract.availability,
    annotations: { ...DEFAULT_ANNOTATIONS, ...contract.annotations },
    inputSchema: toJsonSchema(contract.input),
    outputSchema: toJsonSchema(contract.output),
  }));
}

/**
 * Helper for authoring a contract entry.
 *
 * The explicit `ToolContract` return annotation is load-bearing, not decoration: without it TS
 * infers each call's `input`/`output` as its own narrow `ZodObject<{...}>` literal, and an array
 * of those heterogeneous types collapses to an unsatisfiable intersection the moment anything
 * maps over it. metagraphed documents the same lesson on its own registry array.
 */
export function defineTool(contract: ToolContract): ToolContract {
  return contract;
}
