export type LaptopInitResult = {
  stateDir: string;
  dbPath: string;
  created: boolean;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type InteractiveInitPrompt = {
  askQuestion(question: string, defaultValue?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  askChoice(
    question: string,
    choices: ReadonlyArray<{ value: string; label: string }>,
    defaultIndex?: number,
  ): Promise<string>;
};

export type RunInitOptions = {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  cwd?: string;
  interactivePrompt?: InteractiveInitPrompt;
  runDoctor?: (
    args: string[],
    env: Record<string, string | undefined>,
    cwd: string,
  ) => Promise<number> | number;
};

export type GithubTokenVerification = {
  ok: boolean;
  login: string | null;
  scopes: string[];
  detail: string;
};

export function resolveLaptopStateDbPath(
  env?: Record<string, string | undefined>,
): string;

export function resolveLaptopInitEnvFilePath(
  env?: Record<string, string | undefined>,
): string;

export function createInteractiveInitPrompt(
  io?: {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
  },
): InteractiveInitPrompt;

export function initLaptopState(
  env?: Record<string, string | undefined>,
): LaptopInitResult;

export function checkLaptopStateSqlite(
  env?: Record<string, string | undefined>,
): DoctorCheck;

export function findExecutableOnPath(
  name: string,
  env?: Record<string, string | undefined>,
): string | null;

export function checkDockerPresent(options?: {
  env?: Record<string, string | undefined>;
  resolveDockerPath?: () => string | null;
}): DoctorCheck;

export function checkClaudeCliPresent(options?: {
  env?: Record<string, string | undefined>;
  resolveClaudePath?: () => string | null;
}): DoctorCheck;

export function checkCodexCliPresent(options?: {
  env?: Record<string, string | undefined>;
  resolveCodexPath?: () => string | null;
  resolveCodexAuthPath?: () => string;
}): DoctorCheck;

export function verifyGithubToken(options?: {
  githubToken?: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  timeoutMs?: number;
}): Promise<GithubTokenVerification>;

export function runInit(
  args?: string[],
  env?: Record<string, string | undefined>,
  options?: RunInitOptions,
): Promise<number>;
