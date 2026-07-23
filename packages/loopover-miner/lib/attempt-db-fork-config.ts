import type { AttemptDbForkConfig } from "@loopover/engine";

const ENV_KEYS = {
  apiKey: "LOOPOVER_MINER_NEON_API_KEY",
  projectId: "LOOPOVER_MINER_NEON_PROJECT_ID",
  parentBranchId: "LOOPOVER_MINER_NEON_PARENT_BRANCH_ID",
} as const;

/**
 * Resolve the operator's Neon branch-per-attempt fork config (#7858) from env vars -- never from
 * `.loopover-ams.yml`: an API key is a SECRET, and this codebase's own established convention keeps every
 * secret in an env var, never a YAML config file (matching every other credential in this repo --
 * LOOPOVER_API_TOKEN, LOOPOVER_MCP_TOKEN, etc. -- none of which live in a config-as-code file).
 *
 * Requires all three vars set (trimmed, non-blank). Any one missing disables the feature entirely (returns
 * null), so an operator who hasn't configured Neon sees zero behavior change -- no branch is ever created,
 * the fork step in `runAttempt` becomes a complete no-op.
 */
export function resolveAttemptDbForkConfig(env: Record<string, string | undefined> = process.env): AttemptDbForkConfig | null {
  const apiKey = env[ENV_KEYS.apiKey]?.trim();
  const projectId = env[ENV_KEYS.projectId]?.trim();
  const parentBranchId = env[ENV_KEYS.parentBranchId]?.trim();
  if (!apiKey || !projectId || !parentBranchId) return null;
  return { apiKey, projectId, parentBranchId };
}
