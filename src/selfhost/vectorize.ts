// SQLite-backed Vectorize adapter for self-host RAG (#979). Implements the Cloudflare `Vectorize` binding
// surface (upsert / query / deleteByIds) that gittensory's RAG (reviewVectorAdapter) wraps, backed by a
// SQLite table with brute-force cosine similarity. For a repo's worth of chunks (hundreds–few-thousand
// vectors per namespace) this is fast enough; namespaces (one per repo) keep each query's candidate set
// small. Embeddings come from the OpenAI-compatible AI adapter's /embeddings path (e.g. Ollama bge-m3, 1024-d).
import type { SqliteDriver } from "./d1-adapter";

const TABLE = "_selfhost_vectors";
const DDL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  embedding TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ns ON ${TABLE}(namespace);`;

interface VectorRecord {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, unknown>;
}
interface QueryOptions {
  topK?: number;
  namespace?: string;
  returnMetadata?: string;
}
interface Match {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function createSqliteVectorize(driver: SqliteDriver): Vectorize {
  driver.exec(DDL);
  const adapter = {
    async upsert(vectors: VectorRecord[]): Promise<{ count: number; ids: string[] }> {
      for (const v of vectors) {
        driver.query(
          `INSERT INTO ${TABLE} (id, namespace, embedding, metadata) VALUES (?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET namespace=excluded.namespace, embedding=excluded.embedding, metadata=excluded.metadata`,
          [v.id, v.namespace ?? "", JSON.stringify(v.values), v.metadata ? JSON.stringify(v.metadata) : null],
        );
      }
      return { count: vectors.length, ids: vectors.map((v) => v.id) };
    },
    async query(vector: number[], opts: QueryOptions): Promise<{ matches: Match[] }> {
      const { rows } = opts.namespace
        ? driver.query(`SELECT id, embedding, metadata FROM ${TABLE} WHERE namespace=?`, [opts.namespace])
        : driver.query(`SELECT id, embedding, metadata FROM ${TABLE}`, []);
      const scored: Match[] = rows.map((r) => {
        const values = JSON.parse(r.embedding as string) as number[];
        const metadata = r.metadata ? (JSON.parse(r.metadata as string) as Record<string, unknown>) : undefined;
        const score = cosineSimilarity(vector, values);
        return metadata === undefined ? { id: r.id as string, score } : { id: r.id as string, score, metadata };
      });
      scored.sort((a, b) => b.score - a.score);
      return { matches: scored.slice(0, opts.topK ?? 12) };
    },
    async deleteByIds(ids: string[]): Promise<{ count: number }> {
      for (let i = 0; i < ids.length; i += 90) {
        const batch = ids.slice(i, i + 90);
        driver.query(`DELETE FROM ${TABLE} WHERE id IN (${batch.map(() => "?").join(",")})`, batch);
      }
      return { count: ids.length };
    },
  };
  return adapter as unknown as Vectorize;
}
