/** Typed form state for the config generator (#1683). Field groups append slices here; YAML preview (#2210) serializes later. */

export type AiCombineStrategy = "single" | "consensus" | "synthesis";
export type AiProvider = "anthropic" | "openai";

export type GeneratorGateAiReviewState = {
  combine?: AiCombineStrategy | null;
  provider?: AiProvider | null;
  model?: string | null;
};

/** Per-analyzer enable/disable OVERRIDES only — an analyzer absent from the map follows the
 *  REES_DEFAULT_PROFILE default (see effectiveReesAnalyzerEnabled). */
export type GeneratorReesState = {
  analyzers?: Record<string, boolean>;
};

export type GeneratorFormState = {
  gate?: {
    aiReview?: GeneratorGateAiReviewState;
  };
  rees?: GeneratorReesState;
};

export function patchGeneratorGateAiReview(
  state: GeneratorFormState,
  patch: Partial<GeneratorGateAiReviewState>,
): GeneratorFormState {
  return {
    ...state,
    gate: {
      ...state.gate,
      aiReview: {
        ...state.gate?.aiReview,
        ...patch,
      },
    },
  };
}

/** Set or clear one analyzer's enable/disable override (#2207). Passing `enabled === null` removes
 *  the override so the analyzer falls back to its REES_DEFAULT_PROFILE membership. */
export function patchGeneratorReesAnalyzer(
  state: GeneratorFormState,
  name: string,
  enabled: boolean | null,
): GeneratorFormState {
  const overrides = { ...state.rees?.analyzers };
  if (enabled === null) {
    delete overrides[name];
  } else {
    overrides[name] = enabled;
  }
  return { ...state, rees: { ...state.rees, analyzers: overrides } };
}

/** Drop every analyzer override — the "reset to profile default" affordance (#2207). */
export function resetGeneratorReesAnalyzers(state: GeneratorFormState): GeneratorFormState {
  return { ...state, rees: { ...state.rees, analyzers: {} } };
}

/** An analyzer's effective enabled state: explicit override first, else whether the analyzer belongs
 *  to the default profile (REES_ANALYZERS unset runs the registry's profile defaults). */
export function effectiveReesAnalyzerEnabled(
  rees: GeneratorReesState | undefined,
  analyzer: { name: string; profiles: readonly string[] },
  defaultProfile: string,
): boolean {
  const override = rees?.analyzers?.[analyzer.name];
  return override ?? analyzer.profiles.includes(defaultProfile);
}

/** Map the REES slice to the manifest's exact-list semantics: with no overrides the key stays unset
 *  (REES runs its profile defaults); with any override, emit the full effective enabled list, since
 *  REES_ANALYZERS is an exact comma-list, not a delta. */
export function reesAnalyzersManifestPatch(
  rees: GeneratorReesState | undefined,
  catalog: ReadonlyArray<{ name: string; profiles: readonly string[] }>,
  defaultProfile: string,
): { reesAnalyzers: string[] | null } {
  const overrides = rees?.analyzers ?? {};
  if (Object.keys(overrides).length === 0) return { reesAnalyzers: null };
  return {
    reesAnalyzers: catalog
      .filter((analyzer) => effectiveReesAnalyzerEnabled(rees, analyzer, defaultProfile))
      .map((analyzer) => analyzer.name),
  };
}

/** Map the AI-provider slice to manifest gate keys (gate.aiReview.* in focus-manifest). */
export function gateAiReviewManifestPatch(aiReview: GeneratorGateAiReviewState | undefined): {
  aiReviewCombine: AiCombineStrategy | null;
  aiReviewProvider: AiProvider | null;
  aiReviewModel: string | null;
} {
  const model = aiReview?.model?.trim();
  return {
    aiReviewCombine: aiReview?.combine ?? null,
    aiReviewProvider: aiReview?.provider ?? null,
    aiReviewModel: model ? model : null,
  };
}
