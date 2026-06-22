// Review-adapter factory (reviewbot→gittensory convergence — ADDITIVE infra). Builds the injected adapter
// interfaces the ported review modules expect (src/review/rag.ts `RagInfra` = VectorAdapter / InferenceAdapter /
// StorageAdapter) from gittensory's ambient `Env` bindings, so the host can wire the ported RAG path without
// the modules depending on Cloudflare bindings directly. This mirrors reviewbot's platform layer — the `cf*`
// pass-through wrappers + `createCloudflareAdapters` (src/platform/cloudflare/index.ts) and the fail-safe gates
// in src/platform/access.ts (no Vectorize → no RAG, no AI → no context).
//
// NOT WIRED YET: this is foundational config + a factory only. The review path does not call it; the per-module
// wiring lands in later chunks. A deploy with none of these bindings provisioned is byte-identical to today.
//
// DEGRADE GRACEFULLY (the hard guarantee): when a binding is ABSENT, the corresponding adapter is omitted
// (vector/inference are optional in `RagInfra`, exactly as in reviewbot). The ported RAG helpers already
// fail-safe on a missing vector/inference adapter ("no vector index → no RAG", "no AI → no context"), so the
// modules NEVER throw — they degrade to no-context. Storage (D1 `DB`) is always present (the Worker cannot run
// without it); its wrapper is a thin pass-through with the prepare→bind→all/first/run + batch surface RAG uses.
import type { InferenceAdapter, RagInfra, StorageAdapter, VectorAdapter } from "./rag";

// ── Storage (D1 → StorageAdapter). Always present. A thin pass-through over `env.DB` — structurally the
//    prepare→bind→{all,first,run} + batch surface the ported modules use. Byte-faithful to reviewbot's
//    cfStorage; the casts bridge D1's concrete prepared-statement type to the portable interface. ──
export function reviewStorageAdapter(env: Env): StorageAdapter {
  return {
    prepare: (query) => env.DB.prepare(query) as unknown as ReturnType<StorageAdapter["prepare"]>,
    batch: (statements) => env.DB.batch(statements as unknown as Parameters<D1Database["batch"]>[0]),
  };
}

// ── Vector (Vectorize → VectorAdapter). Feature-gated. Mirrors reviewbot's cfVector: normalize the query
//    result to the portable `{ matches: [{ id, score, metadata }] }` shape; upsert/deleteByIds are fire-and-
//    forget (the ported RAG code awaits the Promise<void>). ──
export function reviewVectorAdapter(vectorize: Vectorize): VectorAdapter {
  return {
    upsert: async (vectors) => {
      await vectorize.upsert(vectors as unknown as Parameters<Vectorize["upsert"]>[0]);
    },
    query: async (vector, opts) => {
      const res = await vectorize.query(vector, opts as unknown as Parameters<Vectorize["query"]>[1]);
      // Under `exactOptionalPropertyTypes` (gittensory's stricter tsconfig) the optional `metadata?` cannot be
      // assigned `undefined`, so only attach it when Vectorize returned metadata. Behavior is identical to
      // reviewbot's cfVector — a match with no metadata simply has no `metadata` key.
      return {
        matches: (res?.matches ?? []).map((m) =>
          m.metadata === undefined
            ? { id: m.id, score: m.score }
            : { id: m.id, score: m.score, metadata: m.metadata as Record<string, unknown> },
        ),
      };
    },
    deleteByIds: async (ids) => {
      await vectorize.deleteByIds(ids);
    },
  };
}

// ── Inference (Workers AI → InferenceAdapter). Feature-gated. Mirrors `ai.run(model, options)`; the cast
//    bridges the overloaded Workers-AI `run` to the portable single-signature shape. ──
export function reviewInferenceAdapter(ai: Ai): InferenceAdapter {
  return { run: (model, options) => (ai as unknown as { run(m: string, o: Record<string, unknown>): Promise<unknown> }).run(model, options) };
}

/** The infra bundle the ported review modules accept (`RagInfra`). Built from `Env`:
 *   - storage  ← env.DB        (always present)
 *   - vector   ← env.VECTORIZE (omitted when absent ⇒ no RAG)
 *   - inference← env.AI        (omitted when absent ⇒ no context)
 *
 *  Feature-gated bindings map to `undefined` when absent — the SAME fail-safe shape the ported RAG helpers
 *  already handle, so a missing binding degrades to no-context rather than throwing. `exactOptionalPropertyTypes`
 *  is satisfied by only assigning a member when its binding is present (never `vector: undefined`). */
export function createReviewAdapters(env: Env): RagInfra {
  const infra: RagInfra = { storage: reviewStorageAdapter(env) };
  if (env.VECTORIZE) infra.vector = reviewVectorAdapter(env.VECTORIZE);
  if (env.AI) infra.inference = reviewInferenceAdapter(env.AI);
  return infra;
}
