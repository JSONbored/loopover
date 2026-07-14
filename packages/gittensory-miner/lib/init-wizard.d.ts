export type WizardIo = {
  promptText(question: string): Promise<string>;
  promptMasked(question: string): Promise<string>;
  writeLine(text: string): void;
  close?: () => void;
};

export type RunInteractiveInitOptions = {
  /** DI override for the device-flow's outbound fetch calls (tests never touch the real network). */
  fetchImpl?: typeof fetch;
  /** DI override for the device-flow poll loop's sleep between requests (tests never wait on a real timer). */
  sleepFn?: (ms: number) => Promise<void>;
};

export function resolveWizardEnvFilePath(env?: Record<string, string | undefined>): string;

export function renderWizardEnvFile(entries: ReadonlyArray<readonly [string, string]>): string;

export function promptProviderSelection(io: WizardIo): Promise<string | null>;

export function promptCompanionVars(io: WizardIo, provider: string): Promise<Array<[string, string]>>;

export function runInteractiveInit(
  env: Record<string, string | undefined>,
  cwd: string,
  io: WizardIo,
  options?: RunInteractiveInitOptions,
): Promise<number>;

export function createWizardIo(
  input?: NodeJS.ReadableStream,
  output?: NodeJS.WritableStream,
): WizardIo & { close: () => void };
