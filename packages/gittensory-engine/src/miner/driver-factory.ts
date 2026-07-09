// CodingAgentDriver factory + provider-style config resolution (#4289). Mirrors `src/selfhost/ai-config.ts:41-74`:
// parse a comma-separated provider list, validate each name against what is actually configured, deny-by-default
// on unknown/unconfigured names, and expose a model/effort config map analogous to `SELF_HOST_REVIEWER_MODEL_ENV`.

import {
  createFakeCodingAgentDriver,
  createNoopCodingAgentDriver,
  type CodingAgentDriver,
} from "./coding-agent-driver.js";
import {
  invokeCodingAgentDriver,
  type AttemptLogSink,
} from "./coding-agent-invoke.js";
import {
  resolveCodingAgentModeFromConfig,
  type CodingAgentExecutionMode,
} from "./coding-agent-mode.js";
import type { CodingAgentDriverResult, CodingAgentDriverTask } from "./coding-agent-driver.js";

/** Provider names the factory knows how to resolve today. Concrete CLI/SDK drivers land in #4266/#4267. */
export const CODING_AGENT_DRIVER_NAMES = Object.freeze(["noop"] as const);

export type CodingAgentDriverName = (typeof CODING_AGENT_DRIVER_NAMES)[number];

/** Per-provider env keys for coding-agent configuration (mirrors `SELF_HOST_REVIEWER_MODEL_ENV`). */
export const CODING_AGENT_DRIVER_CONFIG_ENV: Readonly<Record<CodingAgentDriverName, { model?: string; maxTurns?: string }>> =
  Object.freeze({
    noop: {},
  });

function parseDriverNames(env: Record<string, string | undefined>): string[] {
  return (env.MINER_CODING_AGENT_PROVIDER ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** True when `name` is a known, configured coding-agent driver. Unknown names → false (deny-by-default). */
export function isConfiguredCodingAgentDriver(
  name: string,
  _env: Record<string, string | undefined>,
): boolean {
  switch (name) {
    case "noop":
      return true;
    default:
      return false;
  }
}

export function resolveConfiguredCodingAgentDriverNames(
  env: Record<string, string | undefined>,
): string[] {
  return parseDriverNames(env).filter((name) => isConfiguredCodingAgentDriver(name, env));
}

export type CreateCodingAgentDriverOptions = {
  providerName: string;
  env?: Record<string, string | undefined> | undefined;
  /** Test seam — inject a fake driver instead of constructing the named provider. */
  driver?: CodingAgentDriver | undefined;
};

/** Resolve a concrete driver for `providerName`. Throws on unknown/unconfigured providers (fail-closed). */
export function createCodingAgentDriver(options: CreateCodingAgentDriverOptions): CodingAgentDriver {
  if (options.driver) return options.driver;
  const name = options.providerName.trim().toLowerCase();
  const env = options.env ?? {};
  if (!isConfiguredCodingAgentDriver(name, env)) {
    throw new Error(`unconfigured_coding_agent_driver:${name}`);
  }
  switch (name) {
    case "noop":
      return createNoopCodingAgentDriver();
    default:
      throw new Error(`unconfigured_coding_agent_driver:${name}`);
  }
}

export type RunCodingAgentAttemptOptions = {
  providerName: string;
  env?: Record<string, string | undefined> | undefined;
  agentPaused?: boolean | null | undefined;
  agentDryRun?: boolean | null | undefined;
  task: CodingAgentDriverTask;
  log?: AttemptLogSink | undefined;
  driver?: CodingAgentDriver | undefined;
};

/** End-to-end entry: resolve mode from config, pick the driver, invoke under mode gating + attempt log. */
export async function runCodingAgentAttempt(
  options: RunCodingAgentAttemptOptions,
): Promise<{ mode: CodingAgentExecutionMode; result: CodingAgentDriverResult }> {
  const mode = resolveCodingAgentModeFromConfig({
    env: options.env,
    agentPaused: options.agentPaused,
    agentDryRun: options.agentDryRun,
  });
  const driver = createCodingAgentDriver({
    providerName: options.providerName,
    env: options.env,
    driver: options.driver,
  });
  const result = await invokeCodingAgentDriver(driver, mode, options.task, options.log);
  return { mode, result };
}

/** Exported for parity tests — wraps a driver without changing its behavior (identity helper). */
export function createFakeCodingAgentDriverForFactory(): CodingAgentDriver {
  return createFakeCodingAgentDriver();
}
