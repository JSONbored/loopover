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
 * @param {{ level?: string, quiet?: boolean, verbose?: boolean, envLevel?: string }} [signals]
 * @returns {string}
 */
export function resolveLogLevel({ level, quiet = false, verbose = false, envLevel } = {}) {
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
 * @param {string[]} argv
 * @returns {{ options: { quiet: boolean, verbose: boolean, level: string | undefined }, rest: string[] }}
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
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  return JSON.stringify(value);
}

/**
 * Render structured fields as a stable, sorted ` key=value` suffix (sorted so output is deterministic across
 * runs). `undefined` values are dropped; an empty/absent field set yields an empty string.
 * @param {Record<string, unknown> | null | undefined} fields
 * @returns {string}
 */
export function formatFields(fields) {
  if (!fields) return "";
  const parts = [];
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
 * @param {{ level: string, message: string, fields?: Record<string, unknown> | null, pretty?: boolean, timestamp?: string }} line
 * @returns {string}
 */
export function formatLine({ level, message, fields, pretty, timestamp }) {
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
 * @param {import("./logger.js").LoggerOptions} [options]
 * @returns {import("./logger.js").Logger}
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
    if (LEVEL_RANK[methodLevel] > threshold) return;
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
