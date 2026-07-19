export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
/** Supported log levels, least to most verbose. `silent` suppresses everything. */
export declare const LOG_LEVELS: readonly LogLevel[];
/** The level used when nothing (flag, env var, or explicit option) selects one. */
export declare const DEFAULT_LOG_LEVEL: LogLevel;
export interface LoggerStreams {
    stdout?: {
        write(chunk: string): unknown;
    } | undefined;
    stderr?: {
        write(chunk: string): unknown;
    } | undefined;
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
export declare function isLogLevel(value: unknown): value is LogLevel;
/**
 * Resolve the active level from the available signals, most explicit first: an explicit `level` wins, then
 * `--quiet` (→ `error`), then `--verbose` (→ `debug`), then the env-provided level, else the default. `quiet`
 * beats `verbose` when both are set, so the safer/quieter choice wins a contradictory invocation. An
 * unrecognized `level`/`envLevel` is ignored rather than throwing — a typo logs at the default, never crashes.
 */
export declare function resolveLogLevel({ level, quiet, verbose, envLevel }?: {
    level?: string | undefined;
    quiet?: boolean | undefined;
    verbose?: boolean | undefined;
    envLevel?: string | undefined;
}): LogLevel;
/**
 * Split the global logging flags out of a CLI argv slice, returning the parsed options plus `rest` — the argv
 * with those flags (and any `--log-level` value) removed so downstream command parsing never sees them.
 * Recognizes `--quiet`, `--verbose`, `--log-level <level>`, and `--log-level=<level>`. No short aliases: `-v`
 * is already `--version` and `-h` is `--help` in the CLI entrypoint.
 */
export declare function extractLogOptions(argv: string[]): {
    options: {
        quiet: boolean;
        verbose: boolean;
        level: string | undefined;
    };
    rest: string[];
};
/**
 * Render structured fields as a stable, sorted ` key=value` suffix (sorted so output is deterministic across
 * runs). `undefined` values are dropped; an empty/absent field set yields an empty string.
 */
export declare function formatFields(fields?: Record<string, unknown> | null | undefined): string;
/**
 * Format one log line. Plain mode (the default) is just `message` + any field suffix, keeping human CLI output
 * identical to a bare `console.log`. Pretty mode prefixes an optional timestamp and the uppercased level tag,
 * for operators who want machine-scannable diagnostics.
 */
export declare function formatLine({ level, message, fields, pretty, timestamp }: {
    level: string;
    message: string;
    fields?: Record<string, unknown> | null | undefined;
    pretty?: boolean | undefined;
    timestamp?: string | undefined;
}): string;
/**
 * Build a level-aware logger. All I/O is injectable for tests: `streams` (defaults to process stdout/stderr),
 * `now` (defaults to an ISO-8601 clock, only consulted in `pretty` mode), and `env` (defaults to process.env,
 * read for `LOOPOVER_MINER_LOG_LEVEL`). `fields` seeds every line with contextual fields; `child(extra)`
 * returns a logger that merges additional fields onto this one.
 */
export declare function createLogger(options?: LoggerOptions): Logger;
/** Reconfigure the process-wide logger from resolved startup options and return it. */
export declare function configureLogger(options?: LoggerOptions): Logger;
/** The process-wide logger configured by `configureLogger` (a default-level logger before then). */
export declare function getLogger(): Logger;
