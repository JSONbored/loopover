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
export function formatLine(line) {
    const { level, message, fields, pretty, timestamp } = line;
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
        isLevelEnabled: (methodLevel) => {
            const rank = LEVEL_RANK[methodLevel];
            return rank <= threshold;
        },
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9nZ2VyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9nZ2VyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDBHQUEwRztBQUMxRyx5R0FBeUc7QUFDekcsNkdBQTZHO0FBQzdHLDZHQUE2RztBQUM3Ryx3R0FBd0c7QUFDeEcsRUFBRTtBQUNGLGdIQUFnSDtBQUNoSCwrR0FBK0c7QUFDL0csOEdBQThHO0FBQzlHLGtGQUFrRjtBQUVsRixtRkFBbUY7QUFDbkYsTUFBTSxDQUFDLE1BQU0sVUFBVSxHQUFHLENBQUMsUUFBUSxFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBVSxDQUFDO0FBRWhGLG1GQUFtRjtBQUNuRixNQUFNLENBQUMsTUFBTSxpQkFBaUIsR0FBRyxNQUFlLENBQUM7QUFJakQsNEdBQTRHO0FBQzVHLE1BQU0sVUFBVSxHQUE2QixFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxFQUFFLElBQUksRUFBRSxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsRUFBRSxDQUFDO0FBRWpHLE1BQU0sWUFBWSxHQUFHLEdBQVcsRUFBRSxDQUFDLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUM7QUFFNUQ7NEVBQzRFO0FBQzVFLE1BQU0sVUFBVSxVQUFVLENBQUMsS0FBYztJQUN2QyxPQUFPLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsU0FBUyxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLEtBQUssQ0FBQyxDQUFDO0FBQzlGLENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSxlQUFlLENBQzdCLEVBQUUsS0FBSyxFQUFFLEtBQUssR0FBRyxLQUFLLEVBQUUsT0FBTyxHQUFHLEtBQUssRUFBRSxRQUFRLEtBSzdDLEVBQUU7SUFFTixJQUFJLFVBQVUsQ0FBQyxLQUFLLENBQUM7UUFBRSxP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