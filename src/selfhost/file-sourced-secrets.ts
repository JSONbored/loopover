// Which env vars `loadFileSecrets()` actually materialised FROM a secret file at boot (#9543).
//
// This exists so a credential can be re-read from its file at call time WITHOUT inverting the precedence
// documented in secrets/README.md ("an inline `.env` value always wins"). docker-compose.yml sets a
// `<NAME>_FILE` default for every secret unconditionally, so the mere presence of `<NAME>_FILE` proves
// nothing about where the live value came from -- an operator using an inline `.env` value has BOTH set,
// and re-reading the file for them would silently swap their credential. Recording the loader's own
// decision at boot is the only signal that distinguishes the two cases after the fact.
//
// Deliberately free of any `node:*` import (unlike load-file-secrets.ts, which statically imports node:fs)
// so the call-time consumer in ai.ts can depend on it without dragging fs into a bundle that must stay
// Workers-safe -- the same reasoning as src/mcp/redeploy-companion-registry.ts's nullable-slot split.

let fileSourced: ReadonlySet<string> = new Set<string>();

/** Record the loader's boot-time result. Called once from server.ts with `loadFileSecrets()`'s return value. */
export function setFileSourcedSecrets(names: Iterable<string>): void {
  fileSourced = new Set(names);
}

/** True when `name`'s live value was materialised from its `<NAME>_FILE` at boot rather than set inline. */
export function wasLoadedFromFile(name: string): boolean {
  return fileSourced.has(name);
}
