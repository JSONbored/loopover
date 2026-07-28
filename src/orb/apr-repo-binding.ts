// Trusted server-side APR repo→customer binding lookup for transfer authorization (#9490).
//
// `installationId`, `repoFullName` and `newOwner` are ALL caller-supplied on the transfer route, so without a
// server-side record binding an APR repo to the customer it belongs to, any authorized caller could transfer
// any completed APR repo — including another customer's — to themselves the moment #7664 starts persisting
// completion records. This gate exists NOW, while the route is still inert, precisely so completion landing
// later cannot silently arm an unauthorized-transfer primitive.
//
// Until #7664 persists a binding record, this ALWAYS returns null (fail closed) and
// `requestAprRepoTransfer` rejects on a null binding. A client-supplied binding must never substitute for
// this — same contract, same replace-the-body-keep-the-signature instruction, and the same reasoning as
// ./apr-idea-completion.ts (whose shape this module deliberately mirrors, down to living in its own file so
// the route's trusted lookup is replaceable at the import seam).

export type AprRepoBinding = {
  /** The GitHub login of the customer whose OAuth session created (or owns) this APR repo. */
  customerLogin: string;
  /** The installation the APR repo actually belongs to. */
  installationId: number;
};

export type AprRepoBindingLookup = (env: Env, input: { repoFullName: string }) => Promise<AprRepoBinding | null>;

/**
 * Resolve the tenant binding for an APR repo (#9490). Fail-closed until a persisted record exists: today's
 * body always returns null. Declared return is `AprRepoBinding | null` so a future persisted lookup (and test
 * doubles) can return a real binding; a null always rejects the transfer.
 */
export async function loadAprRepoBinding(_env: Env, _input: { repoFullName: string }): Promise<AprRepoBinding | null> {
  return null;
}
