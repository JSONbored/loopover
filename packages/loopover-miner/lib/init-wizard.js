import { createInterface } from "node:readline";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODING_AGENT_DRIVER_CONFIG_ENV, CODING_AGENT_DRIVER_NAMES } from "@loopover/engine";
import { initLaptopState } from "./laptop-init.js";
import { resolveMinerStateDir, runDoctor } from "./status.js";
import { DeviceFlowError, resolveAmsOauthClientId, runDeviceFlowAuthorization } from "./oauth-device-flow.js";
const COMPANION_VAR_LABELS = {
    model: "model override",
    timeoutMs: "timeout in milliseconds",
};
/** Where the wizard writes its starter .env file: the miner state dir, the same directory `init` already uses
 *  for laptop-state.sqlite3. */
export function resolveWizardEnvFilePath(env = process.env) {
    return join(resolveMinerStateDir(env), ".env");
}
/** Render collected `[KEY, value]` pairs as sourceable `KEY=value` lines, one per entry, insertion order. Pure
 *  and filesystem-free so it is directly testable. */
export function renderWizardEnvFile(entries) {
    if (entries.length === 0)
        return "";
    return `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}
async function promptRequiredMasked(io, question) {
    for (;;) {
        const answer = (await io.promptMasked(question)).trim();
        if (answer)
            return answer;
        io.writeLine("A value is required -- please try again.");
    }
}
async function promptAuthMethod(io) {
    io.writeLine("How would you like to authorize loopover-miner?");
    io.writeLine("  1) Authorize with GitHub (recommended -- no token to copy)");
    io.writeLine("  2) Paste a GitHub token (personal access token)");
    for (;;) {
        const answer = (await io.promptText("Choice [1/2, default 1]: ")).trim();
        if (!answer || answer === "1")
            return "device";
        if (answer === "2")
            return "token";
        io.writeLine("Enter 1 or 2.");
    }
}
/**
 * Collect a GitHub credential for the wizard's starter .env. When LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID isn't
 * configured (today's default, before the loopover-ams App is registered), this is IDENTICAL to the original
 * masked-token-only prompt -- no menu, no behavior change. Once configured, offers device-flow authorization as
 * the default choice, with the original pasted-token path still available (option 2) and as the automatic
 * fallback on any device-flow failure -- never a hard dependency.
 */
async function collectGithubToken(io, env, options) {
    const clientId = resolveAmsOauthClientId(env);
    if (!clientId)
        return promptRequiredMasked(io, "GitHub token (input hidden): ");
    const method = await promptAuthMethod(io);
    if (method === "token")
        return promptRequiredMasked(io, "GitHub token (input hidden): ");
    try {
        const { accessToken } = await runDeviceFlowAuthorization({
            clientId,
            fetchFn: options.fetchImpl,
            sleepFn: options.sleepFn,
            onCode: (code) => {
                io.writeLine("");
                io.writeLine(`To authorize, visit ${code.verificationUri} and enter code: ${code.userCode}`);
                io.writeLine("Waiting for authorization...");
            },
        });
        io.writeLine("Authorized.");
        return accessToken;
    }
    catch (error) {
        const reason = error instanceof DeviceFlowError ? error.code : "device_flow_failed";
        io.writeLine(`Device-flow authorization failed (${reason}) -- falling back to a pasted token.`);
        return promptRequiredMasked(io, "GitHub token (input hidden): ");
    }
}
/**
 * Menu selection sourced from the engine's own `CODING_AGENT_DRIVER_NAMES`, so the choices can never drift from
 * what the driver factory actually resolves. Empty input SKIPS provider selection entirely (leaves
 * MINER_CODING_AGENT_PROVIDER unwritten, deferring to whatever default the CLI already resolves) -- distinct
 * from explicitly choosing the `noop` entry.
 */
export async function promptProviderSelection(io) {
    io.writeLine("Select a coding-agent provider (press Enter to skip and use the default):");
    CODING_AGENT_DRIVER_NAMES.forEach((name, index) => {
        io.writeLine(`  ${index + 1}) ${name}`);
    });
    for (;;) {
        const answer = (await io.promptText(`Provider [1-${CODING_AGENT_DRIVER_NAMES.length}, or Enter to skip]: `)).trim();
        if (!answer)
            return null;
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && index >= 0 && index < CODING_AGENT_DRIVER_NAMES.length) {
            return CODING_AGENT_DRIVER_NAMES[index];
        }
        io.writeLine(`Enter a number from 1 to ${CODING_AGENT_DRIVER_NAMES.length}, or press Enter to skip.`);
    }
}
/**
 * Optional, skippable per-provider companion vars (model override / timeout), sourced from the same
 * `CODING_AGENT_DRIVER_CONFIG_ENV` map the real driver factory reads -- never a hand-duplicated var-name list
 * that could drift. Empty input skips that one var; its built-in default (if any) applies at run time as usual.
 */
export async function promptCompanionVars(io, provider) {
    const varsForProvider = CODING_AGENT_DRIVER_CONFIG_ENV[provider] ?? {};
    const collected = [];
    for (const [kind, envVarName] of Object.entries(varsForProvider)) {
        const label = COMPANION_VAR_LABELS[kind];
        const answer = (await io.promptText(`Optional ${label} for ${provider} (env ${envVarName}) [Enter to skip]: `)).trim();
        if (answer)
            collected.push([envVarName, answer]);
    }
    return collected;
}
/**
 * Run the interactive onboarding wizard end to end: collect GITHUB_TOKEN (pasted, or via device-flow
 * authorization when configured -- see collectGithubToken) + optional provider config, write the starter .env,
 * initialize laptop state, then rerun the existing offline doctor checks against the collected values. Returns
 * doctor's exit code. `io` is injected so tests never touch a real terminal; `options.fetchImpl`/`sleepFn` are
 * injected so tests never make a real network call or wait on a real timer during device-flow polling.
 */
export async function runInteractiveInit(env, cwd, io, options = {}) {
    // #6846: fail fast, not silently forever. `io.isInteractive` is only ever `false` for a real
    // `createWizardIo()` adapter over a non-TTY stdin (a test's fake `io` has no such field and stays
    // interactive by default, so every existing test is unaffected) -- an operator running this over a
    // no-pty SSH session or a CI/fleet script gets clear, actionable guidance instead of a hang on the
    // wizard's first prompt, which can never receive a real line of input.
    if (io.isInteractive === false) {
        io.writeLine("init --interactive requires a real terminal (no TTY detected on stdin).");
        io.writeLine("For an unattended/fleet setup, skip this wizard and set these env vars directly instead:");
        io.writeLine("  - GITHUB_TOKEN (your GitHub credential)");
        io.writeLine("  - MINER_CODING_AGENT_PROVIDER (claude-cli or codex-cli)");
        io.writeLine("  - ANTHROPIC_API_KEY for claude-cli, or OPENAI_API_KEY for codex-cli");
        io.writeLine("Then verify with: loopover-miner doctor");
        return 3;
    }
    const githubToken = await collectGithubToken(io, env, options);
    const provider = await promptProviderSelection(io);
    const entries = [["GITHUB_TOKEN", githubToken]];
    if (provider) {
        entries.push(["MINER_CODING_AGENT_PROVIDER", provider]);
        entries.push(...(await promptCompanionVars(io, provider)));
    }
    const stateDir = resolveMinerStateDir(env);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const envFilePath = resolveWizardEnvFilePath(env);
    // { mode: 0o600 } on writeFileSync applies only when the file is newly created -- an existing file (e.g. from
    // a prior wizard run, or hand-created by the operator with looser permissions) keeps its current mode across
    // a write. The chmodSync below still runs unconditionally so the end state is always 0600 either way; the
    // writeFileSync mode option exists so a BRAND NEW file is never briefly readable at the default umask
    // permissions between being created and being locked down.
    writeFileSync(envFilePath, renderWizardEnvFile(entries), { mode: 0o600 });
    chmodSync(envFilePath, 0o600);
    io.writeLine(`wrote ${envFilePath}`);
    const initResult = initLaptopState(env);
    io.writeLine(`initialized ${initResult.stateDir}`);
    io.writeLine(`sqlite: ${initResult.dbPath}${initResult.created ? "" : " (already existed)"}`);
    const mergedEnv = { ...env };
    for (const [key, value] of entries)
        mergedEnv[key] = value;
    io.writeLine("");
    io.writeLine("Running doctor against the new configuration:");
    return runDoctor([], mergedEnv, cwd);
}
/**
 * Real terminal I/O for the wizard. Masked input is implemented by overriding readline's own output-write hook
 * to render `*` instead of the typed prompt's characters while the interface is still doing its normal
 * cooked-mode line editing (Enter/Backspace all still work exactly as with a plain prompt) -- no raw-mode byte
 * handling and no extra dependency. `input`/`output` are parameters (defaulting to the real stdio) purely so
 * tests can drive the exact same code path with fake streams instead of a real terminal.
 */
export function createWizardIo(input = process.stdin, output = process.stdout) {
    const rl = createInterface({ input, output, terminal: true });
    const originalWriteToOutput = rl._writeToOutput.bind(rl);
    let masking = false;
    rl._writeToOutput = (stringToWrite) => {
        originalWriteToOutput(masking ? "*" : stringToWrite);
    };
    return {
        // #6846: whether `input` is a real, interactive terminal -- `runInteractiveInit` checks this BEFORE
        // issuing its first prompt, so a no-TTY invocation (piped stdin, a plain `ssh host "loopover-miner init
        // --interactive"` with no allocated pty) fails fast with actionable guidance instead of hanging forever
        // on a `readline` prompt that can never receive a real line of input.
        isInteractive: Boolean(input.isTTY),
        promptText(question) {
            return new Promise((resolve) => rl.question(question, resolve));
        },
        promptMasked(question) {
            return new Promise((resolve) => {
                rl.question(question, (answer) => {
                    masking = false;
                    resolve(answer);
                });
                masking = true;
            });
        },
        writeLine(text) {
            output.write(`${text}\n`);
        },
        close() {
            rl.close();
        },
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5pdC13aXphcmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbml0LXdpemFyZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sZUFBZSxDQUFDO0FBRWhELE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxFQUFFLGFBQWEsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUM5RCxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQ2pDLE9BQU8sRUFBRSw4QkFBOEIsRUFBRSx5QkFBeUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBRTdGLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUNuRCxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsU0FBUyxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQzlELE9BQU8sRUFBRSxlQUFlLEVBQUUsdUJBQXVCLEVBQUUsMEJBQTBCLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQXVDOUcsTUFBTSxvQkFBb0IsR0FBMkI7SUFDbkQsS0FBSyxFQUFFLGdCQUFnQjtJQUN2QixTQUFTLEVBQUUseUJBQXlCO0NBQ3JDLENBQUM7QUFFRjtnQ0FDZ0M7QUFDaEMsTUFBTSxVQUFVLHdCQUF3QixDQUFDLE1BQTBDLE9BQU8sQ0FBQyxHQUFHO0lBQzVGLE9BQU8sSUFBSSxDQUFDLG9CQUFvQixDQUFDLEdBQUcsQ0FBQyxFQUFFLE1BQU0sQ0FBQyxDQUFDO0FBQ2pELENBQUM7QUFFRDtzREFDc0Q7QUFDdEQsTUFBTSxVQUFVLG1CQUFtQixDQUFDLE9BQWlEO0lBQ25GLElBQUksT0FBTyxDQUFDLE1BQU0sS0FBSyxDQUFDO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDcEMsT0FBTyxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsRUFBRSxFQUFFLENBQUMsR0FBRyxHQUFHLElBQUksS0FBSyxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztBQUM1RSxDQUFDO0FBRUQsS0FBSyxVQUFVLG9CQUFvQixDQUFDLEVBQVksRUFBRSxRQUFnQjtJQUNoRSxTQUFTLENBQUM7UUFDUixNQUFNLE1BQU0sR0FBRyxDQUFDLE1BQU0sRUFBRSxDQUFDLFlBQVksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3hELElBQUksTUFBTTtZQUFFLE9BQU8sTUFBTSxDQUFDO1FBQzFCLEVBQUUsQ0FBQyxTQUFTLENBQUMsMENBQTBDLENBQUMsQ0FBQztJQUMzRCxDQUFDO0FBQ0gsQ0FBQztBQUVELEtBQUssVUFBVSxnQkFBZ0IsQ0FBQyxFQUFZO0lBQzFDLEVBQUUsQ0FBQyxTQUFTLENBQUMsaURBQWlELENBQUMsQ0FBQztJQUNoRSxFQUFFLENBQUMsU0FBUyxDQUFDLDhEQUE4RCxDQUFDLENBQUM7SUFDN0UsRUFBRSxDQUFDLFNBQVMsQ0FBQyxtREFBbUQsQ0FBQyxDQUFDO0lBQ2xFLFNBQVMsQ0FBQztRQUNSLE1BQU0sTUFBTSxHQUFHLENBQUMsTUFBTSxFQUFFLENBQUMsVUFBVSxDQUFDLDJCQUEyQixDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUN6RSxJQUFJLENBQUMsTUFBTSxJQUFJLE1BQU0sS0FBSyxHQUFHO1lBQUUsT0FBTyxRQUFRLENBQUM7UUFDL0MsSUFBSSxNQUFNLEtBQUssR0FBRztZQUFFLE9BQU8sT0FBTyxDQUFDO1FBQ25DLEVBQUUsQ0FBQyxTQUFTLENBQUMsZUFBZSxDQUFDLENBQUM7SUFDaEMsQ0FBQztBQUNILENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxLQUFLLFVBQVUsa0JBQWtCLENBQy9CLEVBQVksRUFDWixHQUF1QyxFQUN2QyxPQUFrQztJQUVsQyxNQUFNLFFBQVEsR0FBRyx1QkFBdUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUM5QyxJQUFJLENBQUMsUUFBUTtRQUFFLE9BQU8sb0JBQW9CLENBQUMsRUFBRSxFQUFFLCtCQUErQixDQUFDLENBQUM7SUFFaEYsTUFBTSxNQUFNLEdBQUcsTUFBTSxnQkFBZ0IsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUMxQyxJQUFJLE1BQU0sS0FBSyxPQUFPO1FBQUUsT0FBTyxvQkFBb0IsQ0FBQyxFQUFFLEVBQUUsK0JBQStCLENBQUMsQ0FBQztJQUV6RixJQUFJLENBQUM7UUFDSCxNQUFNLEVBQUUsV0FBVyxFQUFFLEdBQUcsTUFBTSwwQkFBMEIsQ0FBQztZQUN2RCxRQUFRO1lBQ1IsT0FBTyxFQUFFLE9BQU8sQ0FBQyxTQUFTO1lBQzFCLE9BQU8sRUFBRSxPQUFPLENBQUMsT0FBTztZQUN4QixNQUFNLEVBQUUsQ0FBQyxJQUFJLEVBQUUsRUFBRTtnQkFDZixFQUFFLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDO2dCQUNqQixFQUFFLENBQUMsU0FBUyxDQUFDLHVCQUF1QixJQUFJLENBQUMsZUFBZSxvQkFBb0IsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7Z0JBQzdGLEVBQUUsQ0FBQyxTQUFTLENBQUMsOEJBQThCLENBQUMsQ0FBQztZQUMvQyxDQUFDO1NBQ2tELENBQUMsQ0FBQztRQUN2RCxFQUFFLENBQUMsU0FBUyxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQzVCLE9BQU8sV0FBVyxDQUFDO0lBQ3JCLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsTUFBTSxNQUFNLEdBQUcsS0FBSyxZQUFZLGVBQWUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsb0JBQW9CLENBQUM7UUFDcEYsRUFBRSxDQUFDLFNBQVMsQ0FBQyxxQ0FBcUMsTUFBTSxzQ0FBc0MsQ0FBQyxDQUFDO1FBQ2hHLE9BQU8sb0JBQW9CLENBQUMsRUFBRSxFQUFFLCtCQUErQixDQUFDLENBQUM7SUFDbkUsQ0FBQztBQUNILENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILE1BQU0sQ0FBQyxLQUFLLFVBQVUsdUJBQXVCLENBQUMsRUFBWTtJQUN4RCxFQUFFLENBQUMsU0FBUyxDQUFDLDJFQUEyRSxDQUFDLENBQUM7SUFDMUYseUJBQXlCLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRSxFQUFFO1FBQ2hELEVBQUUsQ0FBQyxTQUFTLENBQUMsS0FBSyxLQUFLLEdBQUcsQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDLENBQUM7SUFDMUMsQ0FBQyxDQUFDLENBQUM7SUFDSCxTQUFTLENBQUM7UUFDUixNQUFNLE1BQU0sR0FBRyxDQUFDLE1BQU0sRUFBRSxDQUFDLFVBQVUsQ0FBQyxlQUFlLHlCQUF5QixDQUFDLE1BQU0sdUJBQXVCLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3BILElBQUksQ0FBQyxNQUFNO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDekIsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNqQyxJQUFJLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLElBQUksS0FBSyxJQUFJLENBQUMsSUFBSSxLQUFLLEdBQUcseUJBQXlCLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDdEYsT0FBTyx5QkFBeUIsQ0FBQyxLQUFLLENBQUUsQ0FBQztRQUMzQyxDQUFDO1FBQ0QsRUFBRSxDQUFDLFNBQVMsQ0FBQyw0QkFBNEIseUJBQXlCLENBQUMsTUFBTSwyQkFBMkIsQ0FBQyxDQUFDO0lBQ3hHLENBQUM7QUFDSCxDQUFDO0FBRUQ7Ozs7R0FJRztBQUNILE1BQU0sQ0FBQyxLQUFLLFVBQVUsbUJBQW1CLENBQUMsRUFBWSxFQUFFLFFBQWdCO0lBQ3RFLE1BQU0sZUFBZSxHQUFHLDhCQUE4QixDQUFDLFFBQWlDLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDaEcsTUFBTSxTQUFTLEdBQTRCLEVBQUUsQ0FBQztJQUM5QyxLQUFLLE1BQU0sQ0FBQyxJQUFJLEVBQUUsVUFBVSxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxlQUFlLENBQUMsRUFBRSxDQUFDO1FBQ2pFLE1BQU0sS0FBSyxHQUFHLG9CQUFvQixDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3pDLE1BQU0sTUFBTSxHQUFHLENBQUMsTUFBTSxFQUFFLENBQUMsVUFBVSxDQUFDLFlBQVksS0FBSyxRQUFRLFFBQVEsU0FBUyxVQUFVLHFCQUFxQixDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUN2SCxJQUFJLE1BQU07WUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsVUFBVSxFQUFFLE1BQU0sQ0FBQyxDQUFDLENBQUM7SUFDbkQsQ0FBQztJQUNELE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxNQUFNLENBQUMsS0FBSyxVQUFVLGtCQUFrQixDQUN0QyxHQUF1QyxFQUN2QyxHQUFXLEVBQ1gsRUFBWSxFQUNaLFVBQXFDLEVBQUU7SUFFdkMsNkZBQTZGO0lBQzdGLGtHQUFrRztJQUNsRyxtR0FBbUc7SUFDbkcsbUdBQW1HO0lBQ25HLHVFQUF1RTtJQUN2RSxJQUFJLEVBQUUsQ0FBQyxhQUFhLEtBQUssS0FBSyxFQUFFLENBQUM7UUFDL0IsRUFBRSxDQUFDLFNBQVMsQ0FBQyx5RUFBeUUsQ0FBQyxDQUFDO1FBQ3hGLEVBQUUsQ0FBQyxTQUFTLENBQUMsMEZBQTBGLENBQUMsQ0FBQztRQUN6RyxFQUFFLENBQUMsU0FBUyxDQUFDLDJDQUEyQyxDQUFDLENBQUM7UUFDMUQsRUFBRSxDQUFDLFNBQVMsQ0FBQywyREFBMkQsQ0FBQyxDQUFDO1FBQzFFLEVBQUUsQ0FBQyxTQUFTLENBQUMsdUVBQXVFLENBQUMsQ0FBQztRQUN0RixFQUFFLENBQUMsU0FBUyxDQUFDLHlDQUF5QyxDQUFDLENBQUM7UUFDeEQsT0FBTyxDQUFDLENBQUM7SUFDWCxDQUFDO0lBQ0QsTUFBTSxXQUFXLEdBQUcsTUFBTSxrQkFBa0IsQ0FBQyxFQUFFLEVBQUUsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQy9ELE1BQU0sUUFBUSxHQUFHLE1BQU0sdUJBQXVCLENBQUMsRUFBRSxDQUFDLENBQUM7SUFFbkQsTUFBTSxPQUFPLEdBQTRCLENBQUMsQ0FBQyxjQUFjLEVBQUUsV0FBVyxDQUFDLENBQUMsQ0FBQztJQUN6RSxJQUFJLFFBQVEsRUFBRSxDQUFDO1FBQ2IsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLDZCQUE2QixFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUM7UUFDeEQsT0FBTyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsTUFBTSxtQkFBbUIsQ0FBQyxFQUFFLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzdELENBQUM7SUFFRCxNQUFNLFFBQVEsR0FBRyxvQkFBb0IsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUMzQyxTQUFTLENBQUMsUUFBUSxFQUFFLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUN0RCxNQUFNLFdBQVcsR0FBRyx3QkFBd0IsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNsRCw4R0FBOEc7SUFDOUcsNkdBQTZHO0lBQzdHLDBHQUEwRztJQUMxRyxzR0FBc0c7SUFDdEcsMkRBQTJEO0lBQzNELGFBQWEsQ0FBQyxXQUFXLEVBQUUsbUJBQW1CLENBQUMsT0FBTyxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUMxRSxTQUFTLENBQUMsV0FBVyxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQzlCLEVBQUUsQ0FBQyxTQUFTLENBQUMsU0FBUyxXQUFXLEVBQUUsQ0FBQyxDQUFDO0lBRXJDLE1BQU0sVUFBVSxHQUFHLGVBQWUsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUN4QyxFQUFFLENBQUMsU0FBUyxDQUFDLGVBQWUsVUFBVSxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFDbkQsRUFBRSxDQUFDLFNBQVMsQ0FBQyxXQUFXLFVBQVUsQ0FBQyxNQUFNLEdBQUcsVUFBVSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxvQkFBb0IsRUFBRSxDQUFDLENBQUM7SUFFOUYsTUFBTSxTQUFTLEdBQXVDLEVBQUUsR0FBRyxHQUFHLEVBQUUsQ0FBQztJQUNqRSxLQUFLLE1BQU0sQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLElBQUksT0FBTztRQUFFLFNBQVMsQ0FBQyxHQUFHLENBQUMsR0FBRyxLQUFLLENBQUM7SUFFM0QsRUFBRSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUNqQixFQUFFLENBQUMsU0FBUyxDQUFDLCtDQUErQyxDQUFDLENBQUM7SUFDOUQsT0FBTyxTQUFTLENBQUMsRUFBRSxFQUFFLFNBQVMsRUFBRSxHQUFHLENBQUMsQ0FBQztBQUN2QyxDQUFDO0FBRUQ7Ozs7OztHQU1HO0FBQ0gsTUFBTSxVQUFVLGNBQWMsQ0FDNUIsUUFBK0IsT0FBTyxDQUFDLEtBQUssRUFDNUMsU0FBZ0MsT0FBTyxDQUFDLE1BQU07SUFFOUMsTUFBTSxFQUFFLEdBQUcsZUFBZSxDQUFDLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLENBQXFCLENBQUM7SUFDbEYsTUFBTSxxQkFBcUIsR0FBRyxFQUFFLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUN6RCxJQUFJLE9BQU8sR0FBRyxLQUFLLENBQUM7SUFDcEIsRUFBRSxDQUFDLGNBQWMsR0FBRyxDQUFDLGFBQXFCLEVBQUUsRUFBRTtRQUM1QyxxQkFBcUIsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUM7SUFDdkQsQ0FBQyxDQUFDO0lBQ0YsT0FBTztRQUNMLG9HQUFvRztRQUNwRyx3R0FBd0c7UUFDeEcsd0dBQXdHO1FBQ3hHLHNFQUFzRTtRQUN0RSxhQUFhLEVBQUUsT0FBTyxDQUFFLEtBQXVCLENBQUMsS0FBSyxDQUFDO1FBQ3RELFVBQVUsQ0FBQyxRQUFnQjtZQUN6QixPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDO1FBQ2xFLENBQUM7UUFDRCxZQUFZLENBQUMsUUFBZ0I7WUFDM0IsT0FBTyxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFO2dCQUM3QixFQUFFLENBQUMsUUFBUSxDQUFDLFFBQVEsRUFBRSxDQUFDLE1BQU0sRUFBRSxFQUFFO29CQUMvQixPQUFPLEdBQUcsS0FBSyxDQUFDO29CQUNoQixPQUFPLENBQUMsTUFBTSxDQUFDLENBQUM7Z0JBQ2xCLENBQUMsQ0FBQyxDQUFDO2dCQUNILE9BQU8sR0FBRyxJQUFJLENBQUM7WUFDakIsQ0FBQyxDQUFDLENBQUM7UUFDTCxDQUFDO1FBQ0QsU0FBUyxDQUFDLElBQVk7WUFDcEIsTUFBTSxDQUFDLEtBQUssQ0FBQyxHQUFHLElBQUksSUFBSSxDQUFDLENBQUM7UUFDNUIsQ0FBQztRQUNELEtBQUs7WUFDSCxFQUFFLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDYixDQUFDO0tBQ0YsQ0FBQztBQUNKLENBQUMifQ==