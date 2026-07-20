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
export function resolveLogLevel({ level, quiet = false, verbose = false, envLevel, } = {}) {
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
        // noUncheckedIndexedAccess: in-bounds access is always defined at runtime.
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
export function formatLine({ level, message, fields, pretty, timestamp, }) {
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
        // Cast: public API takes `string`; unknown levels are undefined in LEVEL_RANK, and `undefined <= n` is false.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9nZ2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9nZ2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDBHQUEwRztBQUMxRyx5R0FBeUc7QUFDekcsNkdBQTZHO0FBQzdHLDZHQUE2RztBQUM3Ryx3R0FBd0c7QUFDeEcsRUFBRTtBQUNGLGdIQUFnSDtBQUNoSCwrR0FBK0c7QUFDL0csOEdBQThHO0FBQzlHLGtGQUFrRjtBQUlsRixtRkFBbUY7QUFDbkYsTUFBTSxDQUFDLE1BQU0sVUFBVSxHQUF3QixDQUFDLFFBQVEsRUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsQ0FBQztBQUU1RixtRkFBbUY7QUFDbkYsTUFBTSxDQUFDLE1BQU0saUJBQWlCLEdBQWEsTUFBTSxDQUFDO0FBRWxELDRHQUE0RztBQUM1RyxNQUFNLFVBQVUsR0FBNkIsRUFBRSxNQUFNLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsSUFBSSxFQUFFLENBQUMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFDLEVBQUUsQ0FBQztBQUVqRyxNQUFNLFlBQVksR0FBRyxHQUFXLEVBQUUsQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO0FBNEI1RDs0RUFDNEU7QUFDNUUsTUFBTSxVQUFVLFVBQVUsQ0FBQyxLQUFjO0lBQ3ZDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsS0FBSyxDQUFDLENBQUM7QUFDOUYsQ0FBQztBQUVEOzs7OztHQUtHO0FBQ0gsTUFBTSxVQUFVLGVBQWUsQ0FBQyxFQUM5QixLQUFLLEVBQ0wsS0FBSyxHQUFHLEtBQUssRUFDYixPQUFPLEdBQUcsS0FBSyxFQUNmLFFBQVEsTUFNTixFQUFFO0lBQ0osSUFBSSxVQUFVLENBQUMsS0FBSyxDQUFDO1FBQUUs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