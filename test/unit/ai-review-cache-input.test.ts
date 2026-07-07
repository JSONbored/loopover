import {
  AI_REVIEW_CACHE_INPUT_VERSION,
  aiReviewCacheInputFingerprint,
  type AiReviewCacheInput,
} from "../../src/review/ai-review-cache-input";

const baseInput = (): AiReviewCacheInput => ({
  title: "Fix the retry loop",
  mode: "block",
  byok: false,
  provider: null,
  model: null,
  aiReviewAllAuthors: false,
  aiReviewCloseConfidence: null,
  aiReviewCombine: null,
  aiReviewOnMerge: null,
  aiReviewReviewers: null,
  gatePack: null,
  reviewerPlan: null,
  selfHostProviderConfig: null,
  selfHostAiModelOverride: null,
  reviewFiles: [],
  profile: null,
  securityFocus: false,
  inlineComments: false,
  pathInstructions: [],
  pathGuidance: "",
  repoInstructions: null,
  excludePaths: [],
  pathFilters: [],
  changedPaths: ["src/a.ts"],
  features: {
    grounding: false,
    rag: false,
    enrichment: false,
    reputation: false,
    cultureProfile: false,
    impactMap: false,
  },
});

describe("aiReviewCacheInputFingerprint", () => {
  it("is stable across irrelevant path ordering and whitespace normalization", async () => {
    const left = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      changedPaths: [" src/b.ts ", "src/a.ts", "src/a.ts"],
      excludePaths: ["dist/**", " **/*.lock "],
      pathFilters: [" src/** ", "!src/generated/**"],
      repoInstructions: "  Follow the repo guide.  ",
    });
    const right = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      changedPaths: ["src/a.ts", "src/b.ts"],
      excludePaths: ["**/*.lock", "dist/**"],
      pathFilters: ["src/**", "!src/generated/**"],
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

  it("changes when review path_filters change", async () => {
    const original = await aiReviewCacheInputFingerprint({ ...baseInput(), pathFilters: ["src/**"] });
    const updated = await aiReviewCacheInputFingerprint({ ...baseInput(), pathFilters: ["src/**", "!src/generated/**"] });
    expect(updated).not.toBe(original);
  });

  it("changes when the self-host reviewer fallback changes", async () => {
    const original = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: "single", reviewers: [{ model: "codex", fallback: "claude-code" }] },
    });
    const fallbackChanged = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: "single", reviewers: [{ model: "codex", fallback: "anthropic" }] },
    });
    const omittedFallback = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: "single", reviewers: [{ model: "codex" }] },
    });
    const repeated = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewerPlan: { combine: "single", reviewers: [{ model: "codex", fallback: "claude-code" }] },
    });

    expect(fallbackChanged).not.toBe(original);
    expect(omittedFallback).not.toBe(original);
    expect(repeated).toBe(original);
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
      reviewerPlan: { combine: null, reviewers: [{ model: null, fallback: null }] },
    });

    expect(omittedReviewers).toBe(explicitEmpty);
    expect(sparse).toBe(explicit);
  });

  it("changes when the patch content differs even though the same file paths are touched", async () => {
    const original = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 }],
    });
    const samePathsDifferentPatch = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+completely different", additions: 1, deletions: 1 }],
    });
    const repeated = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewFiles: [{ path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 }],
    });
    // File order must not matter -- only content -- so a re-fetched diff in a different row order still hits.
    const reordered = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewFiles: [
        { path: "src/b.ts", status: "added", patch: "@@ -0,0 +1 @@\n+export {}", additions: 1, deletions: 0 },
        { path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 },
      ],
    });
    const reorderedAgain = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewFiles: [
        { path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 },
        { path: "src/b.ts", status: "added", patch: "@@ -0,0 +1 @@\n+export {}", additions: 1, deletions: 0 },
      ],
    });

    expect(samePathsDifferentPatch).not.toBe(original);
    expect(repeated).toBe(original);
    expect(reordered).toBe(reorderedAgain);
  });

  // #regate-churn (root cause, confirmed in production): `baseSha` is intentionally NOT a field on
  // AiReviewCacheInput any more (see the type's own doc comment) -- the type system itself now guarantees no
  // caller can (re-)introduce it. It used to be included, on the theory that a rebase/retarget can change the
  // diff for an unchanged head SHA even when `changedPaths` stays the same -- but `reviewFiles`' patch content
  // (asserted above) already IS that signal. Hashing raw `baseSha` on top of it was redundant when the patch is
  // unchanged, and actively harmful when it isn't: it is the live tip of the base branch, which advances on
  // every unrelated merge, so an active repo's same-head PR missed the cache on almost every scheduled re-gate
  // sweep -- re-spending a real AI call whose non-deterministic output could even flip the published verdict,
  // purely because SOME OTHER PR merged to main in between. The end-to-end "pure base movement" scenario is
  // covered at the queue/sweep level in test/unit/queue.test.ts (#regate-churn).

  it("normalizes a file entry with no status/patch (e.g. a rename with no content change) deterministically", async () => {
    const omitted = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewFiles: [{ path: "src/a.ts", additions: 0, deletions: 0 }],
    });
    const explicitNull = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewFiles: [{ path: "src/a.ts", status: null, patch: null, additions: 0, deletions: 0 }],
    });
    const withStatusAndPatch = await aiReviewCacheInputFingerprint({
      ...baseInput(),
      reviewFiles: [{ path: "src/a.ts", status: "renamed", patch: "@@ -1 +1 @@", additions: 0, deletions: 0 }],
    });

    expect(omitted).toBe(explicitNull);
    expect(omitted).not.toBe(withStatusAndPatch);
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

  it("changes when the PER-REPO review.ai_model override gains an ollama/openai/openai-compatible/anthropic model (#3902)", async () => {
    const original = await aiReviewCacheInputFingerprint(baseInput());
    for (const key of ["ollamaModel", "openaiModel", "openaiCompatibleModel", "anthropicModel"] as const) {
      const changed = await aiReviewCacheInputFingerprint({
        ...baseInput(),
        selfHostAiModelOverride: { claudeModel: null, claudeEffort: null, codexModel: null, codexEffort: null, ollamaModel: null, openaiModel: null, openaiCompatibleModel: null, anthropicModel: null, [key]: "repo-override-model" },
      });
      expect(changed, key).not.toBe(original);
    }
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

  it("changes when the PR title changes even though nothing else does (#2119)", async () => {
    // The title is threaded into the reviewer prompt (runAiReviewForAdvisory's pr.title), so a same-head
    // `edited` event that changes only the title must miss the cache rather than replay a review generated
    // against different prompt metadata.
    const original = await aiReviewCacheInputFingerprint(baseInput());
    const titleChanged = await aiReviewCacheInputFingerprint({ ...baseInput(), title: "Fix the retry loop (v2)" });
    const repeated = await aiReviewCacheInputFingerprint(baseInput());

    expect(titleChanged).not.toBe(original);
    expect(repeated).toBe(original);
  });

  it("changes when aiReviewAllAuthors, aiReviewCloseConfidence, or gatePack change", async () => {
    const original = await aiReviewCacheInputFingerprint(baseInput());
    const allAuthorsChanged = await aiReviewCacheInputFingerprint({ ...baseInput(), aiReviewAllAuthors: true });
    const closeConfidenceChanged = await aiReviewCacheInputFingerprint({ ...baseInput(), aiReviewCloseConfidence: 0.9 });
    const gatePackChanged = await aiReviewCacheInputFingerprint({ ...baseInput(), gatePack: "oss-anti-slop" });
    const repeated = await aiReviewCacheInputFingerprint(baseInput());

    expect(allAuthorsChanged).not.toBe(original);
    expect(closeConfidenceChanged).not.toBe(original);
    expect(gatePackChanged).not.toBe(original);
    expect(repeated).toBe(original);
  });

  // #2567 gate-review follow-up: these directly shape the EFFECTIVE combine/onMerge/reviewers plan
  // (resolveEffectiveAiReviewPlan), which drives whether/how a consensus defect is computed -- a repo
  // flipping any of them must miss the cache, mirroring aiReviewCloseConfidence's own reasoning above.
  it("changes when aiReviewCombine, aiReviewOnMerge, or aiReviewReviewers change", async () => {
    const original = await aiReviewCacheInputFingerprint(baseInput());
    const combineChanged = await aiReviewCacheInputFingerprint({ ...baseInput(), aiReviewCombine: "synthesis" });
    const onMergeChanged = await aiReviewCacheInputFingerprint({ ...baseInput(), aiReviewOnMerge: "either" });
    const reviewersChanged = await aiReviewCacheInputFingerprint({ ...baseInput(), aiReviewReviewers: [{ model: "claude-code" }] });
    const repeated = await aiReviewCacheInputFingerprint(baseInput());

    expect(combineChanged).not.toBe(original);
    expect(onMergeChanged).not.toBe(original);
    expect(reviewersChanged).not.toBe(original);
    expect(repeated).toBe(original);
  });

  // REGRESSION (#2567 gate-review follow-up): nullish (no repo override, falls through to the built-in default
  // reviewers per resolveEffectiveAiReviewPlan) and an explicit [] (a real, empty override) are DIFFERENT
  // effective plans -- collapsing both to the same fingerprint would let a same-SHA cache hit replay a verdict
  // produced under the other plan.
  it("fingerprints aiReviewReviewers: null and aiReviewReviewers: [] DIFFERENTLY -- runtime semantics differ", async () => {
    const nullish = await aiReviewCacheInputFingerprint({ ...baseInput(), aiReviewReviewers: null });
    const undef = await aiReviewCacheInputFingerprint({ ...baseInput(), aiReviewReviewers: undefined });
    const explicitEmpty = await aiReviewCacheInputFingerprint({ ...baseInput(), aiReviewReviewers: [] });

    expect(nullish).toBe(undef);
    expect(explicitEmpty).not.toBe(nullish);
  });

  it("changes when securityFocus toggles, independently of profile (#review-security-focus)", async () => {
    const original = await aiReviewCacheInputFingerprint(baseInput());
    const securityFocusOn = await aiReviewCacheInputFingerprint({ ...baseInput(), securityFocus: true });
    const profileAndSecurityFocus = await aiReviewCacheInputFingerprint({ ...baseInput(), profile: "chill", securityFocus: true });
    const profileOnly = await aiReviewCacheInputFingerprint({ ...baseInput(), profile: "chill" });
    const repeated = await aiReviewCacheInputFingerprint(baseInput());

    expect(securityFocusOn).not.toBe(original);
    expect(profileAndSecurityFocus).not.toBe(profileOnly);
    expect(profileAndSecurityFocus).not.toBe(securityFocusOn);
    expect(repeated).toBe(original);
  });
});
