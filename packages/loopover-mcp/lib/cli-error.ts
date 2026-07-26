/** Shared CLI failure output (#5928): when `--json` is set, emit a parseable `{ ok: false, error }` object on
 *  stdout (matching each command's success-path JSON stream); otherwise log plain text to stderr. */

export function reportCliFailure(wantsJson: boolean, message: string, exitCode = 2): number {
  if (wantsJson) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(message);
  }
  return exitCode;
}

/** True when argv includes `--json` or `--json=...` (used before a full parse result exists).
 *  `--json=false` explicitly DISABLES JSON output (#8689), so it must not count as wanting JSON. */
export function argsWantJson(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--json" || (arg?.startsWith("--json=") && arg !== "--json=false"));
}

/** Normalize a thrown value to a safe error string for CLI output. */
export function describeCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
