// Workers-safe registry for the fleet-mode (DB-backed) subscription credential lookup (#9543), mirroring
// src/mcp/redeploy-companion-registry.ts's nullable-slot pattern exactly: this module holds a single
// nullable function slot and imports nothing environment-specific, so it is safe anywhere in the bundle.
//
// Only the self-host Node entry (server.ts) fills the slot, with a closure over `env` built from
// src/db/repositories.ts's getDecryptedProviderCredential -- src/selfhost/ai.ts must never import the DB
// layer directly. The AI provider chain is deliberately env-driven (createSelfHostAi takes a plain env
// record and has no DB access of its own); threading the credential in through a registry keeps that
// separation intact, the same way the per-repo BYOK key is threaded in by the queue processors rather
// than resolved inside the provider factory.
//
// Unset (cloud, a self-host box with no rotated credential stored, or TOKEN_ENCRYPTION_SECRET absent)
// means the slot stays null and ai.ts falls through to the secret-file / boot-env rungs below it.

/** Providers whose credential can be rotated at runtime. Codex is listed for the DB envelope's sake even
 *  though its fleet path is host-side only -- see rotateSecret's doc comment in redeploy-companion.ts. */
export type RotatableProvider = "claude-code" | "codex";

/** Returns the stored plaintext credential for `provider`, or null when none is stored / it cannot be
 *  decrypted. Must never throw: a lookup failure degrades to the next resolution rung, it does not fail
 *  the review. */
export type ProviderCredentialResolver = (provider: RotatableProvider) => Promise<string | null>;

let resolveProviderCredential: ProviderCredentialResolver | null = null;

export function setProviderCredentialResolver(resolver: ProviderCredentialResolver | null): void {
  resolveProviderCredential = resolver;
}

export function getProviderCredentialResolver(): ProviderCredentialResolver | null {
  return resolveProviderCredential;
}
