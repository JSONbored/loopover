import { afterEach, describe, expect, it, vi } from "vitest";
import { runGittensoryAiReview } from "../../src/services/ai-review";
import { formatImpactMapPromptSection } from "../../src/review/impact-map-wire";
import { createTestEnv } from "../helpers/d1";

// ── Test fixtures (mirrors rag-wiring.test.ts's capturingChatRun / aiReviewEnv pattern) ─────────────

const notesJson = JSON.stringify({
  assessment: "Looks fine.",
  suggestions: [],
  risks: [],
  criticalDefect: { present: false, confidence: 0, title: "", detail: "" },
});

function capturingChatRun() {
  const seenUser: string[] = [];
  const run = vi.fn(async (_model: string, options: { messages?: Array<{ role: string; content: string }> }) => {
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

const baseReviewInput = {
  repoFullName: "acme/widgets",
  prNumber: 7,
  title: "Add a feature",
  body: "Implements the thing.",
  diff: "### src/a.ts (modified) +1/-0\n@@\n+export const A = 1;",
  actor: "alice",
  mode: "advisory" as const,
  providerKey: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("impact map wired into the AI reviewer's user prompt (#2186)", () => {
  it("FLAG-ON (impactMapContext supplied): the user prompt gains the IMPACT MAP section", async () => {
    const impactMapContext = formatImpactMapPromptSection([
      { changedModule: "src/review/impact-map.ts", affectedModules: ["src/queue/processors.ts"], callers: ["computeImpactMap"] },
    ]);
    expect(impactMapContext).toContain("IMPACT MAP");

    const { run, seenUser } = capturingChatRun();
    const env = aiReviewEnv({ AI: { run } as unknown as Ai });
    const result = await runGittensoryAiReview(env, { ...baseReviewInput, impactMapContext });
    expect(result.status).toBe("ok");
    const user = seenUser[0] ?? "";
    expect(user).toContain("IMPACT MAP");
    expect(user).toContain("src/review/impact-map.ts");
    expect(user).toContain("src/queue/processors.ts");
    // Additive, not a replacement: the original diff section is still present.
    expect(user).toContain("Unified diff (truncated if large):");
  });

  it("FLAG-OFF (impactMapContext absent): the prompt is byte-identical to the no-impact-map prompt", async () => {
    const { run: runOff, seenUser: seenOff } = capturingChatRun();
    const offEnv = aiReviewEnv({ AI: { run: runOff } as unknown as Ai });
    await runGittensoryAiReview(offEnv, { ...baseReviewInput, impactMapContext: undefined });

    const { run: runOn, seenUser: seenOn } = capturingChatRun();
    const onEnv = aiReviewEnv({ AI: { run: runOn } as unknown as Ai });
    // An empty impact map formats to "" — same as undefined, appends nothing.
    await runGittensoryAiReview(onEnv, { ...baseReviewInput, impactMapContext: formatImpactMapPromptSection([]) });

    expect(seenOn[0]).toBe(seenOff[0]);
    expect(seenOff[0] ?? "").not.toContain("IMPACT MAP");
  });

  it("an empty-string impactMapContext behaves the same as absent (no section appended)", async () => {
    const { run, seenUser } = capturingChatRun();
    const env = aiReviewEnv({ AI: { run } as unknown as Ai });
    await runGittensoryAiReview(env, { ...baseReviewInput, impactMapContext: "" });
    expect(seenUser[0] ?? "").not.toContain("IMPACT MAP");
  });
});
