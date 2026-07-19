export type WizardIo = {
    promptText(question: string): Promise<string>;
    promptMasked(question: string): Promise<string>;
    writeLine(text: string): void;
    close?: () => void;
    /** Whether this `io`'s underlying input is a real, interactive terminal. Optional -- a fake test `io` that
     *  omits it is treated as interactive (matching every pre-#6846 test's existing behavior); `createWizardIo`'s
     *  real adapter always sets it from the actual stream's `isTTY`. */
    isInteractive?: boolean;
};
export type RunInteractiveInitOptions = {
    /** DI override for the device-flow's outbound fetch calls (tests never touch the real network). */
    fetchImpl?: typeof fetch;
    /** DI override for the device-flow poll loop's sleep between requests (tests never wait on a real timer). */
    sleepFn?: (ms: number) => Promise<void>;
};
/** Where the wizard writes its starter .env file: the miner state dir, the same directory `init` already uses
 *  for laptop-state.sqlite3. */
export declare function resolveWizardEnvFilePath(env?: Record<string, string | undefined>): string;
/** Render collected `[KEY, value]` pairs as sourceable `KEY=value` lines, one per entry, insertion order. Pure
 *  and filesystem-free so it is directly testable. */
export declare function renderWizardEnvFile(entries: ReadonlyArray<readonly [string, string]>): string;
/**
 * Menu selection sourced from the engine's own `CODING_AGENT_DRIVER_NAMES`, so the choices can never drift from
 * what the driver factory actually resolves. Empty input SKIPS provider selection entirely (leaves
 * MINER_CODING_AGENT_PROVIDER unwritten, deferring to whatever default the CLI already resolves) -- distinct
 * from explicitly choosing the `noop` entry.
 */
export declare function promptProviderSelection(io: WizardIo): Promise<string | null>;
/**
 * Optional, skippable per-provider companion vars (model override / timeout), sourced from the same
 * `CODING_AGENT_DRIVER_CONFIG_ENV` map the real driver factory reads -- never a hand-duplicated var-name list
 * that could drift. Empty input skips that one var; its built-in default (if any) applies at run time as usual.
 */
export declare function promptCompanionVars(io: WizardIo, provider: string): Promise<Array<[string, string]>>;
/**
 * Run the interactive onboarding wizard end to end: collect GITHUB_TOKEN (pasted, or via device-flow
 * authorization when configured -- see collectGithubToken) + optional provider config, write the starter .env,
 * initialize laptop state, then rerun the existing offline doctor checks against the collected values. Returns
 * doctor's exit code. `io` is injected so tests never touch a real terminal; `options.fetchImpl`/`sleepFn` are
 * injected so tests never make a real network call or wait on a real timer during device-flow polling.
 */
export declare function runInteractiveInit(env: Record<string, string | undefined>, cwd: string, io: WizardIo, options?: RunInteractiveInitOptions): Promise<number>;
/**
 * Real terminal I/O for the wizard. Masked input is implemented by overriding readline's own output-write hook
 * to render `*` instead of the typed prompt's characters while the interface is still doing its normal
 * cooked-mode line editing (Enter/Backspace all still work exactly as with a plain prompt) -- no raw-mode byte
 * handling and no extra dependency. `input`/`output` are parameters (defaulting to the real stdio) purely so
 * tests can drive the exact same code path with fake streams instead of a real terminal.
 */
export declare function createWizardIo(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): WizardIo & {
    close: () => void;
    isInteractive: boolean;
};
