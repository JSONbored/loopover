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
/** Supported log levels, least to most verbose. `silent` suppresses everything. */
export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"];
/** The level used when nothing (flag, env var, or explicit option) selects one. */
export const DEFAULT_LOG_LEVEL = "info";
// Numeric severity rank per level (higher = more verbose). A method emits when its rank <= the active rank.
const LEVEL_RANK = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const defaultClock = () => new Date().toISOString();
/** True when `value` names a supported log level. Non-string input is never a level (so an absent option or a
 *  typo'd env var falls through to the next signal instead of throwing). */
export function isLogLevel(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(LEVEL_RANK, value);
}
/**
 * Resolve the active level from the available signals, most explicit first: an explicit `level` wins, then
 * `--quiet` (→ `error`), then `--verbose` (→ `debug`), then the env-provided level, else the default. `quiet`
 * beats `verbose` when both are set, so the safer/quieter choice wins a contradictory invocation. An
 * unrecognized `level`/`envLevel` is ignored rather than throwing — a typo logs at the default, never crashes.
 */
export function resolveLogLevel({ level, quiet = false, verbose = false, envLevel } = {}) {
    if (isLogLevel(level))
        return level;
    if (quiet)
        return "error";
    if (verbose)
        return "debug";
    if (isLogLevel(envLevel))
        return envLevel;
    return DEFAULT_LOG_LEVEL;
}
/**
 * Split the global logging flags out of a CLI argv slice, returning the parsed options plus `rest` — the argv
 * with those flags (and any `--log-level` value) removed so downstream command parsing never sees them.
 * Recognizes `--quiet`, `--verbose`, `--log-level <level>`, and `--log-level=<level>`. No short aliases: `-v`
 * is already `--version` and `-h` is `--help` in the CLI entrypoint.
 */
export function extractLogOptions(argv) {
    let quiet = false;
    let verbose = false;
    let level;
    const rest = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
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
function formatFieldValue(value) {
    // Quote a string only when it contains whitespace (so it stays one token); serialize everything else as JSON.
    if (typeof value === "string")
        return /\s/.test(value) ? JSON.stringify(value) : value;
    return JSON.stringify(value);
}
/**
 * Render structured fields as a stable, sorted ` key=value` suffix (sorted so output is deterministic across
 * runs). `undefined` values are dropped; an empty/absent field set yields an empty string.
 */
export function formatFields(fields) {
    if (!fields)
        return "";
    const parts = [];
    for (const key of Object.keys(fields).sort()) {
        const value = fields[key];
        if (value === undefined)
            continue;
        parts.push(`${key}=${formatFieldValue(value)}`);
    }
    return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
/**
 * Format one log line. Plain mode (the default) is just `message` + any field suffix, keeping human CLI output
 * identical to a bare `console.log`. Pretty mode prefixes an optional timestamp and the uppercased level tag,
 * for operators who want machine-scannable diagnostics.
 */
export function formatLine({ level, message, fields, pretty, timestamp }) {
    const suffix = formatFields(fields);
    if (!pretty)
        return `${message}${suffix}`;
    const stamp = timestamp ? `[${timestamp}] ` : "";
    return `${stamp}${level.toUpperCase()} ${message}${suffix}`;
}
/**
 * Build a level-aware logger. All I/O is injectable for tests: `streams` (defaults to process stdout/stderr),
 * `now` (defaults to an ISO-8601 clock, only consulted in `pretty` mode), and `env` (defaults to process.env,
 * read for `LOOPOVER_MINER_LOG_LEVEL`). `fields` seeds every line with contextual fields; `child(extra)`
 * returns a logger that merges additional fields onto this one.
 */
export function createLogger(options = {}) {
    const { level, quiet, verbose, pretty = false, fields: baseFields, env = process.env, streams, now } = options;
    const stdout = streams?.stdout ?? process.stdout;
    const stderr = streams?.stderr ?? process.stderr;
    const clock = now ?? defaultClock;
    const envLevel = env.LOOPOVER_MINER_LOG_LEVEL ?? "";
    const activeLevel = resolveLogLevel({ level, quiet, verbose, envLevel });
    const threshold = LEVEL_RANK[activeLevel];
    function emit(methodLevel, stream, message, fields) {
        if (LEVEL_RANK[methodLevel] > threshold)
            return;
        const merged = baseFields || fields ? { ...baseFields, ...fields } : undefined;
        const timestamp = pretty ? clock() : undefined;
        stream.write(`${formatLine({ level: methodLevel, message, fields: merged, pretty, timestamp })}\n`);
    }
    return {
        level: activeLevel,
        isLevelEnabled: (methodLevel) => LEVEL_RANK[methodLevel] <= threshold,
        error: (message, fields) => emit("error", stderr, message, fields),
        warn: (message, fields) => emit("warn", stderr, message, fields),
        info: (message, fields) => emit("info", stdout, message, fields),
        debug: (message, fields) => emit("debug", stdout, message, fields),
        child: (childFields) => createLogger({ ...options, fields: { ...baseFields, ...childFields } }),
    };
}
// Process-wide logger. The CLI entrypoint calls `configureLogger` once from the parsed global flags/env so every
// command shares one configured instance via `getLogger`; until then this default-level instance is used.
let processLogger = createLogger();
/** Reconfigure the process-wide logger from resolved startup options and return it. */
export function configureLogger(options) {
    processLogger = createLogger(options);
    return processLogger;
}
/** The process-wide logger configured by `configureLogger` (a default-level logger before then). */
export function getLogger() {
    return processLogger;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9nZ2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9nZ2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDBHQUEwRztBQUMxRyx5R0FBeUc7QUFDekcsNkdBQTZHO0FBQzdHLDZHQUE2RztBQUM3Ryx3R0FBd0c7QUFDeEcsRUFBRTtBQUNGLGdIQUFnSDtBQUNoSCwrR0FBK0c7QUFDL0csOEdBQThHO0FBQzlHLGtGQUFrRjtBQUlsRixtRkFBbUY7QUFDbkYsTUFBTSxDQUFDLE1BQU0sVUFBVSxHQUF3QixDQUFDLFFBQVEsRUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsQ0FBQztBQUU1RixtRkFBbUY7QUFDbkYsTUFBTSxDQUFDLE1BQU0saUJBQWlCLEdBQWEsTUFBTSxDQUFDO0FBRWxELDRHQUE0RztBQUM1RyxNQUFNLFVBQVUsR0FBNkIsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsSUFBSSxFQUFFLENBQUMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsQ0FBQztBQUVqRyxNQUFNLFlBQVksR0FBRyxHQUFXLEVBQUUsQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO0FBNEI1RDs0RUFDNEU7QUFDNUUsTUFBTSxVQUFVLFVBQVUsQ0FBQyxLQUFjO0lBQ3ZDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFDOUYsQ0FBQztBQUVEOzs7OztHQUtHO0FBQ0gsTUFBTSxVQUFVLGVBQWUsQ0FBQyxFQUFFLEtBQUssRUFBRSxLQUFLLEdBQUcsS0FBSyxFQUFFLE9BQU8sR0FBRyxLQUFLLEVBQUUsUUFBUSxLQUs3RSxFQUFFO0lBQ0osSUFBSSxVQUFVLENBQUMsS0FBSyxDQUFDO1FBQUUs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