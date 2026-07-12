import { readFileSync } from "node:fs";

// The credentials the miner resolves from a `<NAME>_FILE` companion in fleet mode: the GitHub token plus the
// coding-agent provider credentials (selected at runtime by `MINER_CODING_AGENT_PROVIDER`). ONLY these are
// ever read from a file — an allowlist, deliberately NOT a generic sweep of every `*_FILE` env var, so an
// unrelated OS/Docker variable (e.g. `GIO_LAUNCHED_DESKTOP_FILE`, `COMPOSE_FILE`) is never dereferenced and a
// stray one can never crash the CLI. Extend this list if a new provider credential is added.
const CREDENTIAL_VARS = ["GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

/**
 * Resolve `<NAME>_FILE` secret-file indirection into `<NAME>` for fleet mode, so credentials like
 * `GITHUB_TOKEN` and the coding-agent credentials can be supplied via a Docker/Swarm/K8s secret mount
 * (e.g. `-e GITHUB_TOKEN_FILE=/run/secrets/github_token`) instead of a plaintext env var, which is visible
 * to anyone who can run `docker inspect` on the host. Mirrors ORB's `src/selfhost/load-file-secrets.ts`, with
 * two deliberate miner-side differences: it resolves only the known credential allowlist above (not every
 * `*_FILE` var), and an unreadable `_FILE` path is a HARD ERROR (deliverable #5) rather than a silent
 * log-and-continue — we never start with an empty/undefined credential the operator believes they supplied.
 *
 * Precedence: an explicitly-set plain `<NAME>` ALWAYS wins over `<NAME>_FILE` — a PRESENCE check, so even an
 * explicit but empty plain value is honored rather than silently overridden by the file. The resolved secret
 * VALUE is never logged or returned — it is only written into `env` in place.
 *
 * @param {Record<string, string | undefined>} [env] Injectable for tests; defaults to `process.env`.
 * @param {(path: string) => string} [readFile] Injectable for tests; defaults to `readFileSync(path, "utf8")`.
 * @returns {void}
 */
export function loadFileCredentials(env = process.env, readFile = (path) => readFileSync(path, "utf8")) {
  for (const target of CREDENTIAL_VARS) {
    const fileKey = `${target}_FILE`;
    if (!env[fileKey]) continue; // no file indirection requested for this credential
    // Presence, not truthiness: an explicitly-set plain value (even empty) wins over the file.
    if (Object.prototype.hasOwnProperty.call(env, target)) continue;
    let contents;
    try {
      contents = readFile(env[fileKey]);
    } catch (cause) {
      throw new Error(
        `Secret file for ${fileKey} is unreadable (${env[fileKey]}); refusing to start with an empty ${target}.`,
        { cause },
      );
    }
    env[target] = contents.trim();
  }
}
