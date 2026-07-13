// Qdrant-backed Vectorize adapter for self-host RAG (#1217). Implements the same Cloudflare
// `Vectorize` surface (upsert / query / deleteByIds) as the SQLite and pgvector adapters but
// backed by a standalone Qdrant REST API. Qdrant provides ANN search, payload filtering by
// namespace, and scales to millions of vectors — making it the recommended vector store for
// production self-host deployments. Enable with QDRANT_URL=http://qdrant:6333 and --profile qdrant.
//
// Qdrant requires UUID or uint64 point IDs. String IDs (e.g. "owner/repo:file:line") are
// mapped to UUIDs via a deterministic SHA-1 hash, with the original ID stored in the payload
// for retrieval. The collection is auto-created at startup via initQdrantCollection().
//
// Set QDRANT_API_KEY for deployments that require Bearer token authentication (cloud Qdrant,
// production on-prem). Omit for unauthenticated local/dev deployments.
//
// VectorRecord/QueryOptions/Match are the shared backend-contracts.ts types (#4010) also used by
// vectorize.ts and pg-vectorize.ts -- see vectorize.ts's own header comment for why QueryOptions'
// `returnMetadata` field belongs here too (this backend receives it identically to the other two through
// the same reviewVectorAdapter call path; it just doesn't branch on it, same as the other two). `adapter` is
// typed `SelfHostVectorize` before the final `as unknown as Vectorize` cast (unavoidable: Vectorize is a
// `declare abstract class`, so only that cast can bridge a plain object to it).
import { createHash } from "node:crypto";
import { incr } from "./metrics";
import type {
  SelfHostVectorRecord as VectorRecord,
  SelfHostVectorizeQueryOptions as QueryOptions,
  SelfHostVectorizeMatch as Match,
  SelfHostVectorize,
} from "./backend-contracts";

const DEFAULT_COLLECTION = "gittensory";
const DEFAULT_DIM = 1024; // bge-m3 / mxbai-embed-large (1024-d); set QDRANT_DIM to override

interface QdrantSearchResult {
  result: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
}
interface QdrantCollectionInfo {
  result: { config: { params: { vectors: { size: number } } } };
}

/** Maps an arbitrary string ID to a UUID that Qdrant accepts as a point ID. Deterministic. */
function idToUuid(id: string): string {
  const h = createHash("sha1").update(id).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Build fetch headers, including Bearer auth when QDRANT_API_KEY is set. */
function qdrantHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (process.env.QDRANT_API_KEY) h["api-key"] = process.env.QDRANT_API_KEY;
  return h;
}

/** Build the unauthenticated Kubernetes-style readiness endpoint for a configured Qdrant base URL. */
export function qdrantReadyzUrl(url: string): string {
  return `${url.replace(/\/+$/, "")}/readyz`;
}

export function qdrantDimensionFromEnv(value: string | undefined): number {
  const dim = Number(value);
  return Number.isFinite(dim) && dim > 0 ? Math.floor(dim) : DEFAULT_DIM;
}

/**
 * Ensures the Qdrant collection exists. Safe to call on every startup — a 409 (already exists)
 * verifies the existing collection width. Call this before createQdrantVectorize() when QDRANT_URL is set.
 */
export async function initQdrantCollection(
  url: string,
  collection = DEFAULT_COLLECTION,
  dim = qdrantDimensionFromEnv(process.env.QDRANT_DIM),
): Promise<void> {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}/collections/${collection}`, {
    method: "PUT",
    headers: qdrantHeaders(),
    body: JSON.stringify({ vectors: { size: dim, distance: "Cosine" } }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Qdrant collection init failed: HTTP ${res.status}`);
  }
  if (res.status === 409) {
    const existing = await fetch(`${base}/collections/${collection}`, { headers: qdrantHeaders() });
    if (!existing.ok) throw new Error(`Qdrant collection lookup failed: HTTP ${existing.status}`);
    const info = (await existing.json()) as QdrantCollectionInfo;
    const existingDim = info.result.config.params.vectors.size;
    if (existingDim !== dim) {
      throw new Error(`Qdrant collection dimension mismatch: existing ${existingDim}, configured ${dim}`);
    }
  }
}

/** Creates a Vectorize-compatible adapter backed by the Qdrant REST API at `url`. */
export function createQdrantVectorize(url: string, collection = DEFAULT_COLLECTION): Vectorize {
  const base = url.replace(/\/+$/, "");

  const adapter: SelfHostVectorize = {
    async upsert(vectors: VectorRecord[]): Promise<{ count: number; ids: string[] }> {
      const points = vectors.map((v) => ({
        id: idToUuid(v.id),
        vector: v.values,
        payload: { _orig_id: v.id, namespace: v.namespace ?? "", ...v.metadata },
      }));
      const res = await fetch(`${base}/collections/${collection}/points`, {
        method: "PUT",
        headers: qdrantHeaders(),
        body: JSON.stringify({ points }),
      });
      if (!res.ok) {
        incr("loopover_qdrant_errors_total", { op: "upsert" });
        throw new Error(`Qdrant upsert failed: HTTP ${res.status}`);
      }
      incr("loopover_qdrant_upserts_total", {}, vectors.length);
      return { count: vectors.length, ids: vectors.map((v) => v.id) };
    },

    async query(vector: number[], opts: QueryOptions): Promise<{ matches: Match[] }> {
      const body: Record<string, unknown> = { vector, limit: opts.topK ?? 12, with_payload: true };
      if (opts.namespace) {
        body.filter = { must: [{ key: "namespace", match: { value: opts.namespace } }] };
      }
      let res: Response;
      try {
        res = await fetch(`${base}/collections/${collection}/points/search`, {
          method: "POST",
          headers: qdrantHeaders(),
          body: JSON.stringify(body),
        });
      } catch {
        // Qdrant unreachable — degrade gracefully (RAG returns no context rather than crashing)
        incr("loopover_qdrant_errors_total", { op: "query" });
        return { matches: [] };
      }
      if (!res.ok) {
        incr("loopover_qdrant_errors_total", { op: "query" });
        return { matches: [] };
      }
      incr("loopover_qdrant_queries_total");
      const data = (await res.json()) as QdrantSearchResult;
      const matches: Match[] = data.result.map((r) => {
        const { _orig_id, namespace: _ns, ...rest } = r.payload;
        const id = typeof _orig_id === "string" ? _orig_id : r.id;
        return Object.keys(rest).length > 0 ? { id, score: r.score, metadata: rest } : { id, score: r.score };
      });
      return { matches };
    },

    async deleteByIds(ids: string[]): Promise<{ count: number }> {
      if (ids.length === 0) return { count: 0 };
      const points = ids.map(idToUuid);
      const res = await fetch(`${base}/collections/${collection}/points/delete`, {
        method: "POST",
        headers: qdrantHeaders(),
        body: JSON.stringify({ points }),
      });
      if (!res.ok) {
        incr("loopover_qdrant_errors_total", { op: "delete" });
        throw new Error(`Qdrant deleteByIds failed: HTTP ${res.status}`);
      }
      return { count: ids.length };
    },
  };

  return adapter as unknown as Vectorize;
}
