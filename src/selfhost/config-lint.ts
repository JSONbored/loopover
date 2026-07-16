/**
 * Config-lint shim (#6269). The manifest-linting core now lives in `@loopover/engine`
 * (`packages/loopover-engine/src/config-lint.ts`) so the local (`@loopover/mcp`) MCP server can lint a
 * `.loopover.yml` offline, in-process. This file re-exports the engine surface for the existing `src/`
 * callers unchanged.
 */
export {
  lintManifestText,
  unknownTopLevelWarnings,
  type SelfHostConfigLintResult,
} from "../../packages/loopover-engine/src/config-lint.js";
