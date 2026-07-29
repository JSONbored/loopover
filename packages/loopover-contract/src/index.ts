// @loopover/contract — the single zod source of truth for LoopOver's MCP tool and API contracts.
//
// Import from here (or from the ./enums, ./tools, ./agent-specs subpaths) rather than restating a
// shape locally. Every schema in this package is consumed by more than one runtime; a local copy
// is drift waiting to happen, which is the entire reason the package exists (#9515, #9517).
export {
  TOOL_CATEGORIES,
  TOOL_AUTH_LEVELS,
  TOOL_LOCALITIES,
  TOOL_AVAILABILITIES,
  defineTool,
  projectToolDefinition,
  projectToolDefinitions,
  toJsonSchema,
  type ToolCategory,
  type ToolAuthLevel,
  type ToolLocality,
  type ToolAvailability,
  type ToolAnnotations,
  type ToolContract,
  type ToolFilter,
  type JsonSchemaLike,
  type McpToolDefinition,
} from "./tool-definition.js";

export * from "./enums.js";
export * from "./telemetry.js";
export { PREFLIGHT_LIMITS, PREDICT_GATE_MAX_CHANGED_PATHS, PREDICT_GATE_MAX_CHANGED_PATH_CHARS, WRITE_TOOL_LIMITS, SCENARIO_LIMITS } from "./limits.js";
// #9750: the bounds the Worker's request schemas apply, restated here and pinned against their originals
// by test/unit/contract-api-requests.test.ts.
export {
  MAX_FOCUS_MANIFEST_BYTES,
  MAX_LOCAL_SCORER_WARNING_CHARS,
  MAX_LOCAL_SCORER_WARNING_COUNT,
  MAX_NOTIFICATION_DELIVERY_ID_LENGTH,
  MAX_NOTIFICATION_MARK_READ_IDS,
  PUBLIC_SURFACE_SKIP_REASONS,
  SCENARIO_MAX_BRANCH_REF_CHARS,
  SCENARIO_MAX_LINKED_ISSUE_NUMBERS,
  SCENARIO_MAX_REPO_FULL_NAME_CHARS,
} from "./limits.js";
export { ownerRepoInput, ownerRepoPullInput, freshnessFields, toolErrorFields } from "./shared.js";
export { TOOL_CONTRACTS, listToolDefinitions, getToolContract } from "./tools/index.js";
export {
  AGENT_TOOLS_INDEX_SCHEMA_VERSION,
  buildOpenAIToolSpecs,
  buildAnthropicToolSpecs,
  buildAgentToolsIndex,
  type OpenAIToolSpec,
  type AnthropicToolSpec,
  type AgentToolsIndex,
} from "./agent-specs.js";
