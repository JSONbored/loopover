// Production coding-agent driver construction (#5131, Wave 3.5 follow-up to #2337/#2343). Closes the gap
// coding-agent-house-rules.js's own header names explicitly: "nothing in this package constructs a
// coding-agent driver in production yet ... that is separate, larger follow-up work." This module IS that
// call site -- it provides a real `child_process`-backed spawn (mirroring src/selfhost/ai.ts's `defaultSpawn`,
// simplified to the engine's smaller `CliSubprocessSpawnFn` contract: no `firstOutputTimeoutMs`/`input`, since
// those are reviewer-CLI-specific concerns this driver doesn't share) and resolves + constructs a real
// `CodingAgentDriver` from `MINER_CODING_AGENT_PROVIDER`, with house-rule enforcement (#2343) wired in by
// default via `buildHouseRulesAgentSdkHooks` -- a caller never has to remember to attach it by hand.
import { spawn as nodeSpawn } from "node:child_process";
import { createCodingAgentDriver, resolveFirstConfiguredCodingAgentDriverName, } from "@loopover/engine";
import { buildHouseRulesAgentSdkHooks, } from "./coding-agent-house-rules.js";
/**
 * Real `child_process.spawn`-backed implementation of the engine's `CliSubprocessSpawnFn` contract. Captures
 * stdout/stderr and RESOLVES (never rejects) on timeout or spawn error, so the caller always sees whatever
 * output accumulated rather than an unhandled rejection -- mirrors `src/selfhost/ai.ts`'s `defaultSpawn`'s own
 * resolve-not-reject rationale (a killed/errored subprocess's partial output may hold the real diagnosable
 * error, e.g. an auth failure line on stderr).
 */
export function createRealCliSubprocessSpawn() {
    return (cmd, args, opts) => new Promise((resolve) => {
        // `CliSubprocessSpawnFn` uses `Record<string, string | undefined>` + `readonly string[]`; Node's spawn
        // overloads want `ProcessEnv` + a mutable `string[]`. The cast is local and lossless (same keys/values).
        const child = nodeSpawn(cmd, [...args], {
            cwd: opts.cwd,
            env: opts.env,
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
        child.stdout?.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
            // A spawn-level error (e.g. ENOENT) fires before the child ever produces output, so `stderr` is always
            // "" here in practice; Node guarantees this listener receives a real Error with `.message` (the
            // documented contract for ChildProcess's own "error" event), so no optional chaining/fallback is needed.
            clearTimeout(timer);
            resolve({ stdout, code: null, stderr: err.message });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ stdout, code, stderr });
        });
    });
}
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
export function constructProductionCodingAgentDriver(env, options = {}) {
    const providerName = resolveFirstConfiguredCodingAgentDriverName(env);
    if (!providerName) {
        throw new Error("unconfigured_coding_agent_driver:no_provider_in_MINER_CODING_AGENT_PROVIDER");
    }
    const hooks = options.hooks ??
        (providerName.trim().toLowerCase() === "agent-sdk"
            ? buildHouseRulesAgentSdkHooks(options.houseRulesConfig, options.houseRulesOptions)
            : undefined);
    return createCodingAgentDriver({
        providerName,
        env,
        spawn: options.spawn ?? createRealCliSubprocessSpawn(),
        ...(options.query !== undefined ? { query: options.query } : {}),
        ...(hooks !== undefined ? { hooks } : {}),
        ...(options.listChangedFiles !== undefined ? { listChangedFiles: options.listChangedFiles } : {}),
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29kaW5nLWFnZW50LWNvbnN0cnVjdGlvbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNvZGluZy1hZ2VudC1jb25zdHJ1Y3Rpb24udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEseUdBQXlHO0FBQ3pHLG1HQUFtRztBQUNuRywwR0FBMEc7QUFDMUcsK0dBQStHO0FBQy9HLCtHQUErRztBQUMvRyx1R0FBdUc7QUFDdkcsMEdBQTBHO0FBQzFHLHFHQUFxRztBQUVyRyxPQUFPLEVBQUUsS0FBSyxJQUFJLFNBQVMsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBQ3hELE9BQU8sRUFDTCx1QkFBdUIsRUFDdkIsMkNBQTJDLEdBSzVDLE1BQU0sa0JBQWtCLENBQUM7QUFDMUIsT0FBTyxFQUNMLDRCQUE0QixHQUc3QixNQUFNLCtCQUErQixDQUFDO0FBRXZDOzs7Ozs7R0FNRztBQUNILE1BQU0sVUFBVSw0QkFBNEI7SUFDMUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLEVBQUUsQ0FDekIsSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRTtRQUN0Qix1R0FBdUc7UUFDdkcseUdBQXlHO1FBQ3pHLE1BQU0sS0FBSyxHQUFHLFNBQVMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxFQUFFO1lBQ3RDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRztZQUNiLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBd0I7WUFDbEMsS0FBSyxFQUFFLENBQUMsUUFBUSxFQUFFLE1BQU0sRUFBRSxNQUFNLENBQUM7U0FDbEMsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxNQUFNLEdBQUcsRUFBRSxDQUFDO1FBQ2hCLElBQUksTUFBTSxHQUFHLEVBQUUsQ0FBQztRQUNoQix1R0FBdUc7UUFDdkcsMkdBQTJHO1FBQzNHLDBHQUEwRztRQUMxRywyR0FBMkc7UUFDM0csMkdBQTJHO1FBQzNHLGtFQUFrRTtRQUNsRSxNQUFNLEtBQUss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