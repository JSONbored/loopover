// Postgres-backed Vectorize adapter for the self-host Postgres backend (#980 RAG on Postgres). Implements the
// same Cloudflare `Vectorize` surface (upsert / query / deleteByIds) as the SQLite adapter but backed by a
// pgvector extension table. Cosine similarity is computed by pgvector's `<=>` operator (exact ANN, fast for
// repo-scale corpora). Requires `CREATE EXTENSION IF NOT EXISTS vector` — the init() call issues that DDL.
//
// Enable: set DATABASE_URL to a postgres:// URI and use the pgvector/pgvector:pg16 Docker image. The
// buildPostgresBackend path in server.ts calls init() at startup then injects this adapter as env.VECTORIZE.
//
// VectorRecord/QueryOptions/Match are the shared backend-contracts.ts types (#4010) also used by vectorize.ts
// and qdrant-vectorize.ts -- see vectorize.ts's own header comment for why QueryOptions' `returnMetadata`
// field belongs here too (this backend receives it identically to the other two through the same
// reviewVectorAdapter call path; it just doesn't branch on it, same as the other two). `adapter` is typed
// `SelfHostVectorize` before the final `as unknown as Vectorize` cast (unavoidable: Vectorize is a `declare
// abstract class`, so only that cast can bridge a plain object to it).
import type { Pool } from "pg";
import type {
  SelfHostVectorRecord as VectorRecord,
  SelfHostVectorizeQueryOptions as QueryOptions,
  SelfHostVectorizeMatch as Match,
  SelfHostVectorize,
} from "./backend-contracts";

const TABLE = "_selfhost_vectors";

export async function initPgVectorize(pool: Pool): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL DEFAULT '',
      embedding vector,
      metadata JSONB
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_ns ON ${TABLE}(namespace)`);
}

export function createPgVectorize(pool: Pool): Vectorize {
  const adapter: SelfHostVectorize = {
    async upsert(vectors: VectorRecord[]): Promise<{ count: number; ids: string[] }> {
      for (const v of vectors) {
        const embedding = `[${v.values.join(",")}]`;
        await pool.query(
          `INSERT INTO ${TABLE} (id, namespace, embedding, metadata)
           VALUES ($1, $2, $3::vector, $4)
           ON CONFLICT(id) DO UPDATE SET namespace=EXCLUDED.namespace, embedding=EXCLUDED.embedding::vector, metadata=EXCLUDED.metadata`,
          [v.id, v.namespace ?? "", embedding, v.metadata ? JSON.stringify(v.metadata) : null],
        );
      }
      return { count: vectors.length, ids: vectors.map((v) => v.id) };
    },

    async query(vector: number[], opts: QueryOptions): Promise<{ matches: Match[] }> {
      const embedding = `[${vector.join(",")}]`;
      const topK = opts.topK ?? 12;
      const { rows } = opts.namespace
        ? await pool.query<{ id: string; score: number; metadata: Record<string, unknown> | null }>(
            `SELECT id, 1 - (embedding <=> $1::vector) AS score, metadata
             FROM ${TABLE} WHERE namespace=$2
             ORDER BY embedding <=> $1::vector LIMIT $3`,
            [embedding, opts.namespace, topK],
          )
        : await pool.query<{ id: string; score: number; metadata: Record<string, unknown> | null }>(
            `SELECT id, 1 - (embedding <=> $1::vector) AS score, metadata
             FROM ${TABLE}
             ORDER BY embedding <=> $1::vector LIMIT $2`,
            [embedding, topK],
          );
      const matches: Match[] = rows.map((r) =>
        r.metadata !== null ? { id: r.id, score: Number(r.score), metadata: r.metadata } : { id: r.id, score: Number(r.score) },
      );
      return { matches };
    },

    async deleteByIds(ids: string[]): Promise<{ count: number }> {
      if (ids.length === 0) return { count: 0 };
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
      await pool.query(`DELETE FROM ${TABLE} WHERE id IN (${placeholders})`, ids);
      return { count: ids.length };
    },
  };
  return adapter as unknown as Vectorize;
}
