import { afterEach, describe, expect, it, vi } from "vitest";
import { runAiReviewForAdvisory } from "../../src/queue/processors";
import { RAG_DIMENSIONS } from "../../src/review/rag";
import { createTestEnv } from "../helpers/d1";
import type { Advisory, RepositorySettings } from "../../src/types";

// ── Test fixtures (mirrors rag-wiring.test.ts's stub patterns) ──────────────────────────────────────

const notesJson = JSON.stringify({
  assessment: "Looks fine.",
  suggestions: [],
  risks: [],
  criticalDefect: { present: false, confidence: 0, title: "", detail: "" },
});

/** A valid bge-m3-width (1024-d) embedding vector — `embedTexts` rejects any other width. */
const VEC_1024 = Array.from({ length: RAG_DIMENSIONS }, () => 0.01);

function vectorizeStub(matches = [{ id: "v1", score: 0.92, metadata: { path: "src/review/caller.ts" } }]) {
  return {
    upsert: vi.fn(async () => ({ mutationId: "m1" })),
    query: vi.fn(async () => ({ matches })),
    deleteByIds: vi.fn(async () => ({ mutationId: "m2" })),
  };
}

function capturingChatRun() {
  const seenUser: string[] = [];
  const run = vi.fn(async (model: string, options: { messages?: Array<{ role: string; content: string }> }) => {
    if (model === "@cf/baai/bge-m3") return { data: [VEC_1024] };
    const userMsg = options.messages?.find((m) => m.role === "user");
    if (userMsg) seenUser.push(userMsg.content);
    return { response: notesJson };
  });
  return { run, seenUser };
}

function aiReviewEnv(over: Partial<Env> = {}) {
  return createTestEnv({
    AI_SUMMARIES_ENABLED: "true",
    AI_PUBLIC_COMMENTS_ENABLED: "true",
    AI_DAILY_NEURON_BUDGET: "100000",
    ...over,
  });
}

const advisory: Advisory = {
  id: "adv-impact-map",
  targetType: "pull_request",
  targetKey: "acme/widgets#3",
  repoFullName: "acme/widgets",
  pullNumber: 3,
  headSha: "sha3",
  conclusion: "neutral",
  severity: "info",
  title: "Gittensory advisory available",
  summary: "ok",
  findings: [],
  generatedAt: "2026-06-20T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("impact map wired into runAiReviewForAdvisory (#2186)", () => {
  it("FLAG-ON (env + reviewImpactMap): computes the impact map from changed files and splices it into the prompt", async () => {
    const { run, seenUser } = capturingChatRun();
    const env = aiReviewEnv({
      LOOPOVER_REVIEW_IMPACT_MAP: "true",
      VECTORIZE: vectorizeStub() as unknown as Vectorize,
      AI: { run } as unknown as Ai,
    });
    // A changed-file row whose patch adds an exported function — extractChangedSymbols picks up "computeThing".
    await env.DB.prepare(
      "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "acme/widgets",
        3,
        "src/review/impact-map.ts",
        "modified",
        1,
        0,
        1,
        JSON.stringify({ patch: "@@\n+export function computeThing() {\n+  return 1;\n+}" }),
      )
      .run();
    // A SECOND changed-file row whose payload has NO patch — exercises the `typeof … === "string" ? … : undefined`
    // ternary's undefined side (mirrors rag-wiring.test.ts's identical "no-patch" row for the same map call).
    await env.DB.prepare(
      "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("acme/widgets", 3, "img/logo.png", "added", 0, 0, 0, JSON.stringify({}))
      .run();
    // A stored chunk so retrieveContextWithMetrics's chunk-text read finds real text for the vector match.
    await env.DB.prepare(
      "INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("v1", "acme", "widgets", "src/review/caller.ts", 0, "code", "export function caller() { return computeThing(); }")
      .run();
    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      repoFullName: "acme/widgets",
      pr: { number: 3, title: "Add computeThing", body: "Adds a helper." },
      author: "alice",
      confirmedContributor: true,
      advisory,
      reviewImpactMap: true,
    });
    expect(result?.notes ?? "").toBeDefined();
    const user = seenUser[0] ?? "";
    expect(user).toContain("IMPACT MAP");
    expect(user).toContain("src/review/impact-map.ts");
    expect(user).toContain("src/review/caller.ts");
    // #1971: the SAME computed entries are threaded out of the review result so the publish site can render the
    // "Impact map" collapsible from them — no second RAG query.
    expect(result?.impactMap?.length).toBeGreaterThan(0);
    expect(result?.impactMap?.[0]?.changedModule).toBe("src/review/impact-map.ts");
    expect(result?.impactMap?.[0]?.affectedModules).toContain("src/review/caller.ts");
  });

  it("FLAG-OFF (operator env unset): no impact-map computation, prompt has no IMPACT MAP section", async () => {
    const { run, seenUser } = capturingChatRun();
    const env = aiReviewEnv({
      VECTORIZE: vectorizeStub() as unknown as Vectorize,
      AI: { run } as unknown as Ai,
    });
    await env.DB.prepare(
      "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("acme/widgets", 3, "src/review/impact-map.ts", "modified", 1, 0, 1, JSON.stringify({ patch: "@@\n+export function computeThing() {}" }))
      .run();
    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      repoFullName: "acme/widgets",
      pr: { number: 3, title: "Add computeThing", body: "Adds a helper." },
      author: "alice",
      confirmedContributor: true,
      advisory,
      reviewImpactMap: true, // manifest opted in, but the operator env flag is OFF -> still no computation
    });
    expect(result?.notes ?? "").toBeDefined();
    expect(seenUser[0] ?? "").not.toContain("IMPACT MAP");
  });

  it("FLAG-ON but the manifest did not opt in (reviewImpactMap absent): no impact-map computation", async () => {
    const { run, seenUser } = capturingChatRun();
    const env = aiReviewEnv({
      LOOPOVER_REVIEW_IMPACT_MAP: "true",
      VECTORIZE: vectorizeStub() as unknown as Vectorize,
      AI: { run } as unknown as Ai,
    });
    await env.DB.prepare(
      "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("acme/widgets", 3, "src/review/impact-map.ts", "modified", 1, 0, 1, JSON.stringify({ patch: "@@\n+export function computeThing() {}" }))
      .run();
    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      repoFullName: "acme/widgets",
      pr: { number: 3, title: "Add computeThing", body: "Adds a helper." },
      author: "alice",
      confirmedContributor: true,
      advisory,
    });
    expect(result?.notes ?? "").toBeDefined();
    expect(seenUser[0] ?? "").not.toContain("IMPACT MAP");
  });

  it("FLAG-ON, computation runs but yields an empty impact map (no VECTORIZE binding): no IMPACT MAP section", async () => {
    // No VECTORIZE binding -> createReviewAdapters omits the vector adapter -> computeImpactMap returns []
    // -> formatImpactMapPromptSection([]) === "" -> impactMapContext is falsy -> byte-identical prompt.
    const { run, seenUser } = capturingChatRun();
    const env = aiReviewEnv({ LOOPOVER_REVIEW_IMPACT_MAP: "true", AI: { run } as unknown as Ai });
    await env.DB.prepare(
      "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("acme/widgets", 3, "src/review/impact-map.ts", "modified", 1, 0, 1, JSON.stringify({ patch: "@@\n+export function computeThing() {}" }))
      .run();
    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      repoFullName: "acme/widgets",
      pr: { number: 3, title: "Add computeThing", body: "Adds a helper." },
      author: "alice",
      confirmedContributor: true,
      advisory,
      reviewImpactMap: true,
    });
    expect(result?.notes ?? "").toBeDefined();
    expect(seenUser[0] ?? "").not.toContain("IMPACT MAP");
  });
});
