// Spec entries for the `.well-known` discovery surfaces (#9526).
//
// SPEC-ONLY, the same split `orb-and-control-route-specs.ts` records: `registerRouteSpec` contributes the
// operation while the handler stays where it is registered, because the app and the OpenAPI registry are
// built by two different functions (`createApp` and `buildOpenApiSpec`) and `defineRoute` needs both at
// once. Nothing is lost here -- these routes take no request body and no query, so the validating wrapper
// would have nothing to validate.
//
// The response schemas come from @loopover/contract, which is also what the handlers build their bodies
// with, so the published document describes exactly the object served rather than a second description of
// it that can drift.
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { AgentToolsIndexSchema, AnthropicToolsSchema, OpenAiToolsSchema, ServerCardSchema } from "@loopover/contract/discovery";
import { DISCOVERY_PATHS } from "../mcp/discovery-routes";
import { registerRouteSpec } from "./define-route";
import type { z } from "zod";

/**
 * One entry per discovery path, keyed BY the path constant.
 *
 * Keyed rather than listed so the type system enforces exhaustiveness: adding a document to
 * DISCOVERY_PATHS without describing it here is a compile error, not a ratchet failure discovered in CI.
 */
const DISCOVERY_SPECS: Record<(typeof DISCOVERY_PATHS)[number], { operationId: string; summary: string; schema: z.ZodTypeAny }> = {
  "/.well-known/mcp.json": {
    operationId: "getMcpServerCard",
    summary: "MCP server card for this deployment",
    schema: ServerCardSchema,
  },
  "/.well-known/agent-tools/index.json": {
    operationId: "getAgentToolsIndex",
    summary: "Neutral agent-tools catalog with both schemas per tool",
    schema: AgentToolsIndexSchema,
  },
  "/.well-known/agent-tools/openai.json": {
    operationId: "getAgentToolsOpenAi",
    summary: "Agent-tools catalog in OpenAI's function-tool shape",
    schema: OpenAiToolsSchema,
  },
  "/.well-known/agent-tools/anthropic.json": {
    operationId: "getAgentToolsAnthropic",
    summary: "Agent-tools catalog in Anthropic's tool shape",
    schema: AnthropicToolsSchema,
  },
};

export function registerDiscoveryRouteSpecs(registry: OpenAPIRegistry): void {
  for (const path of DISCOVERY_PATHS) {
    const spec = DISCOVERY_SPECS[path];
    registerRouteSpec(registry, {
      method: "get",
      path,
      operationId: spec.operationId,
      tags: ["Discovery"],
      summary: spec.summary,
      // Unauthenticated on purpose: a registry crawler has no token, and everything here -- tool names,
      // descriptions, schemas -- is already public through /mcp's own tools/list.
      auth: "public",
      description:
        "Computed at request time from the tool contract registry, filtered to what this deployment serves. " +
        "Carries a weak ETag; send `if-none-match` to get a 304 instead of the body.",
      responses: {
        200: { description: spec.summary, schema: spec.schema },
        304: { description: "The caller's `if-none-match` already names this document" },
      },
    });
  }
}
