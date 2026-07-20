// Resolve `<NAME>_FILE` env vars (Docker/Swarm/K8s secret mounts) into `<NAME>` at miner startup (#5178).
// Ports src/selfhost/load-file-secrets.ts's pattern into the miner package -- the miner is a separate
// deployable (its own process/container per DEPLOYMENT.md's fleet mode), so it never runs through ORB's own
// server-startup resolver. Both modules fail-fast the same way: an unreadable/missing `<NAME>_FILE` here
// THROWS rather than silently proceeding -- the ORB analogue converged onto this same behavior in #6284, so
// the two no longer diverge -- and a broken secret mount fails a miner container fast and loud (never
// proceeds with an unset/empty credential the next real GitHub call would then fail on anyway, with a far
// less specific error).
import { readFileSync } from "node:fs";

// Docker Compose's OWN reserved `_FILE`-suffixed environment variables -- never loopover's secret-file
// convention, so they must never be dereferenced below (mirrors src/selfhost/load-file-secrets.ts's own
// exclusion and rationale: `COMPOSE_FILE` is a colon-delimited list of compose file paths, never a single
// readable file itself, and `COMPOSE_ENV_FILE` points at an operator's own .env file, not a secret).
const COMPOSE_RESERVED_FILE_VARS = new Set(["COMPOSE_FILE", "COMPOSE_ENV_FILE"]);

/**
 * Scan `env` for `<NAME>_FILE` vars and resolve each into `<NAME>` in place, reading the referenced file's
 * contents (trimmed). An explicit `<NAME>` value always wins over `<NAME>_FILE` (mirrors the ORB analogue's
 * precedence rule exactly) -- a `_FILE` var is only consulted when its plain counterpart is unset. Throws a
 * clear, actionable error identifying the offending `<NAME>_FILE` var and its file path when the file is
 * missing or unreadable -- this never silently leaves a credential empty/undefined. Never logs or returns any
 * resolved secret value itself; only the (non-secret) var name and file path ever appear in a thrown message.
 *
 * `env` and `readFile` are injectable purely for testability -- every real caller uses the defaults
 * (`process.env`, `node:fs`'s `readFileSync`), so this is byte-identical to a hardcoded version at runtime.
 */
export function loadMinerFileSecrets(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): void {
  for (const key of Object.keys(env)) {
    if (!key.endsWith("_FILE") || !env[key] || COMPOSE_RESERVED_FILE_VARS.has(key)) continue;
    const target = key.slice(0, -"_FILE".length);
    if (env[target]) continue; // an explicit <NAME> value always wins over <NAME>_FILE
    try {
      env[target] = readFile(env[key]).trim();
    } catch (error) {
      throw new Error(
        `Failed to read secret file for ${key} (${env[key]}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
