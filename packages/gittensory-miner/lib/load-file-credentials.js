// Resolve `<NAME>_FILE` secret-file indirection for the miner's credential env vars (#5178). Ports the
// self-host pattern in `src/selfhost/load-file-secrets.ts` into gittensory-miner so a fleet operator can mount
// GITHUB_TOKEN and the coding-agent provider credentials as Docker / Swarm / Kubernetes secrets (a file path)
// instead of passing them as plaintext env vars visible via `docker inspect` on any host running the miner.
//
// PRECEDENCE (identical to `src/selfhost/load-file-secrets.ts`): an explicit plain `<NAME>` always WINS over a
// companion `<NAME>_FILE`. When both are set the file is never read and the inline value is kept, so an
// operator can override a mounted secret with an inline value without first removing the mount.
//
// FAIL-CLOSED (the one deliberate divergence from the self-host resolver, which logs-and-continues): a set
// `<NAME>_FILE` whose file is missing, unreadable, or empty THROWS rather than silently leaving the credential
// undefined -- an empty GitHub or coding-agent credential would otherwise send the miner out unauthenticated.
//
// The resolved secret value is NEVER logged or returned: only the resolution SOURCE (`env` vs `file`) is
// emitted, and only the credential NAME and FILE PATH ever appear in a failure message (never the value).
import { readFileSync } from "node:fs";

// Fixed allow-list of the credential env vars the miner resolves `_FILE` indirection for (#5178): the GitHub
// token, plus the coding-agent provider keys documented in `.gittensory-miner.env.example`. It is an explicit
// list -- never a blanket `*_FILE` scan -- so an unrelated `*_FILE` var can never be dereferenced, or made to
// throw, by this resolver.
export const MINER_CREDENTIAL_ENV_VARS = ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

// Emit ONLY the resolution source for a credential -- never its value -- so operators can audit where each
// credential came from without the secret ever reaching a log sink.
function logCredentialSource(name, source) {
  console.error(JSON.stringify({ level: "info", event: "miner_credential_source", var: name, source }));
}

/**
 * Resolve every {@link MINER_CREDENTIAL_ENV_VARS} entry's `<NAME>_FILE` indirection into `<NAME>` on `env`, in
 * place. `env` and `readFile` are injectable purely for testability -- every real caller uses the defaults
 * (`process.env` and `node:fs`'s `readFileSync`), so this is byte-identical to a hardcoded version at runtime.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {(path: string) => string} [readFile]
 * @returns {void}
 */
export function loadMinerFileCredentials(env = process.env, readFile = (path) => readFileSync(path, "utf8")) {
  for (const name of MINER_CREDENTIAL_ENV_VARS) {
    const fileKey = `${name}_FILE`;
    const filePath = env[fileKey];
    if (!filePath) continue; // no `_FILE` companion set for this credential -- nothing to resolve
    if (env[name]) {
      // Both set: the explicit plain value WINS (documented precedence). Record the decision rather than
      // silently discarding the file -- the value itself is never logged.
      logCredentialSource(name, "env");
      continue;
    }
    let value;
    try {
      value = readFile(filePath).trim();
    } catch {
      throw new Error(
        `gittensory_miner_credential_file_unreadable: ${fileKey} points at "${filePath}", which is missing or unreadable`,
      );
    }
    if (!value) {
      throw new Error(
        `gittensory_miner_credential_file_empty: ${fileKey} points at "${filePath}", which resolved to an empty value`,
      );
    }
    env[name] = value;
    logCredentialSource(name, "file");
  }
}
