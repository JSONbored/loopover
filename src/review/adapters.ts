// Review-adapter factory (reviewbot→loopover convergence — ADDITIVE infra). Builds the injected adapter
// interfaces the ported review modules expect (src/review/rag.ts `RagInfra` = VectorAdapter / InferenceAdapter /
// StorageAdapter) from loopover's ambient `Env` bindings, so the host can wire the ported RAG path without
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
import { recordAiUsageEvent } from "../db/repositories";
import { coerceAiUsage } from "../services/ai-review";
import { ragDimensionsFromEnv, ragEmbedBatchFromEnv, type InferenceAdapter, type RagInfra, type StorageAdapter, type VectorAdapter } from "./rag";

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
      // Under `exactOptionalPropertyTypes` (loopover's stricter tsconfig) the optional `metadata?` cannot be
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

// ── Inference (the Ai-shaped adapter → InferenceAdapter). Feature-gated. Mirrors `ai.run(model, options)`;
//    the cast bridges the overloaded `run` signature to the portable single-signature shape. `ai` is
//    Workers AI historically, and on self-host is the generic provider router (src/selfhost/ai.ts).
//
//    Also records every embedding call under the `embeddings` feature (2026-07 fix — previously
//    RAG/embedding calls were never recorded in `ai_usage_events` at all). Self-host's `createOpenAiCompatibleAi`
//    returns real `usage` (provider/model/tokens) for embeddings, so this is recorded for free via
//    `coerceAiUsage`; Workers AI's binding has no such `usage` field, so the call is still recorded (feature +
//    the model actually requested), just without token/cost detail. ──
/**
 * #9060 — a real, non-zero cost estimate for an embedding call.
 *
 * Every embedding was booked at `estimatedNeurons: 0`, which made RAG and impact-map spend invisible to the
 * daily budget governor. That is not merely under-reporting: it is why the ceiling could never converge. The
 * governor's counter never moved for embedding work, so a review loop re-running the prologue every two
 * minutes accumulated real provider spend while the budget it was supposed to be bounded by stayed flat.
 *
 * Deliberately a coarse heuristic, matching how `estimateNeurons` already treats chat calls: the unit is a
 * Workers-AI holdover applied provider-agnostically, so precision here would be false precision. What matters
 * is that repeated embedding work moves the counter at all, so the ceiling can actually bind.
 */
export function estimateEmbeddingNeurons(options: unknown): number {
  const text = (options as { text?: unknown } | null | undefined)?.text;
  const chars = Array.isArray(text)
    ? text.reduce<number>((sum, entry) => sum + (typeof entry === "string" ? entry.length : 0), 0)
    : typeof text === "string"
      ? text.length
      : 0;
  // ~4 chars per token, and a floor of 1 so a call is never free -- a batch of empty strings is still a
  // round trip, and "free" is exactly the accounting that let this spend hide.
  return Math.max(1, Math.ceil(chars / 4 / 100));
}

export function reviewInferenceAdapter(env: Env, ai: Ai): InferenceAdapter {
  const runner = ai as unknown as { run(m: string, o: Record<string, unknown>): Promise<unknown> };
  return {
    run: async (model, options) => {
      try {
        const result = await runner.run(model, options);
        const usage = coerceAiUsage(result);
        await recordAiUsageEvent(env, {
          feature: "embeddings",
          route: "review.embeddings",
          model: usage?.model ?? model,
          provider: usage?.provider,
          effort: usage?.effort,
          status: "ok",
          estimatedNeurons: estimateEmbeddingNeurons(options),
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          totalTokens: usage?.totalTokens,
          costUsd: usage?.costUsd,
        });
        return result;
      } catch (error) {
        await recordAiUsageEvent(env, {
          feature: "embeddings",
          route: "review.embeddings",
          model,
          status: "error",
          // A failed embedding still cost a round trip; booking it at zero is how a retry loop stays invisible.
          estimatedNeurons: estimateEmbeddingNeurons(options),
          detail: error instanceof Error ? error.message : "embedding_failed",
        });
        throw error;
      }
    },
  };
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
  if (env.QDRANT_DIM !== undefined) infra.embeddingDimensions = ragDimensionsFromEnv(env.QDRANT_DIM);
  if (env.AI_EMBED_BATCH !== undefined) infra.embedBatch = ragEmbedBatchFromEnv(env.AI_EMBED_BATCH);
  if (env.VECTORIZE) infra.vector = reviewVectorAdapter(env.VECTORIZE);
  // Embeddings use the DEDICATED embed provider (env.AI_EMBED) when configured — keeping the review chat chain
  // frontier-only — and fall back to env.AI otherwise (byte-identical to before).
  // #9061: falling back to env.AI routes embeddings onto the FRONTIER review chain. createChainAi rejects
  // embeds for CLI providers, but an openai-compatible or anthropic link serves them at frontier pricing --
  // booked, until #9060, at zero. The fallback is kept (removing it would silently disable RAG for every
  // existing deployment that relies on it) but it is now loud: an operator running RAG without a dedicated
  // embed provider should know they are paying frontier rates for embeddings.
  const embedAi = env.AI_EMBED ?? env.AI;
  if (!env.AI_EMBED && env.AI) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "review_embeddings_using_review_chain",
        message: "AI_EMBED is not configured; embeddings route onto the review chain and may bill at frontier rates",
      }),
    );
  }
  if (embedAi) infra.inference = reviewInferenceAdapter(env, embedAi);
  return infra;
}
