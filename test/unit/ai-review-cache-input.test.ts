import {
  AI_REVIEW_CACHE_INPUT_VERSION,
  aiReviewCacheInputFingerprint,
  aiReviewCacheInputMatches,
  cacheMetadataForAiReviewInput,
  type AiReviewCacheInput,
} from "../../src/review/ai-review-cache-input";

const baseInput = (): AiReviewCacheInput => ({
  mode: "block",
  byok: false,
  provider: null,
  model: null,
  reviewerPlan: null,
  selfHostProviderConfig: null,
  profile: null,
  inlineComments: false,
  pathInstructions: [],
  pathGuidance: "",
  repoInstructions: null,
  excludePaths: [],
  changedPaths: ["src/a.ts"],
  features: {
    grounding: false,
    rag: false,
    enrichment: false,
    reputation: false,
  },
});

describe("aiReviewCacheInputFingerprint", () => {
  it("is stable across irrelevant path ordering and whitespace normalization", async () => {
    const left = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      changedPaths: [" src/b.ts ", "src/a.ts", "src/a.ts"],
      excludePaths: ["dist/**", " **/*.lock "],
      repoInstructions: "  Follow the repo guide.  ",
    });
    const right = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      changedPaths: ["src/a.ts", "src/b.ts"],
      excludePaths: ["**/*.lock", "dist/**"],
      repoInstructions: "Follow the repo guide.",
    });

    expect(left).toBe(right);
    expect(left.startsWith(`${AI_REVIEW_CACHE_INPUT_VERSION}:`)).toBe(true);
  });

  it("changes when prompt-affecting review inputs change", async () => {
    const original = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: "consensus", reviewers: [{ model: "a" }, { model: "b" }] },
      pathInstructions: [{ path: "src/**", instructions: "Be strict." }],
      pathGuidance: "Be strict.",
      features: { ...baseInput().features, rag: true },
    });
    const updated = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: "consensus", reviewers: [{ model: "a" }, { model: "c" }] },
      pathInstructions: [{ path: "src/**", instructions: "Be strict." }],
      pathGuidance: "Be strict.",
      features: { ...baseInput().features, rag: true },
    });

    expect(updated).not.toBe(original);
  });

  it("normalizes sparse reviewer plan fields deterministically", async () => {
    const omittedReviewers = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: {},
    });
    const explicitEmpty = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: null, reviewers: [] },
    });
    const sparse = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { reviewers: [{}] },
    });
    const explicit = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: null, reviewers: [{ model: null }] },
    });

    expect(omittedReviewers).toBe(explicitEmpty);
    expect(sparse).toBe(explicit);
  });

  it("changes when a self-host provider's underlying model/effort/timeout changes, even with the same reviewer plan", async () => {
    const reviewerPlan = { combine: "single", reviewers: [{ model: "claude-code" }] };
    const fullyConfigured = {
      claudeModel: "sonnet",
      claudeEffort: "high",
      claudeTimeoutMs: "60000",
      codexModel: "gpt-5",
      codexEffort: "high",
      codexTimeoutMs: "240000",
      ollamaBaseUrl: "http://localhost:11434/v1",
      ollamaModel: "llama-3.1",
      openaiCompatibleBaseUrl: "http://localhost:11434/v1",
      openaiCompatibleModel: "llama-3.1",
      openaiBaseUrl: "https://api.openai.com/v1",
      openaiModel: "gpt-5",
      anthropicBaseUrl: "https://api.anthropic.com",
      anthropicModel: "claude-sonnet-5",
    };

    const original = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan,
      selfHostProviderConfig: fullyConfigured,
    });
    const repeated = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan,
      selfHostProviderConfig: { ...fullyConfigured },
    });
    // The reviewer PLAN (provider names) is unchanged -- only the underlying model changed. The prior
    // fingerprint (reviewer.model only) would have collided here; this must now miss.
    const modelChanged = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan,
      selfHostProviderConfig: { ...fullyConfigured, claudeModel: "opus" },
    });
    const effortChanged = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan,
      selfHostProviderConfig: { ...fullyConfigured, claudeEffort: "low" },
    });

    expect(repeated).toBe(original);
    expect(modelChanged).not.toBe(original);
    expect(effortChanged).not.toBe(original);
  });

  it("normalizes an absent self-host provider config the same whether omitted or explicitly empty", async () => {
    const nullConfig = await aiReviewCacheInputFingerprint({ ...baseInput(), selfHostProviderConfig: null });
    const emptyConfig = await aiReviewCacheInputFingerprint({ ...baseInput(), selfHostProviderConfig: {} });
    const sparseConfig = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      selfHostProviderConfig: { claudeModel: undefined },
    });

    expect(emptyConfig).toBe(sparseConfig);
    expect(emptyConfig).not.toBe(nullConfig);
  });
});

describe("aiReviewCacheInputMatches", () => {
  it("requires both the current input version and exact fingerprint", async () => {
    const fingerprint = await aiReviewCacheInputFingerprint(baseInput());
    expect(
      aiReviewCacheInputMatches(
        { inputVersion: AI_REVIEW_CACHE_INPUT_VERSION, inputFingerprint: fingerprint },
        fingerprint,
      ),
    ).toBe(true);
    expect(aiReviewCacheInputMatches(undefined, fingerprint)).toBe(false);
    expect(aiReviewCacheInputMatches({ inputFingerprint: fingerprint }, fingerprint)).toBe(false);
    expect(
      aiReviewCacheInputMatches(
        { inputVersion: AI_REVIEW_CACHE_INPUT_VERSION, inputFingerprint: "different" },
        fingerprint,
      ),
    ).toBe(false);
  });

  it("adds cache input metadata without discarding existing review telemetry", async () => {
    const fingerprint = await aiReviewCacheInputFingerprint(baseInput());
    expect(cacheMetadataForAiReviewInput(null, fingerprint)).toEqual({
      inputVersion: AI_REVIEW_CACHE_INPUT_VERSION,
      inputFingerprint: fingerprint,
    });
    expect(cacheMetadataForAiReviewInput({ rag: { injected: true } }, fingerprint)).toEqual({
      rag: { injected: true },
      inputVersion: AI_REVIEW_CACHE_INPUT_VERSION,
      inputFingerprint: fingerprint,
    });
  });
});
