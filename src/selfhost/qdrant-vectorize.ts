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
import { createHash } from "node:crypto";
import { incr } from "./metrics";

const DEFAULT_COLLECTION = "gittensory";
const DEFAULT_DIM = 1024; // bge-m3 / mxbai-embed-large (1024-d); set QDRANT_DIM to override

interface VectorRecord {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, unknown>;
}
interface QueryOptions {
  topK?: number;
  namespace?: string;
}
interface Match {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}
interface QdrantSearchResult {
  result: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
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

/**
 * Ensures the Qdrant collection exists. Safe to call on every startup — a 409 (already exists)
 * is silently ignored. Call this before createQdrantVectorize() when QDRANT_URL is set.
 */
export async function initQdrantCollection(url: string, collection = DEFAULT_COLLECTION, dim = DEFAULT_DIM): Promise<void> {
  const base = url.replace(/\/+$/, "");
  const res = await fetch(`${base}/collections/${collection}`, {
    method: "PUT",
    headers: qdrantHeaders(),
    body: JSON.stringify({ vectors: { size: dim, distance: "Cosine" } }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Qdrant collection init failed: HTTP ${res.status}`);
  }
}

/** Creates a Vectorize-compatible adapter backed by the Qdrant REST API at `url`. */
export function createQdrantVectorize(url: string, collection = DEFAULT_COLLECTION): Vectorize {
  const base = url.replace(/\/+$/, "");

  const adapter = {
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
        incr("gittensory_qdrant_errors_total", { op: "upsert" });
        throw new Error(`Qdrant upsert failed: HTTP ${res.status}`);
      }
      incr("gittensory_qdrant_upserts_total", {}, vectors.length);
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
        incr("gittensory_qdrant_errors_total", { op: "query" });
        return { matches: [] };
      }
      if (!res.ok) {
        incr("gittensory_qdrant_errors_total", { op: "query" });
        return { matches: [] };
      }
      incr("gittensory_qdrant_queries_total");
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
        incr("gittensory_qdrant_errors_total", { op: "delete" });
        throw new Error(`Qdrant deleteByIds failed: HTTP ${res.status}`);
      }
      return { count: ids.length };
    },
  };

  return adapter as unknown as Vectorize;
}
