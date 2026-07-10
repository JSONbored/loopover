// Resolve `<NAME>_FILE` env vars (Docker secrets / multi-line keys) into `<NAME>` at self-host startup.
// Extracted from server.ts (#4403) so this has a real test harness -- server.ts itself boots the whole
// app on import and is Codecov-ignored, so it has no runtime test coverage of its own.
import { readFileSync } from "node:fs";

// Docker Compose's OWN reserved `_FILE`-suffixed environment variables -- never gittensory's secret-file
// convention, so they must never be dereferenced below. `COMPOSE_FILE` is a colon-delimited list of
// compose file paths (never a single readable file itself, so readFileSync always throws), and
// `COMPOSE_ENV_FILE` (less commonly set, but equally reserved by Compose) points at an operator's custom
// .env file, not a secret. Excluding both by name is the fix (#4403) -- a real operator secret is never
// named exactly one of these.
const COMPOSE_RESERVED_FILE_VARS = new Set(["COMPOSE_FILE", "COMPOSE_ENV_FILE"]);

/** `env` and `readFile` are injectable purely for testability -- every real caller uses the defaults
 *  (`process.env`, `node:fs`'s `readFileSync`), so this is byte-identical to a hardcoded version at
 *  runtime while letting tests pass a plain object and a mock reader instead of mutating global state. */
export function loadFileSecrets(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): void {
  for (const key of Object.keys(env)) {
    if (!key.endsWith("_FILE") || !env[key] || COMPOSE_RESERVED_FILE_VARS.has(key)) continue;
    const target = key.slice(0, -"_FILE".length);
    if (env[target]) continue; // an explicit value wins
    try {
      env[target] = readFile(env[key] as string).trim();
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_secret_file_unreadable",
          var: key,
        }),
      );
    }
  }
}
