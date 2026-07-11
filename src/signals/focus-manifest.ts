/**
 * Focus-manifest shim (#2280). Parse/compile core lives in `packages/gittensory-engine/src/focus-manifest.ts`;
 * this file re-exports the engine surface and keeps app-local resolver/guidance functions that depend on
 * `src/` modules (`classifyChangedFile`, `mergeContributorBlacklists`, etc.).
 */
export {
  AI_REVIEW_CADENCES,
  COMMENT_VERBOSITY_LEVELS,
  CONVERGED_FEATURE_KEYS,
  E2E_TEST_DELIVERY_MODES,
  EMPTY_AUTO_REVIEW_CONFIG,
  EMPTY_MAX_FINDINGS_CONFIG,
  EMPTY_SELF_HOST_AI_MODEL_CONFIG,
  EMPTY_VISUAL_CONFIG,
  LINKED_ISSUE_SATISFACTION_MODES,
  MAX_FOCUS_MANIFEST_BYTES,
  REVIEW_FIELD_KEYS,
  REVIEW_FINDING_SEVERITY_LADDER,
  REVIEW_PROFILES,
  compileFocusManifestPolicy,
  contentLaneConfigToJson,
  featuresConfigToJson,
  formatManifestValidationNotice,
  gateConfigToJson,
  isFocusManifestPublicSafe,
  matchesManifestPath,
  normalizeReadinessGateMode,
  parseFocusManifest,
  parseFocusManifestContent,
  parseReviewConfigMapping,
  overlayReviewConfig,
  repoDocGenerationConfigToJson,
  reviewConfigToJson,
  reviewRecapConfigToJson,
  maintainerRecapConfigToJson,
  settingsOverrideToJson,
  type AiReviewCadence,
  type AutoReviewConfig,
  type CommentVerbosity,
  type ConvergedFeatureKey,
  type E2eTestDeliveryMode,
  type FocusManifest,
  type FocusManifestContentLaneConfig,
  type FocusManifestFeaturesConfig,
  type FocusManifestFinding,
  type FocusManifestGateConfig,
  type FocusManifestGuidance,
  type FocusManifestIssueDiscoveryPolicy,
  type FocusManifestLanePreference,
  type FocusManifestLinkedIssuePolicy,
  type FocusManifestPolicy,
  type FocusManifestPolicyContributionLane,
  type FocusManifestPolicyLabelPolicy,
  type FocusManifestPolicyValidation,
  type FocusManifestRepoDocGenerationConfig,
  type FocusManifestRepoDocGenerationScope,
  type FocusManifestReviewConfig,
  type FocusManifestReviewRecapConfig,
  type FocusManifestMaintainerRecapConfig,
  type FocusManifestSettings,
  type FocusManifestSource,
  type LinkedIssueSatisfactionMode,
  type MaxFindingsConfig,
  type PreMergeCheck,
  type ReviewFieldKey,
  type ReviewFindingSeverity,
  type ReviewPathInstruction,
  type ReviewProfile,
  type SelfHostAiModelConfig,
  type VisualConfig,
  type VisualPreviewConfig,
  type VisualRoutesConfig,
  type VisualTheme,
} from "../../packages/gittensory-engine/src/focus-manifest.js";

import type { PrTypeLabelSet, RepositorySettings } from "../types";
import { mergeContributorBlacklists } from "../settings/contributor-blacklist";
import { DEFAULT_TYPE_LABELS } from "../settings/pr-type-label";
import { DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION } from "../review/linked-issue-label-propagation";
import { DEFAULT_LINKED_ISSUE_HARD_RULES } from "../review/linked-issue-hard-rules-config";
import { DEFAULT_UNLINKED_ISSUE_GUARDRAIL } from "../review/unlinked-issue-guardrail-config";
import { DEFAULT_ADVISORY_AI_ROUTING } from "../review/advisory-ai-routing-config";
import { DEFAULT_SCREENSHOT_TABLE_GATE } from "../review/screenshot-table-gate";
import { classifyChangedFile } from "./path-matchers";
import {
  EMPTY_AUTO_REVIEW_CONFIG,
  EMPTY_MAX_FINDINGS_CONFIG,
  EMPTY_SELF_HOST_AI_MODEL_CONFIG,
  EMPTY_VISUAL_CONFIG,
  isFocusManifestPublicSafe,
  matchesManifestPath,
  type AutoReviewConfig,
  type CommentVerbosity,
  type E2eTestDeliveryMode,
  type FocusManifest,
  type FocusManifestFinding,
  type FocusManifestGateConfig,
  type FocusManifestGuidance,
  type FocusManifestSource,
  type MaxFindingsConfig,
  type PreMergeCheck,
  type ReviewFindingSeverity,
  type ReviewPathInstruction,
  type ReviewProfile,
  type SelfHostAiModelConfig,
  type VisualConfig,
} from "../../packages/gittensory-engine/src/focus-manifest.js";
import type { ReesAnalyzerName } from "../review/enrichment-analyzer-names";

export function resolveReviewPathInstructions(pathInstructions: ReviewPathInstruction[], changedPaths: string[]): string {
  if (pathInstructions.length === 0 || changedPaths.length === 0) return "";
  const applicable = pathInstructions.filter((entry) => changedPaths.some((path) => matchesManifestPath(path, entry.path)));
  if (applicable.length === 0) return "";
  const lines = applicable.map((entry) => `- \`${entry.path}\`: ${entry.instructions}`);
  return `\n\nPath-specific review instructions from the maintainer — apply these to the changed files that match each glob:\n${lines.join("\n")}`;
}

export function resolveAutoReviewConfig(manifest: FocusManifest | null): AutoReviewConfig {
  return manifest?.review.autoReview ?? { ...EMPTY_AUTO_REVIEW_CONFIG };
}

export type AutoReviewEligibilityInput = {
  isDraft: boolean;
  author: string | null;
  title: string;
  labels: readonly string[];
  changedPaths: readonly string[];
  addedLineCount: number;
  changedFileCount: number;
  baseRef: string | null;
  reviewedCommitCount: number;
};

/** Evaluate `review.auto_review` eligibility. Returns a quiet skip reason string, or null when AI review should proceed. (#1954) */
export function evaluateAutoReviewSkipReason(config: AutoReviewConfig, input: AutoReviewEligibilityInput): string | null {
  if (config.skipDrafts === true && input.isDraft) return "review skipped (draft)";
  if (input.author && config.ignoreAuthors.length > 0) {
    const author = input.author.toLowerCase();
    if (config.ignoreAuthors.some((glob) => matchesManifestPath(author, glob.toLowerCase()))) {
      return "review skipped (ignored author)";
    }
  }
  if (config.ignoreTitleKeywords.length > 0) {
    const titleLower = input.title.toLowerCase();
    if (config.ignoreTitleKeywords.some((keyword) => titleLower.includes(keyword.toLowerCase()))) {
      return "review skipped (WIP title)";
    }
  }
  if (config.skipLabels.length > 0 && input.labels.length > 0) {
    const prLabels = new Set(input.labels.map((label) => label.toLowerCase()));
    if (config.skipLabels.some((label) => prLabels.has(label))) {
      return "review skipped (label)";
    }
  }
  if (config.skipDocsOnly === true && input.changedPaths.length > 0) {
    if (input.changedPaths.every((path) => classifyChangedFile(path) === "docs")) {
      return "review skipped (docs only)";
    }
  }
  if (config.maxAddedLines > 0 && input.addedLineCount > config.maxAddedLines) {
    return "review skipped (too large)";
  }
  if (config.maxFiles > 0 && input.changedFileCount > config.maxFiles) {
    return "review skipped (too large)";
  }
  if (config.baseBranches.length > 0) {
    const baseRef = input.baseRef?.trim() ?? "";
    if (!baseRef || !config.baseBranches.some((glob) => matchesManifestPath(baseRef, glob))) {
      return "review skipped (base branch out of scope)";
    }
  }
  if (isAutoReviewCommitThresholdReached(config, input.reviewedCommitCount)) {
    return "review paused (commit threshold)";
  }
  return null;
}

/** Shared commit-threshold check (`review.auto_review.auto_pause_after_reviewed_commits`): once a PR's already
 *  been reviewed this many times at essentially its current state, further AI spend on it should stop. Broken
 *  out of `evaluateAutoReviewSkipReason` so a SECOND AI feature sharing the same PR (e.g. the slop advisory,
 *  #ai-slop-repeat-spend) can reuse the identical threshold semantics without re-implementing the null/0
 *  "unset" handling or pulling in every OTHER unrelated `auto_review` rule (draft/author/title/size/base-branch
 *  skips) that only make sense for the primary review pass. */
export function isAutoReviewCommitThresholdReached(config: AutoReviewConfig, reviewedCommitCount: number): boolean {
  return config.autoPauseAfterReviewedCommits !== null && config.autoPauseAfterReviewedCommits > 0 && reviewedCommitCount >= config.autoPauseAfterReviewedCommits;
}

/** Known auto-review skip reason tokens returned by `evaluateAutoReviewSkipReason`. (#2067) */
export type AutoReviewSkipReason =
  | "review skipped (draft)"
  | "review skipped (ignored author)"
  | "review skipped (WIP title)"
  | "review skipped (label)"
  | "review skipped (docs only)"
  | "review skipped (too large)"
  | "review skipped (base branch out of scope)"
  | "review paused (commit threshold)";

/** Public-safe one-line summaries for each auto-review skip reason — mirrors settings-preview `SKIP_SUMMARY`. (#2067) */
export const AUTO_REVIEW_SKIP_SUMMARY: Record<AutoReviewSkipReason, string> = {
  "review skipped (draft)": "AI review is skipped for draft pull requests while review.auto_review.skip_drafts is enabled.",
  "review skipped (ignored author)": "The author matches review.auto_review.ignore_authors, so AI review is skipped.",
  "review skipped (WIP title)": "The title matches review.auto_review.ignore_title_keywords, so AI review is skipped.",
  "review skipped (label)": "A configured review.auto_review.skip_labels label is present, so AI review is skipped.",
  "review skipped (docs only)": "Every changed file is documentation while review.auto_review.skip_docs_only is enabled, so AI review is skipped.",
  "review skipped (too large)": "The pull request exceeds review.auto_review.max_added_lines or max_files, so AI review is skipped.",
  "review skipped (base branch out of scope)": "The base branch is outside review.auto_review.base_branches, so AI review is skipped.",
  "review paused (commit threshold)": "Published AI review count reached review.auto_review.auto_pause_after_reviewed_commits, so further AI review is paused.",
};

export function isContributorControlledAutoReviewSkipReason(skipReason: string): boolean {
  return skipReason === "review skipped (WIP title)" || skipReason === "review skipped (base branch out of scope)";
}

export function resolveAutoReviewSkipSummary(skipReason: string): string {
  if (Object.prototype.hasOwnProperty.call(AUTO_REVIEW_SKIP_SUMMARY, skipReason)) {
    return AUTO_REVIEW_SKIP_SUMMARY[skipReason as AutoReviewSkipReason];
  }
  return skipReason;
}

export function resolvePullRequestAutoReviewSkipReason(args: {
  forceAiReview?: boolean | undefined;
  manifest: FocusManifest | null;
  isDraft: boolean;
  author: string | null;
  title: string;
  labels?: readonly string[] | undefined;
  changedPaths?: readonly string[] | undefined;
  addedLineCount?: number | undefined;
  changedFileCount?: number | undefined;
  baseRef: string | null;
  reviewedCommitCount?: number | undefined;
}): string | null {
  if (args.forceAiReview === true) return null;
  return evaluateAutoReviewSkipReason(resolveAutoReviewConfig(args.manifest), {
    isDraft: args.isDraft,
    author: args.author,
    title: args.title,
    labels: args.labels ?? [],
    changedPaths: args.changedPaths ?? [],
    addedLineCount: args.addedLineCount ?? 0,
    changedFileCount: args.changedFileCount ?? 0,
    baseRef: args.baseRef,
    reviewedCommitCount: args.reviewedCommitCount ?? 0,
  });
}

/** Fold `review.tone` into the repo-instructions slot alongside `review.instructions` so both inherit the same
 *  public-safe system append in the AI reviewer. Null/empty tone ⇒ instructions unchanged (byte-identical). (#2044) */
export function composeManifestReviewInstructions(instructions: string | null, tone: string | null): string | null {
  const toneText = tone?.trim() || null;
  const instructionText = instructions?.trim() || null;
  if (!toneText) return instructionText;
  const toneSection = `Review tone (maintainer voice brief — complements review.profile): ${toneText}`;
  if (!instructionText) return toneSection;
  return `${toneSection}\n\n${instructionText}`;
}

/** Resolve the AI-reviewer overrides (`review.profile` + `review.tone` + `review.security_focus` + `review.path_instructions` +
 *  `review.exclude_paths` + `review.path_filters` + `review.ai_model`) from a possibly-null manifest (null = load
 *  failure). A null manifest yields the byte-identical defaults. Centralized so the AI-review caller threads them
 *  in one place with the null-manifest branch covered here (unit-tested) rather than inline in the processor.
 *  (#review-profile / #review-tone / #review-security-focus / #review-path-instructions / #review-exclude-paths / #2043 / #selfhost-ai-model-override / #1956) */
export function resolveReviewPromptOverrides(manifest: FocusManifest | null): { profile: ReviewProfile | null; tone: string | null; securityFocus: boolean; inlineComments: boolean; suggestions: boolean; changedFilesSummary: boolean; effortScore: boolean; autoMergeSummary: boolean; impactMap: boolean; cultureProfile: boolean; findingCategories: boolean; inlineCommentsPerCategory: number | null; minFindingSeverity: ReviewFindingSeverity | null; maxFindings: MaxFindingsConfig; commentVerbosity: CommentVerbosity | null; e2eTestDelivery: E2eTestDeliveryMode | null; pathInstructions: ReviewPathInstruction[]; instructions: string | null; excludePaths: string[]; pathFilters: string[]; selfHostAiModel: SelfHostAiModelConfig } {
  // inlineComments resolves to a strict boolean — true ONLY when the manifest explicitly set review.inline_comments:
  // true; null/false/absent ⇒ false. `shouldRequestInlineFindings` (#4099) only ever checks `=== true`, so null
  // and false are functionally identical to it — collapsing here (matching every sibling field below) is simpler
  // than plumbing a tri-state through for a distinction nothing downstream actually consumes.
  // securityFocus resolves the same way — true ONLY when the manifest explicitly set review.security_focus: true.
  // suggestions resolves the same way (#1956) — the caller further ANDs it with the already-resolved
  // inlineComments gate, since a suggestion has nothing to attach to without an inline comment.
  // changedFilesSummary resolves the same way (#1957) — independent of inlineComments/suggestions; it only
  // needs the unified-comment convergence feature itself to be on (the caller's own outer gate).
  // effortScore resolves the same way (#1955) — like changedFilesSummary, it is deterministic/display-only
  // (never touches the AI prompt) and only needs the unified-comment convergence feature to be on.
  // impactMap resolves the same way (#2184) — true ONLY when the manifest explicitly set review.impact_map:
  // true. The caller ADDITIONALLY ANDs this with the global env kill-switch (isImpactMapEnabled), mirroring
  // how isRagEnabled gates review.rag-equivalent features — this manifest flag alone is necessary but not
  // sufficient to activate impact-map computation for a repo.
  // findingCategories resolves the same way (#1958) — like suggestions, the caller further ANDs it with the
  // already-resolved inlineComments gate, since a category has nothing to categorize without an inline finding.
  // commentVerbosity resolves the same way (#2047) — deterministic/display-only, independent of every other
  // knob here; absent (null) ⇒ the caller applies "normal" (byte-identical).
  // cultureProfile resolves the same way (#2995) — true ONLY when the manifest explicitly set
  // review.culture_profile: true. The caller ANDs this per-repo opt-in with the GITTENSORY_REVIEW_CULTURE_PROFILE
  // global kill-switch (mirrors how RAG/reputation/grounding compose a global flag with a per-repo override).
  // autoMergeSummary resolves the same way (#2051/#4147) — like changedFilesSummary/effortScore, it is
  // deterministic/display-only (never touches the AI prompt) and only needs the unified-comment convergence
  // feature itself to be on; the caller supplies the already-computed AutoMergeSummarySignals unconditionally
  // once this is true (no separate global kill-switch, matching changedFilesSummary/effortScore's shape).
  return { profile: manifest?.review.profile ?? null, tone: manifest?.review.tone ?? null, securityFocus: manifest?.review.securityFocus === true, inlineComments: manifest?.review.inlineComments === true, suggestions: manifest?.review.suggestions === true, changedFilesSummary: manifest?.review.changedFilesSummary === true, effortScore: manifest?.review.effortScore === true, autoMergeSummary: manifest?.review.autoMergeSummary === true, impactMap: manifest?.review.impactMap === true, cultureProfile: manifest?.review.cultureProfile === true, findingCategories: manifest?.review.findingCategories === true, inlineCommentsPerCategory: manifest?.review.inlineCommentsPerCategory ?? null, minFindingSeverity: manifest?.review.minFindingSeverity ?? null, maxFindings: manifest?.review.maxFindings ?? { ...EMPTY_MAX_FINDINGS_CONFIG }, commentVerbosity: manifest?.review.commentVerbosity ?? null, e2eTestDelivery: manifest?.review.e2eTestDelivery ?? null, pathInstructions: manifest?.review.pathInstructions ?? [], instructions: manifest?.review.instructions ?? null, excludePaths: manifest?.review.excludePaths ?? [], pathFilters: manifest?.review.pathFilters ?? [], selfHostAiModel: resolveReviewSelfHostAiModel(manifest) };
}

/** Resolve `review.memory` (#2179, config slice of #1964) from a possibly-null manifest (null = load failure ⇒
 *  manifest toggle reads as unset/false). Mirrors resolveReviewPromptOverrides's inlineComments resolution
 *  exactly — true ONLY when the manifest explicitly set review.memory: true; null/false/absent ⇒ false. The
 *  caller further ANDs this with the operator's GITTENSORY_REVIEW_MEMORY kill-switch via isReviewMemoryEnabled
 *  (src/review/review-memory-wire.ts) before ever reading the suppression store. */
export function resolveReviewMemoryManifestToggle(manifest: FocusManifest | null): boolean {
  return manifest?.review.reviewMemory === true;
}

/** Resolve `review.e2e_test_auto_trigger` (#4196, part of the #4189 epic) from a possibly-null manifest (null =
 *  load failure ⇒ reads as unset/false). Mirrors `resolveReviewMemoryManifestToggle` exactly — true ONLY when the
 *  manifest explicitly set `review.e2e_test_auto_trigger: true`; null/false/absent ⇒ false. The caller ADDITIONALLY
 *  requires `features.e2eTests` to already be enabled for this repo (via `resolveConvergedFeature`) — this toggle
 *  alone never activates generation, it only decides whether an already-enabled repo also gets the unprompted
 *  `manifest_missing_tests` auto-trigger on top of the maintainer-initiated command/checkbox paths. */
export function resolveE2eTestAutoTriggerManifestToggle(manifest: FocusManifest | null): boolean {
  return manifest?.review.e2eTestAutoTrigger === true;
}

/** Resolve `review.pre_merge_checks` from a possibly-null manifest (null = load failure ⇒ no checks). Centralized
 *  so the gate caller resolves them in one place with the null-manifest branch covered here (unit-tested) rather
 *  than inline in the processor. (#review-pre-merge-checks) */
export function resolveReviewPreMergeChecks(manifest: FocusManifest | null): PreMergeCheck[] {
  return manifest?.review.preMergeChecks ?? [];
}

/** Resolve `review.enrichment` analyzer toggles from a possibly-null manifest (null = load failure ⇒ no toggles ⇒
 *  the operator's default analyzer set runs unchanged). Centralized so the enrichment caller threads them in one
 *  place with the null-manifest branch covered here (unit-tested) rather than inline in the processor. (#2050) */
/** Resolve `review.auto_review` from a possibly-null manifest (null = load failure => no ignored authors). The
 *  runtime eligibility check then fails open instead of suppressing review output on an ambiguous manifest read.
 *  (#2060) */
export function resolveReviewAutoReviewConfig(manifest: FocusManifest | null): AutoReviewConfig {
  return manifest?.review.autoReview ?? { ...EMPTY_AUTO_REVIEW_CONFIG };
}

/** Resolve `review.ai_model` from a possibly-null manifest (null = load failure ⇒ no per-repo override). The
 *  self-host AI layer then falls back to its own global env vars / hardcoded defaults, same as an explicit
 *  all-null config — a manifest read failure never blocks a review, it just loses the per-repo override for
 *  that one pass. (#selfhost-ai-model-override) */
export function resolveReviewSelfHostAiModel(manifest: FocusManifest | null): SelfHostAiModelConfig {
  return manifest?.review.aiModel ?? { ...EMPTY_SELF_HOST_AI_MODEL_CONFIG };
}

/** Resolve `review.visual` from a possibly-null manifest (null = load failure ⇒ no per-repo override). The
 *  capture pipeline then falls back to GitHub-native preview discovery + automatic route inference, same as
 *  an explicit all-empty config — a manifest read failure never blocks a review or a capture attempt, it
 *  just loses the per-repo override for that one pass. (#3609 / #3610) */
export function resolveReviewVisualConfig(manifest: FocusManifest | null): VisualConfig {
  return manifest?.review.visual ?? { ...EMPTY_VISUAL_CONFIG };
}

export function resolveEnrichmentAnalyzerToggles(manifest: FocusManifest | null): Partial<Record<ReesAnalyzerName, boolean>> {
  return manifest?.review.enrichmentAnalyzers ?? {};
}

/** Load a repo's `review.enrichment` toggles fail-safely: a manifest load error is swallowed to `null`, so a broken
 *  or unreachable manifest degrades to no toggles ⇒ the operator's default analyzer set runs. The loader is injected
 *  so both the success and the load-failure path are unit-tested here rather than inline at the enrichment call
 *  site. (#2050) */
export async function resolveRepoEnrichmentToggles(loadManifest: () => Promise<FocusManifest>): Promise<Partial<Record<ReesAnalyzerName, boolean>>> {
  const manifest = await loadManifest().catch(() => null);
  return resolveEnrichmentAnalyzerToggles(manifest);
}

/** One per-repo review SKILL (#review-skills): a maintainer-maintained rubric module loaded from the container-private
 *  config dir (`<repo>/review/skills/*.md`). `when` is "always" (repo-wide) or a path glob / brace-list that gates it to
 *  matching changed files (cost: only relevant skills are injected). */
export type RepoReviewSkill = { name: string; when: string; body: string };
/** The per-repo review CONTEXT (#review-skills): an always-on `review/AGENTS.md` / `review/CLAUDE.md` guide + skills. */
export type RepoReviewContext = { guide: string | null; skills: RepoReviewSkill[] };

/** Hard cap on the injected per-repo review context — a cost guard so a runaway guide/skills set can't bloat every
 *  prompt. The maintained files are concise by design; this only bites pathological inputs. */
const MAX_REVIEW_CONTEXT_CHARS = 16_000;

/** True when a skill's `when` applies to this PR: "always"/empty ⇒ yes; otherwise the (possibly brace-listed) glob must
 *  match at least one changed path. Reuses the manifest path matcher so it behaves exactly like path_instructions. */
function reviewSkillApplies(when: string, changedPaths: string[]): boolean {
  const w = when.trim();
  if (!w || w.toLowerCase() === "always") return true;
  const patterns = w
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return patterns.some((pat) =>
    changedPaths.some((path) => matchesManifestPath(path, pat)),
  );
}

/** Compose the per-repo review context into a prompt section (#review-skills): the always-on guide + every skill whose
 *  `when` applies to this PR's changed files. Bounded for cost. Null/empty ⇒ "" (byte-identical reviewer prompt). The
 *  caller folds the result into the `review.instructions` slot, so it inherits the same prompt wrapper + public-safe
 *  handling. */
export function composeRepoReviewContext(
  context: RepoReviewContext | null,
  changedPaths: string[],
): string {
  if (!context) return "";
  const parts: string[] = [];
  if (context.guide?.trim()) parts.push(context.guide.trim());
  for (const skill of context.skills) {
    if (reviewSkillApplies(skill.when, changedPaths) && skill.body.trim())
      parts.push(`## skill: ${skill.name}\n${skill.body.trim()}`);
  }
  if (parts.length === 0) return "";
  const joined = parts.join("\n\n");
  return joined.length > MAX_REVIEW_CONTEXT_CHARS
    ? joined.slice(0, MAX_REVIEW_CONTEXT_CHARS)
    : joined;
}

/** Filter a PR's changed files down to the set the AI review should see — dropping any whose path matches a
 *  `review.exclude_paths` glob (generated/vendored/lockfiles). Empty `excludePaths` ⇒ the same array (byte-identical
 *  review). Pure; the gate/slop/secret-scan operate on the unfiltered files. (#review-exclude-paths) */
export function excludeReviewPaths<T extends { path: string }>(files: T[], excludePaths: string[]): T[] {
  if (excludePaths.length === 0) return files;
  return files.filter((file) => !excludePaths.some((glob) => matchesManifestPath(file.path, glob)));
}

/** Apply `review.path_filters` after `exclude_paths`: include globs restrict the set; leading-`!` entries
 *  subtract matches. Empty `pathFilters` ⇒ the same array (byte-identical). (#2043) */
export function applyReviewPathFilters<T extends { path: string }>(files: T[], pathFilters: string[]): T[] {
  if (pathFilters.length === 0) return files;
  const includes: string[] = [];
  const negations: string[] = [];
  for (const entry of pathFilters) {
    if (entry.startsWith("!")) negations.push(entry.slice(1));
    else includes.push(entry);
  }
  let filtered = files;
  if (includes.length > 0) {
    filtered = filtered.filter((file) => includes.some((glob) => matchesManifestPath(file.path, glob)));
  }
  if (negations.length > 0) {
    filtered = filtered.filter((file) => !negations.some((glob) => matchesManifestPath(file.path, glob)));
  }
  return filtered;
}

/** Filter changed files for the AI review path: drop `exclude_paths`, then apply `path_filters`. (#2043) */
export function filterReviewFilesForAi<T extends { path: string }>(
  files: T[],
  excludePaths: string[],
  pathFilters: string[],
): T[] {
  return applyReviewPathFilters(excludeReviewPaths(files, excludePaths), pathFilters);
}

/**
 * Apply the typed `gate:` alias's overrides onto already-spread effective settings, mutating `effective` in
 * place. Split out of resolveEffectiveSettings purely for readability — this stays the ONLY place a `gate.*`
 * field maps onto its `RepositorySettings` counterpart. `gate:` still WINS over an overlapping `settings:`
 * value (the caller runs this AFTER the `{ ...dbSettings, ...manifest.settings }` spread), matching the
 * documented precedence (self-hosting-configuration docs: "the typed gate: block ... wins over the generic
 * settings: block for those same fields"). Every field here is independently null-gated — a `gate:` field
 * absent from the parsed manifest is `null` (see parseGateConfig below) and leaves `effective` untouched, so a
 * repo with no `gate:` block resolves byte-identically to before this was split out.
 */
function applyGateConfigOverrides(effective: RepositorySettings, gate: FocusManifestGateConfig): void {
  // reviewCheckMode (#2852) resolution: explicit `gate.checkMode` is the most-specific signal and always wins
  // when set. Otherwise fall back to the legacy `gate.enabled` boolean alias, mapped symmetrically so it keeps
  // its historical effect (true -> the check publishes and may be required; false -> it never publishes). When
  // NEITHER is set, `effective.reviewCheckMode` already holds `settings.reviewCheckMode` (yml `settings:`
  // override, else the DB value) from the caller's spread.
  if (gate.checkMode !== null) effective.reviewCheckMode = gate.checkMode;
  else if (gate.enabled !== null) effective.reviewCheckMode = gate.enabled ? "required" : "disabled";
  // #4618: gateCheckMode is a computed read-back value only -- always re-derive it from the reviewCheckMode
  // just resolved above (not from gate.enabled alone), so it stays correct even when only gate.checkMode was
  // the field actually set in the manifest.
  effective.gateCheckMode = effective.reviewCheckMode === "disabled" ? "off" : "enabled";
  if (gate.pack !== null) effective.gatePack = gate.pack;
  if (gate.linkedIssue !== null) effective.linkedIssueGateMode = gate.linkedIssue;
  if (gate.duplicates !== null) effective.duplicatePrGateMode = gate.duplicates;
  if (gate.readinessMode !== null) effective.qualityGateMode = gate.readinessMode;
  if (gate.readinessMinScore !== null) effective.qualityGateMinScore = gate.readinessMinScore;
  if (gate.sizeMode !== null) effective.sizeGateMode = gate.sizeMode;
  if (gate.lockfileIntegrityMode !== null) effective.lockfileIntegrityGateMode = gate.lockfileIntegrityMode;
  if (gate.slopMode !== null) effective.slopGateMode = gate.slopMode;
  if (gate.slopMinScore !== null) effective.slopGateMinScore = gate.slopMinScore;
  if (gate.slopAiAdvisory !== null) effective.slopAiAdvisory = gate.slopAiAdvisory;
  if (gate.aiReviewMode !== null) effective.aiReviewMode = gate.aiReviewMode;
  if (gate.aiReviewByok !== null) effective.aiReviewByok = gate.aiReviewByok;
  if (gate.aiReviewProvider !== null) effective.aiReviewProvider = gate.aiReviewProvider;
  if (gate.aiReviewModel !== null) effective.aiReviewModel = gate.aiReviewModel;
  if (gate.aiReviewAllAuthors !== null) effective.aiReviewAllAuthors = gate.aiReviewAllAuthors;
  if (gate.aiReviewCloseConfidence !== null) effective.aiReviewCloseConfidence = gate.aiReviewCloseConfidence;
  if (gate.aiReviewLowConfidenceDisposition !== null) effective.aiReviewLowConfidenceDisposition = gate.aiReviewLowConfidenceDisposition;
  // Dual-AI combine/onMerge/reviewers overrides (#2567) are projected onto `effective` unclamped here — they are
  // a REFINEMENT of the operator's AI_REVIEW_PLAN, not a replacement for it, so the actual operator-floor clamp
  // (onMerge can only TIGHTEN, never loosen) happens where both the per-repo value AND the operator's plan are
  // visible: `resolveEffectiveAiReviewOnMerge` in services/ai-review.ts, called from the review call site. This
  // resolver has no access to `env.AI_REVIEW_PLAN`, so it cannot itself enforce the floor.
  if (gate.aiReviewCombine !== null) effective.aiReviewCombine = gate.aiReviewCombine;
  if (gate.aiReviewOnMerge !== null) effective.aiReviewOnMerge = gate.aiReviewOnMerge;
  if (gate.aiReviewReviewers !== null) effective.aiReviewReviewers = gate.aiReviewReviewers;
  if (gate.mergeReadiness !== null) effective.mergeReadinessGateMode = gate.mergeReadiness;
  if (gate.manifestPolicy !== null) effective.manifestPolicyGateMode = gate.manifestPolicy;
  if (gate.selfAuthoredLinkedIssue !== null) effective.selfAuthoredLinkedIssueGateMode = gate.selfAuthoredLinkedIssue;
  if (gate.linkedIssueSatisfaction !== null) effective.linkedIssueSatisfactionGateMode = gate.linkedIssueSatisfaction;
  if (gate.dryRun !== null) effective.gateDryRun = gate.dryRun;
  if (gate.firstTimeContributorGrace !== null) effective.firstTimeContributorGrace = gate.firstTimeContributorGrace;
  if (gate.premergeContentRecheck !== null) effective.premergeContentRecheck = gate.premergeContentRecheck;
  if (gate.requireFreshRebaseWindowMinutes !== null) effective.requireFreshRebaseWindowMinutes = gate.requireFreshRebaseWindowMinutes;
  if (gate.claMode !== null) effective.claGateMode = gate.claMode;
  if (gate.claConsentPhrase !== null) effective.claConsentPhrase = gate.claConsentPhrase;
  if (gate.claCheckRunName !== null) effective.claCheckRunName = gate.claCheckRunName;
  if (gate.claCheckRunAppSlug !== null) effective.claCheckRunAppSlug = gate.claCheckRunAppSlug;
  if (gate.expectedCiContexts !== null) effective.expectedCiContexts = gate.expectedCiContexts;
  if (gate.copycatMode !== null) effective.copycatGateMode = gate.copycatMode;
  if (gate.copycatMinScore !== null) effective.copycatGateMinScore = gate.copycatMinScore;
}

/**
 * Resolve the EFFECTIVE repository settings a webhook should act on: `.gittensory.yml` > DB settings >
 * safe defaults. The generic `settings:` override applies first; the friendly `gate:` alias then wins
 * for its fields. This single resolver makes the whole gittensory configuration — gate on/off, blocker
 * modes, comments, labels, surface, audience — controllable from the repo's `.gittensory.yml`.
 */
export function resolveEffectiveSettings(
  dbSettings: RepositorySettings,
  manifest: FocusManifest,
  sharedContributorBlacklist: RepositorySettings["contributorBlacklist"] = [],
): RepositorySettings {
  // `typeLabels`/`linkedIssueLabelPropagation`/`linkedIssueHardRules` are parsed as SPARSE partials (see
  // parseFocusManifest above),
  // unlike every other `manifest.settings` field, which is always a complete value ready to overlay the DB
  // value wholesale via the spread below. Pull them out of the spread and merge each field individually,
  // manifest override > DB value > built-in default, so a `.gittensory.yml` naming only one key (e.g.
  // `typeLabels.priority`) can never silently reset the others back to the built-in default and discard a
  // DB-customized value (#priority-linked-issue-gate), and an arbitrary custom category (e.g. `security`)
  // layers in alongside the DB value rather than requiring it too (#label-modularity).
  const {
    typeLabels: typeLabelsOverride,
    linkedIssueLabelPropagation: linkedIssueLabelPropagationOverride,
    linkedIssueHardRules: linkedIssueHardRulesOverride,
    unlinkedIssueGuardrail: unlinkedIssueGuardrailOverride,
    screenshotTableGate: screenshotTableGateOverride,
    advisoryAiRouting: advisoryAiRoutingOverride,
    ...restManifestSettings
  } = manifest.settings;
  const effective: RepositorySettings = { ...dbSettings, ...restManifestSettings };
  if (typeLabelsOverride !== undefined) {
    // `null` is parseFocusManifest's distinct signal for a literal `typeLabels: {}` -- a deliberate
    // "zero configured categories for this repo" that REPLACES the DB value wholesale, rather than a
    // sparse override merged over it (#label-modularity). Any other (possibly-empty-if-all-invalid)
    // object is a sparse layer: its present keys win, every other key (built-in or custom) is inherited
    // from the DB value -- a plain object spread generalizes the old per-key `?? ` merge to an arbitrary
    // key set for free, and an override with zero surviving keys (e.g. every named key failed validation)
    // spreads in nothing, leaving the DB value completely unchanged.
    // The cast is safe: every key parseFocusManifest actually sets on the sparse override already
    // passed normalizeTypeLabelSet's non-empty-string validation (see the sparse-copy loop above), so
    // no value here is ever `undefined` at runtime -- only `Partial<PrTypeLabelSet>`'s TYPE (not its
    // actual contents) admits that possibility.
    effective.typeLabels = typeLabelsOverride === null ? {} : ({ ...(dbSettings.typeLabels ?? DEFAULT_TYPE_LABELS), ...typeLabelsOverride } as PrTypeLabelSet);
  }
  if (linkedIssueLabelPropagationOverride !== undefined) {
    const base = dbSettings.linkedIssueLabelPropagation ?? DEFAULT_LINKED_ISSUE_LABEL_PROPAGATION;
    effective.linkedIssueLabelPropagation = {
      enabled: linkedIssueLabelPropagationOverride.enabled ?? base.enabled,
      mode: linkedIssueLabelPropagationOverride.mode ?? base.mode,
      mappings: linkedIssueLabelPropagationOverride.mappings ?? base.mappings,
    };
  }
  if (linkedIssueHardRulesOverride !== undefined) {
    const base = dbSettings.linkedIssueHardRules ?? DEFAULT_LINKED_ISSUE_HARD_RULES;
    effective.linkedIssueHardRules = {
      ownerAssignedClose: linkedIssueHardRulesOverride.ownerAssignedClose ?? base.ownerAssignedClose,
      assignedIssueClose: linkedIssueHardRulesOverride.assignedIssueClose ?? base.assignedIssueClose,
      missingPointLabelClose: linkedIssueHardRulesOverride.missingPointLabelClose ?? base.missingPointLabelClose,
      maintainerOnlyLabelClose: linkedIssueHardRulesOverride.maintainerOnlyLabelClose ?? base.maintainerOnlyLabelClose,
      pointBearingLabels: linkedIssueHardRulesOverride.pointBearingLabels ?? base.pointBearingLabels,
      maintainerOnlyLabels: linkedIssueHardRulesOverride.maintainerOnlyLabels ?? base.maintainerOnlyLabels,
      defaultLabelRepo: linkedIssueHardRulesOverride.defaultLabelRepo ?? base.defaultLabelRepo,
      verifyBeforeClose: linkedIssueHardRulesOverride.verifyBeforeClose ?? base.verifyBeforeClose,
      closeDelaySeconds: linkedIssueHardRulesOverride.closeDelaySeconds ?? base.closeDelaySeconds,
    };
  }
  if (unlinkedIssueGuardrailOverride !== undefined) {
    const base = dbSettings.unlinkedIssueGuardrail ?? DEFAULT_UNLINKED_ISSUE_GUARDRAIL;
    effective.unlinkedIssueGuardrail = {
      mode: unlinkedIssueGuardrailOverride.mode ?? base.mode,
      minConfidence: unlinkedIssueGuardrailOverride.minConfidence ?? base.minConfidence,
    };
  }
  if (screenshotTableGateOverride !== undefined) {
    const base = dbSettings.screenshotTableGate ?? DEFAULT_SCREENSHOT_TABLE_GATE;
    effective.screenshotTableGate = {
      enabled: screenshotTableGateOverride.enabled ?? base.enabled,
      whenLabels: screenshotTableGateOverride.whenLabels ?? base.whenLabels,
      whenPaths: screenshotTableGateOverride.whenPaths ?? base.whenPaths,
      action: screenshotTableGateOverride.action ?? base.action,
      requireViewports: screenshotTableGateOverride.requireViewports ?? base.requireViewports,
      requireThemes: screenshotTableGateOverride.requireThemes ?? base.requireThemes,
      message: screenshotTableGateOverride.message ?? base.message,
      skillFileUrl: screenshotTableGateOverride.skillFileUrl ?? base.skillFileUrl,
    };
  }
  if (advisoryAiRoutingOverride !== undefined) {
    const base = dbSettings.advisoryAiRouting ?? DEFAULT_ADVISORY_AI_ROUTING;
    effective.advisoryAiRouting = {
      slop: advisoryAiRoutingOverride.slop ?? base.slop,
      e2eTestGen: advisoryAiRoutingOverride.e2eTestGen ?? base.e2eTestGen,
      planner: advisoryAiRoutingOverride.planner ?? base.planner,
      summaries: advisoryAiRoutingOverride.summaries ?? base.summaries,
      chatQa: advisoryAiRoutingOverride.chatQa ?? base.chatQa,
      chatQaFrontierFallback: advisoryAiRoutingOverride.chatQaFrontierFallback ?? base.chatQaFrontierFallback,
      intentRouting: advisoryAiRoutingOverride.intentRouting ?? base.intentRouting,
    };
  }
  applyGateConfigOverrides(effective, manifest.gate);
  // #4149: `review.linkedIssueSatisfaction` (#2173) is a near-identically-named but functionally distinct
  // phantom field -- parsed, but until now never wired to the real DB-backed gate
  // (linkedIssueSatisfactionGateMode), unlike every other typed `gate.*` alias. Fold it in as a fallback:
  // `gate.linkedIssueSatisfaction` (applied above) always wins when set; otherwise an explicit
  // `review.linkedIssueSatisfaction` takes effect instead of being silently discarded, so a self-hoster who
  // sets either spelling gets the same real gate behavior.
  if (manifest.gate.linkedIssueSatisfaction === null && manifest.review.linkedIssueSatisfaction !== null) {
    effective.linkedIssueSatisfactionGateMode = manifest.review.linkedIssueSatisfaction;
  }
  // The dashboard "Require linked issue" toggle must not silently diverge from gate blocking: when the
  // boolean is on but linkedIssueGateMode is still off, treat it as a block requirement (#797).
  // #4618: the yml-only top-level `linkedIssuePolicy: required` knob gets the same promotion -- previously a
  // self-hoster who set ONLY this (never touching the differently-worded `gate.linkedIssue: block`) got an
  // advisory `manifest_linked_issue_required` nudge but no real gate blocker, a silent no-op that could only
  // be discovered by cross-referencing a completely different section of the config file.
  if ((effective.requireLinkedIssue || manifest.linkedIssuePolicy === "required") && effective.linkedIssueGateMode === "off") {
    effective.linkedIssueGateMode = "block";
  }
  // Readiness/quality can never hard-block a PR (buildQualityGateWarning is always advisory-severity;
  // isConfiguredGateBlocker has no branch for it). The write-time guards (the settings.qualityGateMode /
  // gate.readiness.mode parsers above, and the settings-write API routes) stop a NEW "block" value from being
  // introduced, but a repo whose DB row already has quality_gate_mode = "block" from before those guards
  // existed would still resolve to it here. Downgrade it at this single resolver too, so the EFFECTIVE settings
  // the gate/review pipeline AND the settings-preview dashboard read (both call this function) can never carry
  // a value that implies enforcement it doesn't have, regardless of when or where it was written (#2267).
  if (effective.qualityGateMode === "block") effective.qualityGateMode = "advisory";
  effective.contributorBlacklist = mergeContributorBlacklists(effective.contributorBlacklist ?? [], sharedContributorBlacklist);
  return effective;
}

function matchedPatterns(paths: string[], patterns: string[]): string[] {
  return patterns.filter((pattern) => paths.some((path) => matchesManifestPath(path, pattern)));
}

export function buildFocusManifestGuidance(args: {
  manifest: FocusManifest;
  changedPaths: string[];
  labels?: string[] | undefined;
  linkedIssueCount?: number | undefined;
  testFileCount?: number | undefined;
  passedValidationCount?: number | undefined;
  // Caller-computed (via hasClearNoIssueRationale in ../signals/engine, not imported here to avoid a
  // circular dependency -- engine.ts already imports FocusManifest types from this module): a linked-issue-
  // required/preferred manifest policy must not keep flagging a PR whose body already explains why no
  // issue is linked, same exemption the "Linked issue" review-panel signal already applies.
  hasNoIssueRationale?: boolean | undefined;
}): FocusManifestGuidance {
  const { manifest } = args;
  const changedPaths = args.changedPaths.filter((path) => typeof path === "string" && path.length > 0);
  const labels = (args.labels ?? []).map((label) => label.toLowerCase());
  const linkedIssueCount = Math.max(0, args.linkedIssueCount ?? 0);
  const hasNoIssueRationale = args.hasNoIssueRationale ?? false;
  const testFileCount = Math.max(0, args.testFileCount ?? 0);
  const passedValidationCount = Math.max(0, args.passedValidationCount ?? 0);

  const matchedWantedPaths = matchedPatterns(changedPaths, manifest.wantedPaths);
  const preferredLabelHits = manifest.preferredLabels.filter((label) => labels.includes(label.toLowerCase()));

  const findings: FocusManifestFinding[] = [];
  const publicNextSteps: string[] = [];

  if (!manifest.present) {
    for (const warning of manifest.warnings) {
      findings.push({ code: "manifest_malformed", severity: "info", title: "Maintainer focus manifest not applied", detail: warning });
    }
    return {
      present: false,
      source: manifest.source,
      linkedIssuePolicy: manifest.linkedIssuePolicy,
      issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
      matchedWantedPaths: [],
      preferredLabelHits: [],
      findings,
      publicNextSteps: [],
      warnings: manifest.warnings,
      summary: "No maintainer focus manifest applied; using deterministic signals only.",
    };
  }

  if (manifest.wantedPaths.length > 0 && matchedWantedPaths.length === 0 && changedPaths.length > 0) {
    findings.push({
      code: "manifest_off_focus",
      severity: "warning",
      title: "Change is outside maintainer-wanted areas",
      detail: `No changed path matches the maintainer-wanted patterns (${manifest.wantedPaths.slice(0, 5).join(", ")}).`,
      action: "Refocus the change onto a maintainer-wanted area or explain why this out-of-focus work is needed.",
    });
    publicNextSteps.push("Refocus onto the maintainer-wanted areas, or explain why this out-of-focus change is needed.");
  }

  if (matchedWantedPaths.length > 0) {
    findings.push({
      code: "manifest_preferred_path",
      severity: "info",
      title: "Change aligns with maintainer-wanted areas",
      detail: `Changed paths match maintainer-wanted patterns: ${matchedWantedPaths.slice(0, 5).join(", ")}.`,
    });
    publicNextSteps.push("Changed paths align with the maintainer's wanted areas for this repo.");
  }

  if (manifest.preferredLabels.length > 0 && preferredLabelHits.length === 0) {
    findings.push({
      code: "manifest_missing_preferred_label",
      severity: "info",
      title: "No maintainer-preferred label applied",
      detail: `Maintainer prefers labels: ${manifest.preferredLabels.slice(0, 5).join(", ")}.`,
      action: "Consider applying a maintainer-preferred label so triage stays aligned.",
    });
    publicNextSteps.push(`Consider a maintainer-preferred label (${manifest.preferredLabels.slice(0, 3).join(", ")}).`);
  }

  if (manifest.linkedIssuePolicy === "required" && linkedIssueCount === 0 && !hasNoIssueRationale) {
    findings.push({
      code: "manifest_linked_issue_required",
      severity: "warning",
      title: "Maintainer requires a linked issue",
      detail: "This repo's maintainer focus manifest requires every PR to reference a tracked issue.",
      action: "Link the relevant issue (for example `Closes #123`) before opening the PR.",
    });
    publicNextSteps.push("Link the relevant tracked issue; the maintainer requires linked issues on PRs.");
  } else if (manifest.linkedIssuePolicy === "preferred" && linkedIssueCount === 0) {
    findings.push({
      code: "manifest_linked_issue_preferred",
      severity: "info",
      title: "Maintainer prefers a linked issue",
      detail: "This repo's maintainer focus manifest prefers PRs to reference a tracked issue.",
      action: "Link a tracked issue if one exists.",
    });
    publicNextSteps.push("Link a tracked issue if one exists; the maintainer prefers linked issues.");
  }

  if (manifest.testExpectations.length > 0 && testFileCount === 0 && passedValidationCount === 0) {
    const safeExpectations = manifest.testExpectations.filter(isFocusManifestPublicSafe).slice(0, 3);
    const expectationDetail = safeExpectations.length > 0 ? ` Expected evidence: ${safeExpectations.join("; ")}.` : "";
    findings.push({
      code: "manifest_missing_tests",
      severity: "warning",
      title: "Configured validation evidence missing",
      detail: `No changed test files or passing validation evidence were detected for this PR.${expectationDetail}`,
      action: "Add regression/invariant coverage, update relevant tests, or attach passing validation output that satisfies the repo's configured expectations.",
    });
    publicNextSteps.push("Add relevant tests or passing validation evidence that matches the repo's configured expectations.");
  }

  if (manifest.issueDiscoveryPolicy === "discouraged") {
    findings.push({
      code: "manifest_issue_discovery_discouraged",
      severity: "info",
      title: "Maintainer discourages issue-discovery reports",
      detail: "This repo's maintainer focus manifest discourages new issue-discovery reports; prefer direct fixes.",
      action: "Prefer a direct PR over filing a new issue-discovery report here.",
    });
    publicNextSteps.push("This repo prefers direct fixes over new issue-discovery reports.");
  }

  const safePublicNotes = manifest.publicNotes.filter(isFocusManifestPublicSafe);
  const safeNextSteps = [...new Set([...publicNextSteps, ...safePublicNotes])].filter(isFocusManifestPublicSafe);

  return {
    present: true,
    source: manifest.source,
    linkedIssuePolicy: manifest.linkedIssuePolicy,
    issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
    matchedWantedPaths,
    preferredLabelHits,
    findings,
    publicNextSteps: safeNextSteps,
    warnings: manifest.warnings,
    summary: summarize(manifest, matchedWantedPaths),
  };
}

function summarize(manifest: FocusManifest, wanted: string[]): string {
  if (wanted.length > 0) return "Maintainer focus manifest: change aligns with a wanted area.";
  if (manifest.wantedPaths.length > 0) return "Maintainer focus manifest: change is outside the wanted areas.";
  return "Maintainer focus manifest applied with no path-specific verdict.";
}

export type ContributionLanePreference = "preferred" | "neutral" | "discouraged";

export type ContributionLanes = {
  present: boolean;
  source: FocusManifestSource;
  directPrLane: ContributionLanePreference;
  issueDiscoveryLane: ContributionLanePreference;
  preferredEntryPaths: string[];
  discouragedEntryPaths: string[];
  validationExpectations: string[];
  issueEntryGuidance: string[];
  prEntryGuidance: string[];
  guidanceText: string[];
  warnings: string[];
  summary: string;
};

/**
 * Derive public-safe {@link ContributionLanes} from a focus manifest. Output is
 * deterministic: identical manifests produce identical lanes. No private scoring,
 * reward context, or trust data is included.
 */
export function deriveContributionLanes(manifest: FocusManifest): ContributionLanes {
  if (!manifest.present) {
    return {
      present: false,
      source: manifest.source,
      directPrLane: "neutral",
      issueDiscoveryLane: "neutral",
      preferredEntryPaths: [],
      discouragedEntryPaths: [],
      validationExpectations: [],
      issueEntryGuidance: [],
      prEntryGuidance: [],
      guidanceText: [],
      warnings: manifest.warnings,
      summary: "No maintainer focus manifest; contribution lanes are not constrained (using neutral lane defaults).",
    };
  }

  const safeWanted = manifest.wantedPaths.filter(isFocusManifestPublicSafe);
  const safePublicNotes = manifest.publicNotes.filter(isFocusManifestPublicSafe);

  const validationExpectations: string[] = [];
  if (manifest.linkedIssuePolicy === "required") validationExpectations.push("Link a tracked issue before opening a PR.");
  else if (manifest.linkedIssuePolicy === "preferred") validationExpectations.push("Link a tracked issue if one exists.");
  for (const e of manifest.testExpectations) {
    if (isFocusManifestPublicSafe(e)) validationExpectations.push(e);
  }

  const directPrLane: ContributionLanePreference =
    manifest.issueDiscoveryPolicy === "encouraged" ? "discouraged"
    : safeWanted.length > 0 ? "preferred"
    : "neutral";

  const issueDiscoveryLane: ContributionLanePreference =
    manifest.issueDiscoveryPolicy === "encouraged" ? "preferred"
    : manifest.issueDiscoveryPolicy === "discouraged" ? "discouraged"
    : "neutral";

  const issueEntryGuidance: string[] = [];
  if (manifest.issueDiscoveryPolicy === "encouraged") {
    issueEntryGuidance.push("Issue discovery reports are welcomed; search for gaps before opening a PR.");
  } else if (manifest.issueDiscoveryPolicy === "discouraged") {
    issueEntryGuidance.push("Prefer direct fixes over new issue reports; this repo discourages issue-discovery submissions.");
  }
  if (manifest.linkedIssuePolicy === "required") {
    issueEntryGuidance.push("Issues must be linked to a PR before it is opened.");
  } else if (manifest.linkedIssuePolicy === "preferred") {
    issueEntryGuidance.push("Link an existing issue to your PR when one is available.");
  }

  const prEntryGuidance: string[] = [];
  if (safeWanted.length > 0) {
    prEntryGuidance.push(`Focus changes on maintainer-wanted areas: ${manifest.wantedPaths.slice(0, 5).join(", ")}.`);
  }
  if (manifest.preferredLabels.length > 0) {
    const safeLabels = manifest.preferredLabels.filter(isFocusManifestPublicSafe);
    if (safeLabels.length > 0) {
      prEntryGuidance.push(`Apply a maintainer-preferred label to your PR: ${safeLabels.slice(0, 3).join(", ")}.`);
    }
  }
  prEntryGuidance.push(...safePublicNotes);
  const safeprEntryGuidance = [...new Set(prEntryGuidance)].filter(isFocusManifestPublicSafe);

  const guidanceText: string[] = [];
  if (manifest.linkedIssuePolicy === "required") {
    guidanceText.push("Link a tracked issue before opening a pull request.");
  } else if (manifest.linkedIssuePolicy === "preferred") {
    guidanceText.push("Linking a tracked issue is preferred before opening a pull request.");
  }
  if (manifest.preferredLabels.length > 0) {
    const safeLabels = manifest.preferredLabels.filter(isFocusManifestPublicSafe);
    if (safeLabels.length > 0) {
      guidanceText.push(`Apply a maintainer-preferred label: ${safeLabels.slice(0, 3).join(", ")}.`);
    }
  }
  guidanceText.push(...safePublicNotes);

  const warnings: string[] = [];
  if (safeWanted.length === 0 && manifest.preferredLabels.length === 0) {
    warnings.push("Contribution scope is unclear; focus manifest lacks wanted paths and preferred labels.");
  }
  if (manifest.testExpectations.filter(isFocusManifestPublicSafe).length === 0) {
    warnings.push("Validation expectations are not defined in the focus manifest.");
  }

  const summary = buildLanesSummary(manifest, directPrLane, issueDiscoveryLane);

  return {
    present: true,
    source: manifest.source,
    directPrLane,
    issueDiscoveryLane,
    preferredEntryPaths: safeWanted,
    discouragedEntryPaths: [],
    validationExpectations,
    issueEntryGuidance: issueEntryGuidance.filter(isFocusManifestPublicSafe),
    prEntryGuidance: safeprEntryGuidance,
    guidanceText: guidanceText.filter(isFocusManifestPublicSafe),
    warnings,
    summary,
  };
}

function buildLanesSummary(manifest: FocusManifest, directPrLane: ContributionLanePreference, issueDiscoveryLane: ContributionLanePreference): string {
  if (issueDiscoveryLane === "preferred" && directPrLane === "discouraged") return "Issue-discovery is the preferred contribution mode for this repo.";
  if (issueDiscoveryLane === "discouraged" && manifest.wantedPaths.length > 0) return "Direct PRs focused on the wanted areas are the preferred contribution mode.";
  if (directPrLane === "preferred") return "Direct PRs on the maintainer-wanted areas are preferred.";
  if (issueDiscoveryLane === "discouraged") return "Direct PRs are preferred; issue-discovery submissions are discouraged.";
  return "Contribution lanes are guided by the maintainer focus manifest.";
}
