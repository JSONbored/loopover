/** Shared CLI failure output (#4836): when `--json` is set, emit a parseable `{ ok: false, error }` object on
 *  stdout (matching each command's success-path JSON stream); otherwise log plain text to stderr. */

/**
 * @param {boolean} wantsJson
 * @param {string} message
 * @param {number} [exitCode]
 * @returns {number}
 */
export function reportCliFailure(wantsJson, message, exitCode = 2) {
  if (wantsJson) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(message);
  }
  return exitCode;
}

/** True when argv includes `--json` (used on parse-error paths before a full parse result exists). */
export function argsWantJson(args) {
  return args.includes("--json");
}

/** Normalize a thrown value to a safe error string for CLI output. */
export function describeCliError(error) {
  return error instanceof Error ? error.message : String(error);
}
