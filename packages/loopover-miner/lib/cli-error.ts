/** Shared CLI failure output (#4836): when `--json` is set, emit a parseable `{ ok: false, error }` object on
 *  stdout (matching each command's success-path JSON stream); otherwise log plain text to stderr. */

export function reportCliFailure(wantsJson: boolean, message: string, exitCode = 2): number {
  if (wantsJson) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(message);
  }
  return exitCode;
}

/** True when argv includes `--json` (used on parse-error paths before a full parse result exists). */
export function argsWantJson(args: readonly string[]): boolean {
  return args.includes("--json");
}

/** Normalize a thrown value to a safe error string for CLI output. */
export function describeCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
