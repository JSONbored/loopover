import type { AiPolicyVerdict } from "@jsonbored/gittensory-engine";

export type PolicyVerdictDecisiveDoc = "AI-USAGE.md" | "CONTRIBUTING.md";

export type PolicyVerdictCacheEntry = {
  decisiveDoc: PolicyVerdictDecisiveDoc;
  etag: string;
  verdict: AiPolicyVerdict;
};

export type PolicyVerdictCacheWrite = PolicyVerdictCacheEntry & {
  repoFullName: string;
  updatedAt: string;
};

export type PolicyVerdictCacheStore = {
  dbPath: string;
  get(repoFullName: string): PolicyVerdictCacheEntry | null;
  put(
    repoFullName: string,
    decisiveDoc: PolicyVerdictDecisiveDoc,
    etag: string,
    verdict: AiPolicyVerdict,
  ): PolicyVerdictCacheWrite;
  close(): void;
};

/** The read/write surface opportunity-fanout.js needs to inject a cache without depending on the SQLite store. */
export type PolicyVerdictCache = Pick<PolicyVerdictCacheStore, "get" | "put">;

export function resolvePolicyVerdictCacheDbPath(env?: Record<string, string | undefined>): string;

export function initPolicyVerdictCacheStore(dbPath?: string): PolicyVerdictCacheStore;
