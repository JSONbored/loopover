// Non-MCP projections of the same tool registry (#9517).
//
// The hosted maintainer chat (#9183) and hosted AMS chat (#9184) both need a "grounding tool
// catalog" to hand an LLM. That catalog is this registry in a different envelope -- not a second
// list to maintain. Each builder is a pure function over already-projected definitions, so a tool
// added to the contract appears in every surface at once, and a validator can assert the served
// bytes equal a fresh build.
import type { JsonSchemaLike, McpToolDefinition } from "./tool-definition.js";

export type OpenAIToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchemaLike;
  };
};

export type AnthropicToolSpec = {
  name: string;
  description: string;
  input_schema: JsonSchemaLike;
};

export function buildOpenAIToolSpecs(tools: readonly McpToolDefinition[]): OpenAIToolSpec[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function buildAnthropicToolSpecs(tools: readonly McpToolDefinition[]): AnthropicToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export type AgentToolsIndex = {
  schema_version: number;
  title: string;
  description: string;
  executor: {
    transport: "mcp-streamable-http";
    endpoint: string;
    jsonrpc_method: "tools/call";
  };
  specs: {
    openai: OpenAIToolSpec[];
    anthropic: AnthropicToolSpec[];
  };
  tools: string[];
};

/** Bumped only when the index's own envelope changes shape -- not when tools are added. */
export const AGENT_TOOLS_INDEX_SCHEMA_VERSION = 1;

export function buildAgentToolsIndex(tools: readonly McpToolDefinition[], options: { endpoint: string }): AgentToolsIndex {
  return {
    schema_version: AGENT_TOOLS_INDEX_SCHEMA_VERSION,
    title: "LoopOver agent tools",
    description:
      "Tool specifications for LoopOver's MCP server, projected for OpenAI- and Anthropic-shaped tool-calling clients. Every tool is executed through the same MCP endpoint via tools/call.",
    executor: {
      transport: "mcp-streamable-http",
      endpoint: options.endpoint,
      jsonrpc_method: "tools/call",
    },
    specs: {
      openai: buildOpenAIToolSpecs(tools),
      anthropic: buildAnthropicToolSpecs(tools),
    },
    tools: tools.map((tool) => tool.name),
  };
}
