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
        const child = nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29kaW5nLWFnZW50LWNvbnN0cnVjdGlvbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNvZGluZy1hZ2VudC1jb25zdHJ1Y3Rpb24udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEseUdBQXlHO0FBQ3pHLG1HQUFtRztBQUNuRywwR0FBMEc7QUFDMUcsK0dBQStHO0FBQy9HLCtHQUErRztBQUMvRyx1R0FBdUc7QUFDdkcsMEdBQTBHO0FBQzFHLHFHQUFxRztBQUVyRyxPQUFPLEVBQUUsS0FBSyxJQUFJLFNBQVMsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBQ3hELE9BQU8sRUFDTCx1QkFBdUIsRUFDdkIsMkNBQTJDLEdBSzVDLE1BQU0sa0JBQWtCLENBQUM7QUFDMUIsT0FBTyxFQUNMLDRCQUE0QixHQUc3QixNQUFNLCtCQUErQixDQUFDO0FBRXZDOzs7Ozs7R0FNRztBQUNILE1BQU0sVUFBVSw0QkFBNEI7SUFDMUMsT0FBTyxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLEVBQUUsQ0FDekIsSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRTtRQUN0QixNQUFNLEtBQUssR0FBRyxTQUFTLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxFQUFFLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxFQUFFLEtBQUssRUFBRSxDQUFDLFFBQVEsRUFBRSxNQUFNLEVBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ3hHLElBQUksTUFBTSxHQUFHLEVBQUUsQ0FBQztRQUNoQixJQUFJLE1BQU0sR0FBRyxFQUFFLENBQUM7UUFDaEIsdUdBQXVHO1FBQ3ZHLDJHQUEyRztRQUMzRywwR0FBMEc7UUFDMUcsMkdBQTJHO1FBQzNHLDJHQUEyRztRQUMzRyxrRUFBa0U7UUFDbEUsTUFBTSxLQUFLLEdBQUcsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUM1QixLQUFLLENBQUMsSUFB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