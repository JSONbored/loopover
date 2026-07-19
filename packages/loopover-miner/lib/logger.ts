// Level-aware logging abstraction for the miner CLI (#4835): every CLI file previously reached for ad hoc
// `console.log`/`console.error` with no shared level control, so an operator could neither quiet routine
// chatter nor turn on verbose diagnostics. This module is the one dependency-light logger the CLI configures
// once at startup and every command shares. It is deliberately pure/injectable — `streams`, `now`, and `env`
// are all overridable — so the branchy level/format logic is unit-testable without touching real stdio.
//
// Levels are ordered by severity; a logger at level L emits a method only when the method's severity rank is at
// or below L's rank (so `error` always survives except at `silent`, and `debug` only shows at the most verbose
// setting). `error`/`warn` go to stderr, `info`/`debug` to stdout, matching the existing convention where the
// update-check nudge writes to stderr and normal command output writes to stdout.

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/** Supported log levels, least to most verbose. `silent` suppresses everything. */
export const LOG_LEVELS: readonly LogLevel[] = ["silent", "error", "warn", "info", "debug"];

/** The level used when nothing (flag, env var, or explicit option) selects one. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

// Numeric severity rank per level (higher = more verbose). A method emits when its rank <= the active rank.
const LEVEL_RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const defaultClock = (): string => new Date().toISOString();

export interface LoggerStreams {
  stdout?: { write(chunk: string): unknown } | undefined;
  stderr?: { write(chunk: string): unknown } | undefined;
}

export interface LoggerOptions {
  level?: string | undefined;
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
  pretty?: boolean | undefined;
  fields?: Record<string, unknown> | undefined;
  env?: Record<string, string | undefined> | undefined;
  streams?: LoggerStreams | undefined;
  now?: (() => string) | undefined;
}

export interface Logger {
  level: LogLevel;
  isLevelEnabled(level: string): boolean;
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** True when `value` names a supported log level. Non-string input is never a level (so an absent option or a
 *  typo'd env var falls through to the next signal instead of throwing). */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LEVEL_RANK, value);
}

/**
 * Resolve the active level from the available signals, most explicit first: an explicit `level` wins, then
 * `--quiet` (→ `error`), then `--verbose` (→ `debug`), then the env-provided level, else the default. `quiet`
 * beats `verbose` when both are set, so the safer/quieter choice wins a contradictory invocation. An
 * unrecognized `level`/`envLevel` is ignored rather than throwing — a typo logs at the default, never crashes.
 */
export function resolveLogLevel({ level, quiet = false, verbose = false, envLevel }: {
  level?: string | undefined;
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
  envLevel?: string | undefined;
} = {}): LogLevel {
  if (isLogLevel(level)) return level;
  if (quiet) return "error";
  if (verbose) return "debug";
  if (isLogLevel(envLevel)) return envLevel;
  return DEFAULT_LOG_LEVEL;
}

/**
 * Split the global logging flags out of a CLI argv slice, returning the parsed options plus `rest` — the argv
 * with those flags (and any `--log-level` value) removed so downstream command parsing never sees them.
 * Recognizes `--quiet`, `--verbose`, `--log-level <level>`, and `--log-level=<level>`. No short aliases: `-v`
 * is already `--version` and `-h` is `--help` in the CLI entrypoint.
 */
export function extractLogOptions(argv: string[]): {
  options: { quiet: boolean; verbose: boolean; level: string | undefined };
  rest: string[];
} {
  let quiet = false;
  let verbose = false;
  let level: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--quiet") {
      quiet = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--log-level") {
      level = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--log-level=")) {
      level = arg.slice("--log-level=".length);
      continue;
    }
    rest.push(arg);
  }
  return { options: { quiet, verbose, level }, rest };
}

function formatFieldValue(value: unknown): string {
  // Quote a string only when it contains whitespace (so it stays one token); serialize everything else as JSON.
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  return JSON.stringify(value);
}

/**
 * Render structured fields as a stable, sorted ` key=value` suffix (sorted so output is deterministic across
 * runs). `undefined` values are dropped; an empty/absent field set yields an empty string.
 */
export function formatFields(fields?: Record<string, unknown> | null | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (value === undefined) continue;
    parts.push(`${key}=${formatFieldValue(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * Format one log line. Plain mode (the default) is just `message` + any field suffix, keeping human CLI output
 * identical to a bare `console.log`. Pretty mode prefixes an optional timestamp and the uppercased level tag,
 * for operators who want machine-scannable diagnostics.
 */
export function formatLine({ level, message, fields, pretty, timestamp }: {
  level: string;
  message: string;
  fields?: Record<string, unknown> | null | undefined;
  pretty?: boolean | undefined;
  timestamp?: string | undefined;
}): string {
  const suffix = formatFields(fields);
  if (!pretty) return `${message}${suffix}`;
  const stamp = timestamp ? `[${timestamp}] ` : "";
  return `${stamp}${level.toUpperCase()} ${message}${suffix}`;
}

/**
 * Build a level-aware logger. All I/O is injectable for tests: `streams` (defaults to process stdout/stderr),
 * `now` (defaults to an ISO-8601 clock, only consulted in `pretty` mode), and `env` (defaults to process.env,
 * read for `LOOPOVER_MINER_LOG_LEVEL`). `fields` seeds every line with contextual fields; `child(extra)`
 * returns a logger that merges additional fields onto this one.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const { level, quiet, verbose, pretty = false, fields: baseFields, env = process.env, streams, now } = options;
  const stdout: { write(chunk: string): unknown } = streams?.stdout ?? process.stdout;
  const stderr: { write(chunk: string): unknown } = streams?.stderr ?? process.stderr;
  const clock = now ?? defaultClock;
  const envLevel = env.LOOPOVER_MINER_LOG_LEVEL ?? "";
  const activeLevel = resolveLogLevel({ level, quiet, verbose, envLevel });
  const threshold = LEVEL_RANK[activeLevel];

  function emit(methodLevel: LogLevel, stream: { write(chunk: string): unknown }, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[methodLevel] > threshold) return;
    const merged = baseFields || fields ? { ...baseFields, ...fields } : undefined;
    const timestamp = pretty ? clock() : undefined;
    stream.write(`${formatLine({ level: methodLevel, message, fields: merged, pretty, timestamp })}\n`);
  }

  return {
    level: activeLevel,
    isLevelEnabled: (methodLevel: string): boolean => LEVEL_RANK[methodLevel as LogLevel] <= threshold,
    error: (message: string, fields?: Record<string, unknown>) => emit("error", stderr, message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => emit("warn", stderr, message, fields),
    info: (message: string, fields?: Record<string, unknown>) => emit("info", stdout, message, fields),
    debug: (message: string, fields?: Record<string, unknown>) => emit("debug", stdout, message, fields),
    child: (childFields: Record<string, unknown>) => createLogger({ ...options, fields: { ...baseFields, ...childFields } }),
  };
}

// Process-wide logger. The CLI entrypoint calls `configureLogger` once from the parsed global flags/env so every
// command shares one configured instance via `getLogger`; until then this default-level instance is used.
let processLogger = createLogger();

/** Reconfigure the process-wide logger from resolved startup options and return it. */
export function configureLogger(options?: LoggerOptions): Logger {
  processLogger = createLogger(options);
  return processLogger;
}

/** The process-wide logger configured by `configureLogger` (a default-level logger before then). */
export function getLogger(): Logger {
  return processLogger;
}
