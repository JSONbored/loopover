const LEGACY_SHARED_AI_ENV = [
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_MODEL",
  "AI_EFFORT",
  "AI_TIMEOUT_MS",
] as const;

const LEGACY_SHARED_AI_REPLACEMENTS =
  "Use provider-specific settings instead: OLLAMA_AI_BASE_URL/OLLAMA_AI_MODEL/OLLAMA_AI_API_KEY, " +
  "OPENAI_COMPATIBLE_AI_BASE_URL/OPENAI_COMPATIBLE_AI_MODEL/OPENAI_COMPATIBLE_AI_API_KEY, " +
  "OPENAI_AI_BASE_URL/OPENAI_AI_MODEL/OPENAI_API_KEY, ANTHROPIC_AI_BASE_URL/ANTHROPIC_AI_MODEL/ANTHROPIC_API_KEY, " +
  "CLAUDE_AI_MODEL/CLAUDE_AI_EFFORT/CLAUDE_AI_TIMEOUT_MS, or CODEX_AI_MODEL/CODEX_AI_EFFORT/CODEX_AI_TIMEOUT_MS.";

export const SELF_HOST_REVIEWER_MODEL_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_AI_MODEL",
  "claude-code": "CLAUDE_AI_MODEL",
  codex: "CODEX_AI_MODEL",
  ollama: "OLLAMA_AI_MODEL",
  openai: "OPENAI_AI_MODEL",
  "openai-compatible": "OPENAI_COMPATIBLE_AI_MODEL",
};

function configured(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  return env[key] !== undefined && env[key]?.trim() !== "";
}

export function assertNoLegacySharedAiEnv(
  env: Record<string, string | undefined>,
): void {
  const legacy = LEGACY_SHARED_AI_ENV.filter((key) => configured(env, key));
  if (legacy.length === 0) return;
  throw new Error(
    `legacy_shared_ai_config_unsupported: ${legacy.join(", ")} are no longer supported. ${LEGACY_SHARED_AI_REPLACEMENTS}`,
  );
}

function parseProviderNames(env: Record<string, string | undefined>): string[] {
  assertNoLegacySharedAiEnv(env);
  return (env.AI_PROVIDER ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isConfiguredSelfHostProvider(
  name: string,
  env: Record<string, string | undefined>,
): boolean {
  switch (name) {
    case "anthropic":
      return configured(env, "ANTHROPIC_API_KEY");
    case "claude-code":
    case "codex":
    case "ollama":
    case "openai-compatible":
      return true;
    case "openai":
      return configured(env, "OPENAI_API_KEY");
    default:
      return false;
  }
}

export function resolveConfiguredProviderNames(
  env: Record<string, string | undefined>,
): string[] {
  return parseProviderNames(env).filter((name) =>
    isConfiguredSelfHostProvider(name, env),
  );
}

export function labelSelfHostReviewerModel(
  model: string,
  env: Record<string, string | undefined>,
): string {
  const trimmed = model.trim();
  const colon = trimmed.indexOf(":");
  const provider = (
    colon < 0 ? trimmed : trimmed.slice(0, colon)
  ).toLowerCase();
  const modelEnv = SELF_HOST_REVIEWER_MODEL_ENV[provider];
  if (!modelEnv) return trimmed;
  if (colon >= 0 && trimmed.slice(colon + 1).trim())
    return `${provider}:${trimmed.slice(colon + 1).trim()}`;
  const configuredModel = env[modelEnv]?.trim();
  return configuredModel ? `${provider}:${configuredModel}` : provider;
}

export function labelSelfHostReviewerModels(
  reviewers: ReadonlyArray<{ model: string; fallback?: string | null | undefined }>,
  env: Record<string, string | undefined>,
): string {
  return reviewers
    .map((reviewer) => {
      const primary = labelSelfHostReviewerModel(reviewer.model, env);
      const fallback = reviewer.fallback?.trim()
        ? labelSelfHostReviewerModel(reviewer.fallback, env)
        : "";
      return fallback ? `${primary}->${fallback}` : primary;
    })
    .join("+");
}

export function labelSelfHostReviewerNames(
  names: readonly string[],
  env: Record<string, string | undefined>,
): string {
  return names.map((name) => labelSelfHostReviewerModel(name, env)).join("+");
}
