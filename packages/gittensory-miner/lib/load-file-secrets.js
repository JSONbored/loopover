// `<NAME>_FILE` secrets-file indirection for the miner CLI (#5178). Ports src/selfhost/load-file-secrets.ts's
// Docker/Swarm/K8s-secret-mount pattern into the miner package so an operator can supply GITHUB_TOKEN as a
// mounted secret file (e.g. /run/secrets/github_token) instead of a plaintext env var visible via
// `docker inspect` on any host running the miner.
//
// Two deliberate divergences from the server port, both required by #5178:
//  1. TARGETED allowlist, not a blanket "resolve every *_FILE" scan. The server sweeps every `*_FILE` in the
//     environment; here only the miner's own credential env vars are eligible, so an unrelated non-secret
//     `*_FILE` (e.g. `SSL_CERT_FILE`) is never read and can never fail-fast the CLI. GITHUB_TOKEN is the ONLY
//     entry today: the coding-agent providers (claude-cli/codex-cli/agent-sdk) are all locally-authenticated
//     and read no API-key env var of their own (see CODING_AGENT_DRIVER_NAMES in
//     packages/gittensory-engine/src/miner/driver-factory.ts), so there is no provider key to indirect. The
//     allowlist is the single, obvious extension point if that ever changes.
//  2. FAIL-FAST, not log-and-continue. The server logs `selfhost_secret_file_unreadable` and keeps booting;
//     here a missing/unreadable/empty `<NAME>_FILE` throws a clear error naming the variable and path, because
//     a credential silently resolving to empty would surface far downstream as a confusing GitHub auth failure
//     with no hint that the real cause was an unmountable secret.
//
// The thrown error carries only the variable name and the file path (operator-supplied config, not a secret) --
// never the file contents -- so it is always safe to print. Precedence mirrors the server: an explicit plain
// `<NAME>` always wins over `<NAME>_FILE`, and when the plain value is already set the file is never read (so a
// stale/unreadable `<NAME>_FILE` is harmless as long as the operator also passed the plain value). Mutates
// `env` in place so it is called once at startup, before any command reads a credential.

import { readFileSync } from "node:fs";

/** The miner's credential env vars eligible for `<NAME>_FILE` indirection. See the header for why GITHUB_TOKEN
 *  is the only member today. */
export const MINER_FILE_SECRET_VARS = Object.freeze(["GITHUB_TOKEN"]);

/**
 * Resolve `<NAME>_FILE` secret-file indirection for the miner's credential env vars, in place on `env`. For each
 * eligible `<NAME>`: if `<NAME>_FILE` is set and the plain `<NAME>` is not, the file is read, trimmed, and used
 * as the effective value. An explicit plain `<NAME>` wins and short-circuits the read. A set-but-missing/
 * unreadable/empty `<NAME>_FILE` throws (fail-fast, #5178) naming the variable and path -- never the value.
 *
 * @param {Record<string, string | undefined>} [env] defaults to `process.env`.
 * @param {{ readFile?: (path: string) => string, vars?: readonly string[] }} [options]
 *   `readFile` is an injectable reader (defaults to `readFileSync(path, "utf8")`); `vars` is an injectable
 *   allowlist (defaults to {@link MINER_FILE_SECRET_VARS}). Both exist purely for testability -- every real
 *   caller uses the defaults, so this is byte-identical to a hardcoded version at runtime.
 * @returns {void}
 */
export function loadMinerFileSecrets(env = process.env, options = {}) {
  const readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
  const vars = options.vars ?? MINER_FILE_SECRET_VARS;
  for (const name of vars) {
    const fileVar = `${name}_FILE`;
    const filePath = env[fileVar];
    if (!filePath) continue; // no `_FILE` companion set -> nothing to resolve for this credential
    if (env[name]) continue; // an explicit plain value wins; never read (or fail on) the file in that case
    let contents;
    try {
      contents = readFile(filePath);
    } catch (cause) {
      throw new Error(`miner_secret_file_unreadable:${fileVar}:${filePath}`, { cause });
    }
    const value = contents.trim();
    if (!value) throw new Error(`miner_secret_file_empty:${fileVar}:${filePath}`);
    env[name] = value;
  }
}
