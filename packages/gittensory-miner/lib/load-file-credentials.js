import { readFileSync } from "node:fs";

// Docker Compose's OWN reserved `_FILE`-suffixed variables -- never a gittensory secret-file. `COMPOSE_FILE`
// is a colon-delimited list of compose paths (readFileSync always throws on it) and `COMPOSE_ENV_FILE` points
// at an operator's .env, not a secret. Excluding both by name means we never dereference them (mirrors ORB's
// src/selfhost/load-file-secrets.ts, added in #4403). A real operator secret is never named exactly one of these.
const COMPOSE_RESERVED_FILE_VARS = new Set(["COMPOSE_FILE", "COMPOSE_ENV_FILE"]);

/**
 * Resolve `<NAME>_FILE` secret-file indirection into `<NAME>` for fleet mode, so credentials like
 * `GITHUB_TOKEN` and the coding-agent credentials can be supplied via a Docker/Swarm/K8s secret mount
 * (e.g. `-e GITHUB_TOKEN_FILE=/run/secrets/github_token`) instead of a plaintext env var, which is visible
 * to anyone who can run `docker inspect` on the host. Mirrors ORB's `src/selfhost/load-file-secrets.ts`, with
 * one deliberate difference for the miner: an unreadable `_FILE` path is a HARD ERROR (deliverable #5) rather
 * than a silent log-and-continue -- we never start with an empty/undefined credential the operator believes
 * they supplied.
 *
 * Precedence: an explicit plain `<NAME>` ALWAYS wins over `<NAME>_FILE` (documented, never a silent pick).
 * The resolved secret VALUE is never logged or returned -- it is only written into `env` in place.
 *
 * @param {Record<string, string | undefined>} [env] Injectable for tests; defaults to `process.env`.
 * @param {(path: string) => string} [readFile] Injectable for tests; defaults to `readFileSync(path, "utf8")`.
 * @returns {void}
 */
export function loadFileCredentials(env = process.env, readFile = (path) => readFileSync(path, "utf8")) {
  // `Object.keys` snapshots the key list upfront, so mutating `env[target]` inside the loop is safe (a newly
  // set target is never re-visited as a key) -- do NOT switch this to `for...in`, which would see it live.
  for (const key of Object.keys(env)) {
    if (!key.endsWith("_FILE") || !env[key] || COMPOSE_RESERVED_FILE_VARS.has(key)) continue;
    const target = key.slice(0, -"_FILE".length);
    // Presence, not truthiness: an explicitly-set plain `<NAME>` ALWAYS wins over `<NAME>_FILE`, including an
    // explicit empty string (`GITHUB_TOKEN=""`) -- honoring the documented contract rather than silently
    // treating an empty explicit value as unset and reading the file over it.
    if (Object.prototype.hasOwnProperty.call(env, target)) continue;
    let contents;
    try {
      contents = readFile(env[key]);
    } catch (cause) {
      throw new Error(
        `Secret file for ${key} is unreadable (${env[key]}); refusing to start with an empty ${target}.`,
        { cause },
      );
    }
    env[target] = contents.trim();
  }
}
