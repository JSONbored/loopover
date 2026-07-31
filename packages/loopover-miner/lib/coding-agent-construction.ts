// Production coding-agent driver construction (#5131, Wave 3.5 follow-up to #2337/#2343). Closes the gap
// coding-agent-house-rules.js's own header names explicitly: "nothing in this package constructs a
// coding-agent driver in production yet ... that is separate, larger follow-up work." This module IS that
// call site -- it provides a real `child_process`-backed spawn (mirroring src/selfhost/ai.ts's `defaultSpawn`,
// simplified to the engine's smaller `CliSubprocessSpawnFn` contract: no `firstOutputTimeoutMs`/`input`, since
// those are reviewer-CLI-specific concerns this driver doesn't share) and resolves + constructs a real
// `CodingAgentDriver` from `MINER_CODING_AGENT_PROVIDER`, with house-rule enforcement (#2343) wired in by
// default via `buildHouseRulesAgentSdkHooks` -- a caller never has to remember to attach it by hand.

import { spawn as nodeSpawn } from "node:child_process";
import {
  CODING_AGENT_DRIVER_CONFIG_ENV,
  createCodingAgentDriver,
  resolveFirstConfiguredCodingAgentDriverName,
  type AgentSdkHooks,
  type AgentSdkQueryFn,
  type CliSubprocessSpawnFn,
  type CodingAgentDriver,
} from "@loopover/engine";
import {
  buildHouseRulesAgentSdkHooks,
  type HouseRulesConfig,
  type HouseRulesOptions,
} from "./coding-agent-house-rules.js";
import { captureMinerPostHogAiGeneration } from "./posthog.js";

/**
 * Real `child_process.spawn`-backed implementation of the engine's `CliSubprocessSpawnFn` contract. Captures
 * stdout/stderr and RESOLVES (never rejects) on timeout or spawn error, so the caller always sees whatever
 * output accumulated rather than an unhandled rejection -- mirrors `src/selfhost/ai.ts`'s `defaultSpawn`'s own
 * resolve-not-reject rationale (a killed/errored subprocess's partial output may hold the real diagnosable
 * error, e.g. an auth failure line on stderr).
 */
export function createRealCliSubprocessSpawn(): CliSubprocessSpawnFn {
  return (cmd, args, opts) =>
    new Promise((resolve) => {
      // `CliSubprocessSpawnFn` uses `Record<string, string | undefined>` + `readonly string[]`; Node's spawn
      // overloads want `ProcessEnv` + a mutable `string[]`. The cast is local and lossless (same keys/values).
      const child = nodeSpawn(cmd, [...args], {
        cwd: opts.cwd,
        env: opts.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      // Unlike src/selfhost/ai.ts's defaultSpawn (a fixed ~120s default, genuinely untestable without a real
      // wait), `opts.timeoutMs` here is always CALLER-supplied per CliSubprocessSpawnFn's contract -- a test can
      // pass a short value against a genuinely long-lived child, so this path is exercised directly rather than
      // v8-ignored. No "already settled" guard is needed: Promise resolution is idempotent (a second `resolve()`
      // is a no-op) and clearing an already-fired timer is a harmless no-op too, so `close`/`error` firing after
      // the timeout already resolved is safe without extra bookkeeping.
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ stdout, code: null, stderr, timedOut: true });
      }, opts.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err: Error) => {
        // A spawn-level error (e.g. ENOENT) fires before the child ever produces output, so `stderr` is always
        // "" here in practice; Node guarantees this listener receives a real Error with `.message` (the
        // documented contract for ChildProcess's own "error" event), so no optional chaining/fallback is needed.
        clearTimeout(timer);
        resolve({ stdout, code: null, stderr: err.message });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, code, stderr });
      });
    });
}

/** Wrap a real `CodingAgentDriver` with PostHog `$ai_generation` capture (#8296 AMS follow-up, epic #8286).
 *  Lives here, not in `@loopover/engine` (the pure driver package cannot depend on `posthog-node` or any
 *  vendor client -- the same "no cross-package import" boundary this file's own header already documents
 *  for its spawn implementation): this is the miner CLI's own host-bound construction site, exactly where
 *  `src/selfhost/`'s equivalent ORB-side wrapper (`withAiGenerationCapture`, ai.ts) lives relative to its
 *  own chain. `CodingAgentDriverResult` carries the blended `costUsd`/`tokensUsed` plus the input/output
 *  split when the provider reported one (#10198); all of it is forwarded verbatim, and a driver that knows
 *  no split simply leaves those fields absent rather than having one fabricated. A driver failure is reported via
 *  `result.ok === false` (the real, observed contract every shipped driver follows -- none of them throw
 *  for an ordinary task failure), with a genuine thrown exception handled defensively on top. */
export function withCodingAgentAiGenerationCapture(providerName: string, model: string, driver: CodingAgentDriver): CodingAgentDriver {
  return {
    async run(task) {
      const startedAtMs = Date.now();
      try {
        const result = await driver.run(task);
        captureMinerPostHogAiGeneration({
          provider: providerName,
          model,
          latencyMs: Date.now() - startedAtMs,
          isError: !result.ok,
          totalTokens: result.tokensUsed,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          totalCostUsd: result.costUsd,
          error: result.ok ? undefined : result.error,
        });
        return result;
      } catch (error) {
        captureMinerPostHogAiGeneration({
          provider: providerName,
          model,
          latencyMs: Date.now() - startedAtMs,
          isError: true,
          error,
        });
        throw error;
      }
    },
  };
}

export type ConstructProductionCodingAgentDriverOptions = {
  spawn?: CliSubprocessSpawnFn;
  query?: AgentSdkQueryFn;
  hooks?: AgentSdkHooks;
  listChangedFiles?: (cwd: string) => Promise<string[]>;
  houseRulesConfig?: HouseRulesConfig;
  houseRulesOptions?: HouseRulesOptions;
};

/**
 * Resolve `MINER_CODING_AGENT_PROVIDER` from `env` and construct a REAL, production `CodingAgentDriver` —
 * house-rule-enforced by default (#2343) via `buildHouseRulesAgentSdkHooks`, matching the same
 * automatic-enforcement guarantee `runHouseRulesEnforcedCodingAgentAttempt` gives task-level callers, but at
 * the raw driver-construction level `attempt-runner.js`'s `deps.driver` actually needs.
 *
 * The default only applies to `agent-sdk`, the one provider with a real hook-registration surface. CLI
 * subprocess providers (`claude-cli`/`codex-cli`) have none, and the engine's `createCliProvider` fails closed
 * if `hooks` is supplied at all (driver-factory.ts) -- filling the default for them here would make every CLI
 * construction throw. An explicitly-supplied `options.hooks` always wins and is forwarded as-is, so a caller
 * that deliberately asks a CLI provider to enforce hooks still gets that same fail-closed rejection.
 *
 * Fails closed (throws) when no provider is configured, or when a CLI provider is selected without a real
 * spawn available — never silently falls back to a driver that can never run.
 */
export function constructProductionCodingAgentDriver(
  env: Record<string, string | undefined>,
  options: ConstructProductionCodingAgentDriverOptions = {},
): CodingAgentDriver {
  const providerName = resolveFirstConfiguredCodingAgentDriverName(env);
  if (!providerName) {
    throw new Error("unconfigured_coding_agent_driver:no_provider_in_MINER_CODING_AGENT_PROVIDER");
  }
  const hooks =
    options.hooks ??
    (providerName.trim().toLowerCase() === "agent-sdk"
      ? buildHouseRulesAgentSdkHooks(options.houseRulesConfig, options.houseRulesOptions)
      : undefined);
  const driver = createCodingAgentDriver({
    providerName,
    env,
    spawn: options.spawn ?? createRealCliSubprocessSpawn(),
    ...(options.query !== undefined ? { query: options.query } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    ...(options.listChangedFiles !== undefined ? { listChangedFiles: options.listChangedFiles } : {}),
  });
  // #8296 AMS follow-up: the configured model env var (CODING_AGENT_DRIVER_CONFIG_ENV), when this
  // provider declares one -- agent-sdk declares none (its session uses the account/CLI default), so it
  // falls back to the provider name itself, mirroring ai.ts's own "unconfigured -> falls back to a
  // sensible default" convention.
  const modelEnvKey = CODING_AGENT_DRIVER_CONFIG_ENV[providerName as keyof typeof CODING_AGENT_DRIVER_CONFIG_ENV]?.model;
  const model = (modelEnvKey ? env[modelEnvKey] : undefined) || providerName;
  return withCodingAgentAiGenerationCapture(providerName, model, driver);
}
