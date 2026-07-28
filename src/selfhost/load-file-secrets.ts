// Resolve `<NAME>_FILE` env vars (Docker secrets / multi-line keys) into `<NAME>` at self-host startup.
// Extracted from server.ts (#4403) so this has a real test harness -- server.ts itself boots the whole
// app on import and is Codecov-ignored, so it has no runtime test coverage of its own.
//
// A missing or unreadable `<NAME>_FILE` fails the container fast (throws), matching the miner package's
// `loadMinerFileSecrets` behavior documented in packages/loopover-miner/DEPLOYMENT.md — rather than
// silently leaving the target env var unset and proceeding without the credential (#6284).
import { readFileSync } from "node:fs";

// Docker Compose's OWN reserved `_FILE`-suffixed environment variables -- never loopover's secret-file
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
): string[] {
  // The names materialised from a file here, returned so server.ts can hand them to
  // setFileSourcedSecrets() -- the only durable record of "this value came from a file, not from
  // inline .env", which call-time re-reads depend on to preserve inline precedence (#9543).
  const fileSourced: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.endsWith("_FILE") || !env[key] || COMPOSE_RESERVED_FILE_VARS.has(key)) continue;
    const target = key.slice(0, -"_FILE".length);
    if (env[target]) continue; // an explicit value wins
    const path = env[key] as string;
    let value: string;
    try {
      value = readFile(path).trim();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_secret_file_unreadable",
          var: key,
        }),
      );
      throw new Error(
        `Failed to read secret file for ${key} (${path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // #9487: an EMPTY (zero-byte or whitespace-only) secret file is as fatal as a missing one. Setting
    // `env[target] = ""` looks like a successful load, but every downstream `nonBlank()` reads "" as
    // UNCONFIGURED and preflight.ts deliberately skips absent values -- so a truncated
    // GITHUB_WEBHOOK_SECRET file booted an instance that silently rejected every webhook. Directly adjacent
    // to the known secret-rotation footgun on edge-nl-01, where a file is rewritten in place: the window in
    // which it is momentarily empty is exactly when a container restart reads it.
    //
    // Checked OUTSIDE the try above on purpose: throwing inside it would be caught by that catch and
    // re-reported as "unreadable", collapsing two genuinely different operator problems (a bad path/permission
    // vs a truncated write) into one misleading message and the wrong log event.
    if (value === "") {
      console.error(
        JSON.stringify({
          level: "error",
          event: "selfhost_secret_file_empty",
          var: key,
        }),
      );
      throw new Error(`Secret file for ${key} (${path}) is empty; an empty secret silently reads as unconfigured downstream. Write the value, or unset ${key}.`);
    }
    env[target] = value;
    fileSourced.push(target);
  }
  return fileSourced;
}
