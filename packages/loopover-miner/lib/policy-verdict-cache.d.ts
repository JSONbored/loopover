import type { AiPolicyVerdict } from "@loopover/engine";

export type PolicyVerdictDecisiveDoc = "AI-USAGE.md" | "CONTRIBUTING.md";

export type PolicyVerdictCacheEntry = {
  decisiveDoc: PolicyVerdictDecisiveDoc;
  etag: string;
  verdict: AiPolicyVerdict;
};

export type PolicyVerdictCacheWrite = PolicyVerdictCacheEntry & {
  repoScope: string;
  updatedAt: string;
};

export type PolicyVerdictCacheStore = {
  dbPath: string;
  /** `repoScope` must uniquely identify a tenant forge host + repo (see `policyVerdictCacheKey` in
   *  opportunity-fanout.js) -- a bare `owner/repo` is not safe across multiple forge hosts. */
  get(repoScope: string): PolicyVerdictCacheEntry | null;
  put(
    repoScope: string,
    decisiveDoc: PolicyVerdictDecisiveDoc,
    etag: string,
    verdict: AiPolicyVerdict,
  ): PolicyVerdictCacheWrite;
  /** Explicit, operator-invoked right-to-be-forgotten purge (#5564, #6987) -- deletes every tenant's cached
   *  verdict for `repoFullName` (matched on repo_scope's `::repoFullName` suffix, since repo_scope is a
   *  composite `${apiBaseUrl}::${repoFullName}` key, not a bare repoFullName). Returns the row count deleted. */
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

/** The read/write surface opportunity-fanout.js needs to inject a cache without depending on the SQLite store. */
export type PolicyVerdictCache = Pick<PolicyVerdictCacheStore, "get" | "put">;

export function resolvePolicyVerdictCacheDbPath(env?: Record<string, string | undefined>): string;

export function initPolicyVerdictCacheStore(dbPath?: string): PolicyVerdictCacheStore;
