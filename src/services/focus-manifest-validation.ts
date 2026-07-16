/**
 * Focus-manifest validation shim (#6269). The validation result builder now lives in `@loopover/engine`
 * (`packages/loopover-engine/src/focus-manifest-validation.ts`) so the local (`@loopover/mcp`) MCP server's
 * `loopover_validate_config` can compute the result in-process/offline. This file re-exports the engine
 * surface for the existing `src/` callers (`src/api/routes.ts`, `src/mcp/server.ts`) unchanged.
 */
export {
  buildFocusManifestValidation,
  type FocusManifestValidationResult,
  type FocusManifestValidationStatus,
} from "../../packages/loopover-engine/src/focus-manifest-validation.js";
