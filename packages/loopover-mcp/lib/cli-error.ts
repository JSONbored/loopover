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

/** True when argv includes `--json` or `--json=...` (used before a full parse result exists). */
export function argsWantJson(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--json" || arg?.startsWith("--json="));
}

/** Normalize a thrown value to a safe error string for CLI output. */
export function describeCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A writable stream's own buffered-byte count, e.g. `process.stdout`/`process.stderr`. */
export type FlushableStream = { readonly writableLength: number };

/** #8606: resolves once every stream has finished writing everything queued on it. POSIX writes to a piped
 *  stdout/stderr (as opposed to a TTY or a file) are asynchronous, so calling `process.exit()` right after a
 *  large write can terminate the process before the OS has actually drained it, truncating what a piped
 *  consumer reads (e.g. the CLI's packaged CHANGELOG.md output, >64KB). Callers should await this immediately
 *  before exiting. `setImmediate` is safe to poll on indefinitely here: it costs nothing while the buffer is
 *  empty (resolves on the first check) and only re-schedules while real bytes are still in flight. */
export function waitForStdioFlush(streams: readonly FlushableStream[]): Promise<void> {
  return new Promise((resolve) => {
    const poll = () => {
      if (streams.some((stream) => stream.writableLength > 0)) setImmediate(poll);
      else resolve();
    };
    poll();
  });
}
