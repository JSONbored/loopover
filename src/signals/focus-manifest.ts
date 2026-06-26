import { PUBLIC_LOCAL_PATH_INLINE } from "./redaction";
import { parse as parseYaml } from "yaml";
import type { GatePolicyPack, GateRuleMode, JsonValue, RepositorySettings } from "../types";
import { normalizeAutonomyPolicy, normalizeAutoMaintainPolicy } from "../settings/autonomy";

export type FocusManifestSource = "repo_file" | "api_record" | "none";
export type FocusManifestLinkedIssuePolicy = "required" | "preferred" | "optional";
export type FocusManifestIssueDiscoveryPolicy = "encouraged" | "neutral" | "discouraged";

/**
 * Maintainer-authored gate configuration declared as code in `.gittensory.yml` under `gate:`. Each
 * field is `null` when the maintainer did not set it, so the resolver can layer the manifest OVER the
 * DB-backed RepositorySettings (manifest > DB > safe defaults) without clobbering unset values. All
 * of these flow through the SAME confirmed-contributor-gated `evaluateGateCheck` path — the manifest
 * only chooses which deterministic blockers are active, never who can be blocked. Turning the gate
 * itself on/off stays a repository setting (`gateCheckMode`); `.gittensory.yml gate:` refines the
 * blocker policy of an already-enabled gate.
 */
export type FocusManifestGateConfig = {
  present: boolean;
  enabled: boolean | null;
  pack: GatePolicyPack | null;
  linkedIssue: GateRuleMode | null;
  duplicates: GateRuleMode | null;
  readinessMode: GateRuleMode | null;
  readinessMinScore: number | null;
  slopMode: GateRuleMode | null;
  slopMinScore: number | null;
  slopAiAdvisory: boolean | null;
  aiReviewMode: GateRuleMode | null;
  aiReviewByok: boolean | null;
  aiReviewProvider: "anthropic" | "openai" | null;
  aiReviewModel: string | null;
  mergeReadiness: GateRuleMode | null;
  manifestPolicy: GateRuleMode | null;
  selfAuthoredLinkedIssue: GateRuleMode | null;
  firstTimeContributorGrace: boolean | null;
};

/**
 * Generic repository-settings override declared in `.gittensory.yml` under `settings:`. A partial of
 * {@link RepositorySettings} — every behaviour a maintainer can toggle in the dashboard can be set here
 * as code. Unset fields are omitted so the resolver layers it OVER the DB-backed settings
 * (`.gittensory.yml` > dashboard settings > safe defaults). The friendly `gate:` block is a typed alias
 * for the gate-related subset and wins over `settings:` for those fields.
 */
export type FocusManifestSettings = Partial<
  Pick<
    RepositorySettings,
    | "commentMode"
    | "publicAudienceMode"
    | "publicSignalLevel"
    | "checkRunMode"
    | "checkRunDetailLevel"
    | "gateCheckMode"
    | "linkedIssueGateMode"
    | "duplicatePrGateMode"
    | "selfAuthoredLinkedIssueGateMode"
    | "qualityGateMode"
    | "qualityGateMinScore"
    | "aiReviewMode"
    | "aiReviewByok"
    | "aiReviewProvider"
    | "aiReviewModel"
    | "autoLabelEnabled"
    | "gittensorLabel"
    | "createMissingLabel"
    | "publicSurface"
    | "includeMaintainerAuthors"
    | "requireLinkedIssue"
    | "backfillEnabled"
    | "privateTrustEnabled"
    | "autonomy"
    | "autoMaintain"
    | "agentPaused"
    | "agentDryRun"
  >
>;

/** Field keys for the public review-panel rows a maintainer can show/hide via `review.fields`. */
export const REVIEW_FIELD_KEYS = ["linkedIssue", "relatedWork", "reviewLoad", "validationEvidence", "openPrQueue", "contributorContext", "gateResult"] as const;
export type ReviewFieldKey = (typeof REVIEW_FIELD_KEYS)[number];

// `review.profile` (#review-profile): how nitpicky the AI maintainer review is. `chill` = surface only blocking
// defects (bugs/security/breakage), suppress style nits; `assertive` = also raise minor improvements & nits;
// `balanced` (default / absent) leaves the reviewer prompt byte-identical. A presentation knob only — it NEVER
// changes the gate verdict, only how much advisory detail the review write-up carries.
export const REVIEW_PROFILES = ["chill", "balanced", "assertive"] as const;
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];

/**
 * Maintainer overrides for the public review-panel CONTENT, declared under `review:`. Customizes the
 * panel without changing what gittensory measures: a custom public-safe footer lead line, a custom intro
 * note, and per-row show/hide toggles. The Gittensor attribution + register link is ALWAYS appended to
 * the footer regardless (the growth surface is preserved); maintainer text that fails the public-safe
 * filter is dropped, never published.
 */
export type FocusManifestReviewConfig = {
  present: boolean;
  footerText: string | null;
  note: string | null;
  fields: Partial<Record<ReviewFieldKey, boolean>>;
  /** `review.profile`: chill / balanced / assertive. null (absent) = balanced = byte-identical reviewer prompt. */
  profile: ReviewProfile | null;
  /** `review.path_instructions`: per-path natural-language guidance handed to the AI reviewer when the PR's
   *  changed files match the glob. Empty (default) ⇒ byte-identical reviewer prompt. (#review-path-instructions) */
  pathInstructions: ReviewPathInstruction[];
  /** `review.exclude_paths`: globs whose matching files are EXCLUDED from the AI review (diff + grounding + RAG)
   *  — generated/vendored/lockfiles the maintainer doesn't want reviewed. Empty (default) ⇒ every file is
   *  reviewed (byte-identical). Gate/slop/secret-scan are UNAFFECTED — this only narrows the AI review.
   *  (#review-exclude-paths) */
  excludePaths: string[];
  /** `review.pre_merge_checks`: maintainer-declared DETERMINISTIC content assertions (title/description must
   *  contain a phrase, a label must be present), optionally gated to a path glob. Each FAILED check surfaces an
   *  advisory finding; a check with `enforce: true` becomes a hard gate blocker. Empty (default) ⇒ no finding
   *  (byte-identical). No AI judgment is involved. (#review-pre-merge-checks) */
  preMergeChecks: PreMergeCheck[];
};

/** One `review.path_instructions[]` entry: a manifest path glob + the public-safe instructions to apply when a
 *  changed file matches it. */
export type ReviewPathInstruction = { path: string; instructions: string };

/** One `review.pre_merge_checks[]` entry — a DETERMINISTIC pre-merge assertion. `whenPaths` (empty ⇒ always
 *  applies) gates the check to PRs that touch a matching path. The check PASSES only when EVERY configured
 *  assertion holds: the PR title contains `titleContains`, the body contains `descriptionContains`, and the
 *  `requireLabel` label is present (case-insensitive substring / label match). `enforce` ⇒ a failure is a hard
 *  gate blocker; default (false) ⇒ advisory only. All strings are public-safe-filtered at parse time. */
export type PreMergeCheck = {
  name: string;
  whenPaths: string[];
  titleContains: string | null;
  descriptionContains: string | null;
  requireLabel: string | null;
  enforce: boolean;
};

// A hard cap so a hostile/huge manifest can't bloat the reviewer prompt (mirrors REVIEW_FIELD_KEYS discipline).
const MAX_PATH_INSTRUCTIONS = 50;

/**
 * Normalized maintainer focus manifest. Repo owners declare which work areas are wanted,
 * blocked, or preferred so Gittensory guidance can explain why a path is encouraged or
 * discouraged. `maintainerNotes` are private review context and must never reach a public
 * GitHub surface; `publicNotes` are explicitly opted into public output by the maintainer.
 */
export type FocusManifest = {
  present: boolean;
  source: FocusManifestSource;
  wantedPaths: string[];
  blockedPaths: string[];
  preferredLabels: string[];
  linkedIssuePolicy: FocusManifestLinkedIssuePolicy;
  testExpectations: string[];
  issueDiscoveryPolicy: FocusManifestIssueDiscoveryPolicy;
  maintainerNotes: string[];
  publicNotes: string[];
  gate: FocusManifestGateConfig;
  settings: FocusManifestSettings;
  review: FocusManifestReviewConfig;
  warnings: string[];
};

export type FocusManifestFinding = {
  code:
    | "manifest_blocked_path"
    | "manifest_off_focus"
    | "manifest_preferred_path"
    | "manifest_missing_preferred_label"
    | "manifest_linked_issue_required"
    | "manifest_linked_issue_preferred"
    | "manifest_missing_tests"
    | "manifest_issue_discovery_discouraged"
    | "manifest_malformed";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  action?: string | undefined;
};

export type FocusManifestGuidance = {
  present: boolean;
  source: FocusManifestSource;
  linkedIssuePolicy: FocusManifestLinkedIssuePolicy;
  issueDiscoveryPolicy: FocusManifestIssueDiscoveryPolicy;
  matchedWantedPaths: string[];
  matchedBlockedPaths: string[];
  preferredLabelHits: string[];
  findings: FocusManifestFinding[];
  publicNextSteps: string[];
  warnings: string[];
  summary: string;
};

const MAX_LIST_ITEMS = 200;
const MAX_ITEM_LENGTH = 300;
export const MAX_FOCUS_MANIFEST_BYTES = 64 * 1024;

const EMPTY_GATE_CONFIG: FocusManifestGateConfig = {
  present: false,
  enabled: null,
  pack: null,
  linkedIssue: null,
  duplicates: null,
  readinessMode: null,
  readinessMinScore: null,
  slopMode: null,
  slopMinScore: null,
  slopAiAdvisory: null,
  aiReviewMode: null,
  aiReviewByok: null,
  aiReviewProvider: null,
  aiReviewModel: null,
  mergeReadiness: null,
  manifestPolicy: null,
  selfAuthoredLinkedIssue: null,
  firstTimeContributorGrace: null,
};

const EMPTY_MANIFEST: FocusManifest = {
  present: false,
  source: "none",
  wantedPaths: [],
  blockedPaths: [],
  preferredLabels: [],
  linkedIssuePolicy: "optional",
  testExpectations: [],
  issueDiscoveryPolicy: "neutral",
  maintainerNotes: [],
  publicNotes: [],
  gate: { ...EMPTY_GATE_CONFIG },
  settings: {},
  review: { present: false, footerText: null, note: null, fields: {}, profile: null, pathInstructions: [], excludePaths: [], preMergeChecks: [] },
  warnings: [],
};

/**
 * Public-safe redaction guard shared with the local-branch packet renderer. Public manifest
 * text must not leak reward, wallet/key, ranking, or local filesystem path material.
 */
const FOCUS_MANIFEST_PUBLIC_UNSAFE = new RegExp(
  String.raw`\b(reward\w*|score\w*|wallets?|hotkeys?|coldkeys?|seed[-\s]?phrases?|mnemonics?|private[-\s]?keys?|farming|payouts?|rankings?|raw[-\s]?trust(?:[-\s]?scores?)?|trust[-\s]?scores?|private[-\s]?reviewability|reviewability(?:[-\s]?internals?)?|private[-\s]?scoreability|scoreability|public[-\s]?score[-\s]?(?:estimate|prediction|claim)s?|estimated[-\s]?scores?|score[-\s]?(?:estimate|prediction|preview)s?)\b|${PUBLIC_LOCAL_PATH_INLINE}`,
  "i",
);

export function isFocusManifestPublicSafe(text: string): boolean {
  return !FOCUS_MANIFEST_PUBLIC_UNSAFE.test(text);
}

function emptyManifest(source: FocusManifestSource, warnings: string[] = []): FocusManifest {
  return { ...EMPTY_MANIFEST, source, warnings, gate: { ...EMPTY_GATE_CONFIG }, settings: {}, review: { present: false, footerText: null, note: null, fields: {}, profile: null, pathInstructions: [], excludePaths: [], preMergeChecks: [] } };
}

function normalizeStringList(value: JsonValue | undefined, field: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest field "${field}" must be a list; ignoring a ${typeof value} value.`);
    return [];
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      warnings.push(`Manifest field "${field}" skipped a non-string entry.`);
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Truncate in place, then flow through the same de-dup and cap logic. Falling through (rather than
    // `continue`-ing) keeps over-long entries subject to both limits, so untrusted manifests cannot
    // bypass de-duplication or the MAX_LIST_ITEMS safety cap via pathological long entries.
    let normalized = trimmed;
    if (normalized.length > MAX_ITEM_LENGTH) {
      warnings.push(`Manifest field "${field}" truncated an over-long entry.`);
      normalized = normalized.slice(0, MAX_ITEM_LENGTH);
    }
    if (!result.includes(normalized)) result.push(normalized);
    if (result.length >= MAX_LIST_ITEMS) {
      warnings.push(`Manifest field "${field}" exceeded ${MAX_LIST_ITEMS} entries; extra entries ignored.`);
      break;
    }
  }
  return result;
}

function normalizeEnum<T extends string>(value: JsonValue | undefined, field: string, allowed: readonly T[], fallback: T, warnings: string[]): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    warnings.push(`Manifest field "${field}" must be one of ${allowed.join(", ")}; falling back to "${fallback}".`);
    return fallback;
  }
  return value as T;
}

function normalizeSource(raw: FocusManifestSource | undefined, value: JsonValue | undefined, warnings: string[]): FocusManifestSource {
  if (raw) return raw;
  return normalizeEnum<FocusManifestSource>(value, "source", ["repo_file", "api_record", "none"], "api_record", warnings);
}

function normalizeOptionalGateMode(value: JsonValue | undefined, field: string, warnings: string[]): GateRuleMode | null {
  if (value === undefined || value === null) return null;
  if (value === "off" || value === "advisory" || value === "block") return value;
  warnings.push(`Manifest gate field "${field}" must be one of off, advisory, block; ignoring "${String(value)}".`);
  return null;
}

function normalizeOptionalBoolean(value: JsonValue | undefined, field: string, warnings: string[]): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  warnings.push(`Manifest gate field "${field}" must be a boolean; ignoring a ${typeof value} value.`);
  return null;
}

function normalizeOptionalScore(value: JsonValue | undefined, field: string, warnings: string[]): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`Manifest gate field "${field}" must be a number between 0 and 100; ignoring it.`);
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Parse the optional `gate:` mapping. Every field stays `null` when unset so the resolver can layer
 * this OVER DB settings without clobbering. A nested `readiness: { mode, minScore }` block is accepted.
 */
function parseGateConfig(value: JsonValue | undefined, warnings: string[]): FocusManifestGateConfig {
  if (value === undefined || value === null) return { ...EMPTY_GATE_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Manifest field "gate" must be a mapping; ignoring it.`);
    return { ...EMPTY_GATE_CONFIG };
  }
  const record = value as Record<string, JsonValue>;
  const readiness = record.readiness;
  const readinessRecord = readiness !== null && typeof readiness === "object" && !Array.isArray(readiness) ? (readiness as Record<string, JsonValue>) : undefined;
  if (readiness !== undefined && readiness !== null && readinessRecord === undefined) {
    warnings.push(`Manifest gate field "gate.readiness" must be a mapping; ignoring it.`);
  }
  const aiReview = record.aiReview;
  const aiReviewRecord = aiReview !== null && typeof aiReview === "object" && !Array.isArray(aiReview) ? (aiReview as Record<string, JsonValue>) : undefined;
  if (aiReview !== undefined && aiReview !== null && aiReviewRecord === undefined) {
    warnings.push(`Manifest gate field "gate.aiReview" must be a mapping; ignoring it.`);
  }
  const slop = record.slop;
  const slopRecord = slop !== null && typeof slop === "object" && !Array.isArray(slop) ? (slop as Record<string, JsonValue>) : undefined;
  if (slop !== undefined && slop !== null && slopRecord === undefined) {
    warnings.push(`Manifest gate field "gate.slop" must be a mapping; ignoring it.`);
  }
  const gate: FocusManifestGateConfig = {
    present: false,
    enabled: normalizeOptionalBoolean(record.enabled, "gate.enabled", warnings),
    pack: normalizeOptionalEnum(record.pack, "gate.pack", ["gittensor", "oss-anti-slop"] as const, warnings),
    linkedIssue: normalizeOptionalGateMode(record.linkedIssue, "gate.linkedIssue", warnings),
    duplicates: normalizeOptionalGateMode(record.duplicates, "gate.duplicates", warnings),
    readinessMode: normalizeOptionalGateMode(readinessRecord?.mode, "gate.readiness.mode", warnings),
    readinessMinScore: normalizeOptionalScore(readinessRecord?.minScore, "gate.readiness.minScore", warnings),
    slopMode: normalizeOptionalGateMode(slopRecord?.mode, "gate.slop.mode", warnings),
    slopMinScore: normalizeOptionalScore(slopRecord?.minScore, "gate.slop.minScore", warnings),
    slopAiAdvisory: normalizeOptionalBoolean(slopRecord?.aiAdvisory, "gate.slop.aiAdvisory", warnings),
    aiReviewMode: normalizeOptionalGateMode(aiReviewRecord?.mode, "gate.aiReview.mode", warnings),
    aiReviewByok: normalizeOptionalBoolean(aiReviewRecord?.byok, "gate.aiReview.byok", warnings),
    aiReviewProvider: normalizeOptionalEnum(aiReviewRecord?.provider, "gate.aiReview.provider", ["anthropic", "openai"] as const, warnings),
    aiReviewModel: normalizeOptionalString(aiReviewRecord?.model, "gate.aiReview.model", warnings),
    mergeReadiness: normalizeOptionalGateMode(record.mergeReadiness, "gate.mergeReadiness", warnings),
    manifestPolicy: normalizeOptionalGateMode(record.manifestPolicy, "gate.manifestPolicy", warnings),
    selfAuthoredLinkedIssue: normalizeOptionalGateMode(record.selfAuthoredLinkedIssue, "gate.selfAuthoredLinkedIssue", warnings),
    firstTimeContributorGrace: normalizeOptionalBoolean(record.firstTimeContributorGrace, "gate.firstTimeContributorGrace", warnings),
  };
  gate.present =
    gate.enabled !== null ||
    gate.pack !== null ||
    gate.linkedIssue !== null ||
    gate.duplicates !== null ||
    gate.readinessMode !== null ||
    gate.readinessMinScore !== null ||
    gate.slopMode !== null ||
    gate.slopMinScore !== null ||
    gate.slopAiAdvisory !== null ||
    gate.aiReviewMode !== null ||
    gate.aiReviewByok !== null ||
    gate.aiReviewProvider !== null ||
    gate.aiReviewModel !== null ||
    gate.mergeReadiness !== null ||
    gate.manifestPolicy !== null ||
    gate.selfAuthoredLinkedIssue !== null ||
    gate.firstTimeContributorGrace !== null;
  return gate;
}

/**
 * Serialize a gate config back into the parse-compatible `gate:` shape so a cached manifest snapshot
 * round-trips through {@link parseGateConfig} unchanged. Returns null when nothing is configured.
 */
export function gateConfigToJson(gate: FocusManifestGateConfig): JsonValue {
  if (!gate.present) return null;
  const out: Record<string, JsonValue> = {};
  if (gate.enabled !== null) out.enabled = gate.enabled;
  if (gate.pack !== null) out.pack = gate.pack;
  if (gate.linkedIssue !== null) out.linkedIssue = gate.linkedIssue;
  if (gate.duplicates !== null) out.duplicates = gate.duplicates;
  if (gate.readinessMode !== null || gate.readinessMinScore !== null) {
    const readiness: Record<string, JsonValue> = {};
    if (gate.readinessMode !== null) readiness.mode = gate.readinessMode;
    if (gate.readinessMinScore !== null) readiness.minScore = gate.readinessMinScore;
    out.readiness = readiness;
  }
  if (gate.slopMode !== null || gate.slopMinScore !== null || gate.slopAiAdvisory !== null) {
    const slop: Record<string, JsonValue> = {};
    if (gate.slopMode !== null) slop.mode = gate.slopMode;
    if (gate.slopMinScore !== null) slop.minScore = gate.slopMinScore;
    if (gate.slopAiAdvisory !== null) slop.aiAdvisory = gate.slopAiAdvisory;
    out.slop = slop;
  }
  if (gate.aiReviewMode !== null || gate.aiReviewByok !== null || gate.aiReviewProvider !== null || gate.aiReviewModel !== null) {
    const aiReview: Record<string, JsonValue> = {};
    if (gate.aiReviewMode !== null) aiReview.mode = gate.aiReviewMode;
    if (gate.aiReviewByok !== null) aiReview.byok = gate.aiReviewByok;
    if (gate.aiReviewProvider !== null) aiReview.provider = gate.aiReviewProvider;
    if (gate.aiReviewModel !== null) aiReview.model = gate.aiReviewModel;
    out.aiReview = aiReview;
  }
  if (gate.mergeReadiness !== null) out.mergeReadiness = gate.mergeReadiness;
  if (gate.manifestPolicy !== null) out.manifestPolicy = gate.manifestPolicy;
  if (gate.selfAuthoredLinkedIssue !== null) out.selfAuthoredLinkedIssue = gate.selfAuthoredLinkedIssue;
  if (gate.firstTimeContributorGrace !== null) out.firstTimeContributorGrace = gate.firstTimeContributorGrace;
  return out;
}

function normalizeOptionalEnum<T extends string>(value: JsonValue | undefined, field: string, allowed: readonly T[], warnings: string[]): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  warnings.push(`Manifest settings field "${field}" must be one of ${allowed.join(", ")}; ignoring "${String(value)}".`);
  return null;
}

function normalizeOptionalString(value: JsonValue | undefined, field: string, warnings: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  warnings.push(`Manifest settings field "${field}" must be a non-empty string; ignoring it.`);
  return null;
}

/**
 * Parse the optional `settings:` mapping — a partial repository-settings override. Only recognized
 * fields are kept; unknown/invalid values are dropped with a warning and never throw.
 */
function parseSettingsOverride(value: JsonValue | undefined, warnings: string[]): FocusManifestSettings {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Manifest field "settings" must be a mapping; ignoring it.`);
    return {};
  }
  const r = value as Record<string, JsonValue>;
  const out: FocusManifestSettings = {};
  const commentMode = normalizeOptionalEnum(r.commentMode, "settings.commentMode", ["off", "detected_contributors_only", "all_prs"] as const, warnings);
  if (commentMode !== null) out.commentMode = commentMode;
  const publicAudienceMode = normalizeOptionalEnum(r.publicAudienceMode, "settings.publicAudienceMode", ["oss_maintainer", "gittensor_only"] as const, warnings);
  if (publicAudienceMode !== null) out.publicAudienceMode = publicAudienceMode;
  const publicSignalLevel = normalizeOptionalEnum(r.publicSignalLevel, "settings.publicSignalLevel", ["minimal", "standard"] as const, warnings);
  if (publicSignalLevel !== null) out.publicSignalLevel = publicSignalLevel;
  const checkRunMode = normalizeOptionalEnum(r.checkRunMode, "settings.checkRunMode", ["off", "enabled"] as const, warnings);
  if (checkRunMode !== null) out.checkRunMode = checkRunMode;
  const checkRunDetailLevel = normalizeOptionalEnum(r.checkRunDetailLevel, "settings.checkRunDetailLevel", ["minimal", "standard", "deep"] as const, warnings);
  if (checkRunDetailLevel !== null) out.checkRunDetailLevel = checkRunDetailLevel;
  const gateCheckMode = normalizeOptionalEnum(r.gateCheckMode, "settings.gateCheckMode", ["off", "enabled"] as const, warnings);
  if (gateCheckMode !== null) out.gateCheckMode = gateCheckMode;
  const linkedIssueGateMode = normalizeOptionalGateMode(r.linkedIssueGateMode, "settings.linkedIssueGateMode", warnings);
  if (linkedIssueGateMode !== null) out.linkedIssueGateMode = linkedIssueGateMode;
  const duplicatePrGateMode = normalizeOptionalGateMode(r.duplicatePrGateMode, "settings.duplicatePrGateMode", warnings);
  if (duplicatePrGateMode !== null) out.duplicatePrGateMode = duplicatePrGateMode;
  const selfAuthoredLinkedIssueGateMode = normalizeOptionalGateMode(r.selfAuthoredLinkedIssueGateMode, "settings.selfAuthoredLinkedIssueGateMode", warnings);
  if (selfAuthoredLinkedIssueGateMode !== null) out.selfAuthoredLinkedIssueGateMode = selfAuthoredLinkedIssueGateMode;
  const qualityGateMode = normalizeOptionalGateMode(r.qualityGateMode, "settings.qualityGateMode", warnings);
  if (qualityGateMode !== null) out.qualityGateMode = qualityGateMode;
  const qualityGateMinScore = normalizeOptionalScore(r.qualityGateMinScore, "settings.qualityGateMinScore", warnings);
  if (qualityGateMinScore !== null) out.qualityGateMinScore = qualityGateMinScore;
  const aiReviewMode = normalizeOptionalGateMode(r.aiReviewMode, "settings.aiReviewMode", warnings);
  if (aiReviewMode !== null) out.aiReviewMode = aiReviewMode;
  const aiReviewProvider = normalizeOptionalEnum(r.aiReviewProvider, "settings.aiReviewProvider", ["anthropic", "openai"] as const, warnings);
  if (aiReviewProvider !== null) out.aiReviewProvider = aiReviewProvider;
  const aiReviewModel = normalizeOptionalString(r.aiReviewModel, "settings.aiReviewModel", warnings);
  if (aiReviewModel !== null) out.aiReviewModel = aiReviewModel;
  const gittensorLabel = normalizeOptionalString(r.gittensorLabel, "settings.gittensorLabel", warnings);
  if (gittensorLabel !== null) out.gittensorLabel = gittensorLabel;
  const publicSurface = normalizeOptionalEnum(r.publicSurface, "settings.publicSurface", ["off", "comment_and_label", "comment_only", "label_only"] as const, warnings);
  if (publicSurface !== null) out.publicSurface = publicSurface;
  for (const key of ["aiReviewByok", "autoLabelEnabled", "createMissingLabel", "includeMaintainerAuthors", "requireLinkedIssue", "backfillEnabled", "privateTrustEnabled", "agentPaused", "agentDryRun"] as const) {
    const flag = normalizeOptionalBoolean(r[key], `settings.${key}`, warnings);
    if (flag !== null) out[key] = flag;
  }
  // Agent-layer autonomy dial (#773): `settings.autonomy` maps each action class to a level. Only set it
  // when at least one valid class→level pair survives normalization, so a malformed block never blanks the
  // DB-configured policy via the resolver's `{...dbSettings, ...manifest.settings}` overlay.
  if (r.autonomy !== undefined) {
    const autonomy = normalizeAutonomyPolicy(r.autonomy);
    if (Object.keys(autonomy).length > 0) out.autonomy = autonomy;
  }
  // Auto-maintain policy (#774): `settings.autoMaintain` declares the full policy (defaults fill any unset
  // field) and overlays the DB value via the resolver. Only a mapping is honoured; anything else is ignored.
  if (typeof r.autoMaintain === "object" && r.autoMaintain !== null && !Array.isArray(r.autoMaintain)) {
    out.autoMaintain = normalizeAutoMaintainPolicy(r.autoMaintain);
  }
  return out;
}

/** Serialize the settings override for the cache round-trip; returns null when nothing is set. */
export function settingsOverrideToJson(settings: FocusManifestSettings): JsonValue {
  if (Object.keys(settings).length === 0) return null;
  return { ...settings } as Record<string, JsonValue>;
}

/** A bounded, PUBLIC-SAFE maintainer string (footer/note). Trimmed, length-capped, and rejected with a
 *  warning if it contains any forbidden public term — it is then dropped, never published. */
function parsePublicSafeText(value: JsonValue | undefined, field: string, warnings: string[]): string | null {
  const text = normalizeOptionalString(value, field, warnings);
  if (text === null) return null;
  const bounded = text.length > MAX_ITEM_LENGTH ? text.slice(0, MAX_ITEM_LENGTH) : text;
  if (!isFocusManifestPublicSafe(bounded)) {
    warnings.push(`Manifest "${field}" contains content that is not public-safe; ignoring it.`);
    return null;
  }
  return bounded;
}

/**
 * Parse the optional `review:` block — maintainer overrides for the public review-panel content. Never
 * throws; invalid/unsafe values are dropped with warnings.
 */
function parseReviewConfig(value: JsonValue | undefined, warnings: string[]): FocusManifestReviewConfig {
  const empty: FocusManifestReviewConfig = { present: false, footerText: null, note: null, fields: {}, profile: null, pathInstructions: [], excludePaths: [], preMergeChecks: [] };
  if (value === undefined || value === null) return empty;
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Manifest field "review" must be a mapping; ignoring it.`);
    return empty;
  }
  const r = value as Record<string, JsonValue>;
  const footerRecord = r.footer !== null && typeof r.footer === "object" && !Array.isArray(r.footer) ? (r.footer as Record<string, JsonValue>) : undefined;
  if (r.footer !== undefined && r.footer !== null && footerRecord === undefined) warnings.push(`Manifest "review.footer" must be a mapping; ignoring it.`);
  const fieldsRecord = r.fields !== null && typeof r.fields === "object" && !Array.isArray(r.fields) ? (r.fields as Record<string, JsonValue>) : undefined;
  if (r.fields !== undefined && r.fields !== null && fieldsRecord === undefined) warnings.push(`Manifest "review.fields" must be a mapping; ignoring it.`);
  const fields: Partial<Record<ReviewFieldKey, boolean>> = {};
  if (fieldsRecord) {
    for (const key of REVIEW_FIELD_KEYS) {
      const flag = normalizeOptionalBoolean(fieldsRecord[key], `review.fields.${key}`, warnings);
      if (flag !== null) fields[key] = flag;
    }
  }
  const footerText = footerRecord ? parsePublicSafeText(footerRecord.text, "review.footer.text", warnings) : null;
  const note = parsePublicSafeText(r.note, "review.note", warnings);
  const profile = parseReviewProfile(r.profile, warnings);
  const pathInstructions = parseReviewPathInstructions(r.path_instructions, warnings);
  const excludePaths = parseReviewExcludePaths(r.exclude_paths, warnings);
  const preMergeChecks = parseReviewPreMergeChecks(r.pre_merge_checks, warnings);
  return {
    present:
      footerText !== null ||
      note !== null ||
      profile !== null ||
      pathInstructions.length > 0 ||
      excludePaths.length > 0 ||
      preMergeChecks.length > 0 ||
      Object.keys(fields).length > 0,
    footerText,
    note,
    fields,
    profile,
    pathInstructions,
    excludePaths,
    preMergeChecks,
  };
}

/** Parse `review.pre_merge_checks` — an array of DETERMINISTIC pre-merge assertions. Each entry needs a non-empty
 *  public-safe `name` and at least ONE assertion (`title_contains` / `description_contains` / `require_label`,
 *  each public-safe); `when_paths` (optional) gates the check to PRs touching a matching glob; `enforce` (default
 *  false) makes a failure a hard blocker. Invalid entries are dropped with a warning; capped at
 *  MAX_PATH_INSTRUCTIONS so a hostile manifest can't bloat the gate. (#review-pre-merge-checks) */
function parseReviewPreMergeChecks(value: JsonValue | undefined, warnings: string[]): PreMergeCheck[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "review.pre_merge_checks" must be a list of checks; ignoring it.`);
    return [];
  }
  const out: PreMergeCheck[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= MAX_PATH_INSTRUCTIONS) {
      warnings.push(`Manifest "review.pre_merge_checks" is capped at ${MAX_PATH_INSTRUCTIONS} entries; dropping the rest.`);
      break;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`Manifest "review.pre_merge_checks[${index}]" must be a mapping; ignoring it.`);
      continue;
    }
    const e = entry as Record<string, JsonValue>;
    if (e.name === undefined || e.name === null) {
      warnings.push(`Manifest "review.pre_merge_checks[${index}].name" is required; ignoring the entry.`);
      continue;
    }
    const name = parsePublicSafeText(e.name, `review.pre_merge_checks[${index}].name`, warnings);
    if (name === null) continue; // non-string / empty / not-public-safe → already warned
    const titleContains = e.title_contains === undefined || e.title_contains === null ? null : parsePublicSafeText(e.title_contains, `review.pre_merge_checks[${index}].title_contains`, warnings);
    const descriptionContains = e.description_contains === undefined || e.description_contains === null ? null : parsePublicSafeText(e.description_contains, `review.pre_merge_checks[${index}].description_contains`, warnings);
    const requireLabel = e.require_label === undefined || e.require_label === null ? null : parsePublicSafeText(e.require_label, `review.pre_merge_checks[${index}].require_label`, warnings);
    if (titleContains === null && descriptionContains === null && requireLabel === null) {
      warnings.push(`Manifest "review.pre_merge_checks[${index}]" needs at least one of title_contains / description_contains / require_label; ignoring it.`);
      continue;
    }
    const whenPaths = parseManifestGlobList(e.when_paths, `review.pre_merge_checks[${index}].when_paths`, warnings);
    const enforce = normalizeOptionalBoolean(e.enforce, `review.pre_merge_checks[${index}].enforce`, warnings) === true;
    out.push({ name, whenPaths, titleContains, descriptionContains, requireLabel, enforce });
  }
  return out;
}

/** Parse a manifest glob list (e.g. `review.exclude_paths`, a check's `when_paths`) — an array of non-empty
 *  string globs; blanks/non-strings are dropped with a warning. Capped at MAX_PATH_INSTRUCTIONS so a hostile
 *  manifest can't bloat the matcher. `fieldLabel` makes the warnings name the right field. */
function parseManifestGlobList(value: JsonValue | undefined, fieldLabel: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "${fieldLabel}" must be a list of path globs; ignoring it.`);
    return [];
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= MAX_PATH_INSTRUCTIONS) {
      warnings.push(`Manifest "${fieldLabel}" is capped at ${MAX_PATH_INSTRUCTIONS} entries; dropping the rest.`);
      break;
    }
    const glob = typeof entry === "string" ? entry.trim() : "";
    if (!glob) {
      warnings.push(`Manifest "${fieldLabel}[${index}]" must be a non-empty string; ignoring it.`);
      continue;
    }
    if (glob.length > MAX_ITEM_LENGTH) {
      warnings.push(`Manifest "${fieldLabel}[${index}]" exceeds ${MAX_ITEM_LENGTH} chars; ignoring it.`);
      continue;
    }
    out.push(glob);
  }
  return out;
}

/** Parse `review.exclude_paths` — globs whose matching files are excluded from the AI review. (#review-exclude-paths) */
function parseReviewExcludePaths(value: JsonValue | undefined, warnings: string[]): string[] {
  return parseManifestGlobList(value, "review.exclude_paths", warnings);
}

/** Parse `review.path_instructions` — an array of `{ path, instructions }` entries. Each must have a non-empty
 *  string `path` (a manifest glob) and PUBLIC-SAFE string `instructions`; invalid/unsafe entries are dropped with
 *  a warning. Capped at MAX_PATH_INSTRUCTIONS so a huge manifest can't bloat the reviewer prompt. */
function parseReviewPathInstructions(value: JsonValue | undefined, warnings: string[]): ReviewPathInstruction[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push(`Manifest "review.path_instructions" must be a list of { path, instructions }; ignoring it.`);
    return [];
  }
  const out: ReviewPathInstruction[] = [];
  for (const [index, entry] of value.entries()) {
    if (out.length >= MAX_PATH_INSTRUCTIONS) {
      warnings.push(`Manifest "review.path_instructions" is capped at ${MAX_PATH_INSTRUCTIONS} entries; dropping the rest.`);
      break;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`Manifest "review.path_instructions[${index}]" must be a mapping with path + instructions; ignoring it.`);
      continue;
    }
    const e = entry as Record<string, JsonValue>;
    const path = typeof e.path === "string" ? e.path.trim() : "";
    if (!path) {
      warnings.push(`Manifest "review.path_instructions[${index}].path" must be a non-empty string; ignoring the entry.`);
      continue;
    }
    if (path.length > MAX_ITEM_LENGTH) {
      warnings.push(`Manifest "review.path_instructions[${index}].path" exceeds ${MAX_ITEM_LENGTH} chars; ignoring the entry.`);
      continue;
    }
    if (e.instructions === undefined || e.instructions === null) {
      warnings.push(`Manifest "review.path_instructions[${index}].instructions" is required; ignoring the entry.`);
      continue;
    }
    const instructions = parsePublicSafeText(e.instructions, `review.path_instructions[${index}].instructions`, warnings);
    if (instructions === null) continue; // non-string / empty / not-public-safe → already warned
    out.push({ path, instructions });
  }
  return out;
}

/** Parse `review.profile` — one of chill / balanced / assertive (case-insensitive). `balanced` normalizes to
 *  null (the default, so the reviewer prompt stays byte-identical). Any other value is ignored with a warning. */
function parseReviewProfile(value: JsonValue | undefined, warnings: string[]): ReviewProfile | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warnings.push(`Manifest "review.profile" must be a string (chill | balanced | assertive); ignoring it.`);
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "balanced") return null; // default → no prompt change
  if (normalized === "chill" || normalized === "assertive") return normalized;
  warnings.push(`Manifest "review.profile" must be one of chill / balanced / assertive; ignoring "${value.slice(0, 32)}".`);
  return null;
}

/** Serialize the review config for the cache round-trip; returns null when nothing is set. */
export function reviewConfigToJson(review: FocusManifestReviewConfig): JsonValue {
  if (!review.present) return null;
  const out: Record<string, JsonValue> = {};
  if (review.footerText !== null) out.footer = { text: review.footerText };
  if (review.note !== null) out.note = review.note;
  if (review.profile !== null) out.profile = review.profile;
  if (review.pathInstructions.length > 0) out.path_instructions = review.pathInstructions.map((entry) => ({ path: entry.path, instructions: entry.instructions }));
  if (review.excludePaths.length > 0) out.exclude_paths = [...review.excludePaths];
  if (review.preMergeChecks.length > 0) {
    out.pre_merge_checks = review.preMergeChecks.map((check) => {
      const entry: Record<string, JsonValue> = { name: check.name };
      if (check.whenPaths.length > 0) entry.when_paths = [...check.whenPaths];
      if (check.titleContains !== null) entry.title_contains = check.titleContains;
      if (check.descriptionContains !== null) entry.description_contains = check.descriptionContains;
      if (check.requireLabel !== null) entry.require_label = check.requireLabel;
      if (check.enforce) entry.enforce = true;
      return entry;
    });
  }
  if (Object.keys(review.fields).length > 0) out.fields = { ...review.fields } as Record<string, JsonValue>;
  return out;
}

/**
 * Resolve the `review.path_instructions` that APPLY to a PR — those whose glob matches at least one changed path
 * — into a single prompt section for the AI reviewer, or "" when none match (so the prompt stays byte-identical).
 * Pure; uses the same manifest path-glob semantics (`matchesManifestPath`) as the rest of the manifest. Capped to
 * keep the prompt bounded. (#review-path-instructions)
 */
export function resolveReviewPathInstructions(pathInstructions: ReviewPathInstruction[], changedPaths: string[]): string {
  if (pathInstructions.length === 0 || changedPaths.length === 0) return "";
  const applicable = pathInstructions.filter((entry) => changedPaths.some((path) => matchesManifestPath(path, entry.path)));
  if (applicable.length === 0) return "";
  const lines = applicable.map((entry) => `- \`${entry.path}\`: ${entry.instructions}`);
  return `\n\nPath-specific review instructions from the maintainer — apply these to the changed files that match each glob:\n${lines.join("\n")}`;
}

/** Resolve the AI-reviewer overrides (`review.profile` + `review.path_instructions` + `review.exclude_paths`) from
 *  a possibly-null manifest (null = load failure). A null manifest yields the byte-identical defaults. Centralized
 *  so the AI-review caller threads them in one place with the null-manifest branch covered here (unit-tested)
 *  rather than inline in the processor. (#review-profile / #review-path-instructions / #review-exclude-paths) */
export function resolveReviewPromptOverrides(manifest: FocusManifest | null): { profile: ReviewProfile | null; pathInstructions: ReviewPathInstruction[]; excludePaths: string[] } {
  return { profile: manifest?.review.profile ?? null, pathInstructions: manifest?.review.pathInstructions ?? [], excludePaths: manifest?.review.excludePaths ?? [] };
}

/** Resolve `review.pre_merge_checks` from a possibly-null manifest (null = load failure ⇒ no checks). Centralized
 *  so the gate caller resolves them in one place with the null-manifest branch covered here (unit-tested) rather
 *  than inline in the processor. (#review-pre-merge-checks) */
export function resolveReviewPreMergeChecks(manifest: FocusManifest | null): PreMergeCheck[] {
  return manifest?.review.preMergeChecks ?? [];
}

/** Filter a PR's changed files down to the set the AI review should see — dropping any whose path matches a
 *  `review.exclude_paths` glob (generated/vendored/lockfiles). Empty `excludePaths` ⇒ the same array (byte-identical
 *  review). Pure; the gate/slop/secret-scan operate on the unfiltered files. (#review-exclude-paths) */
export function excludeReviewPaths<T extends { path: string }>(files: T[], excludePaths: string[]): T[] {
  if (excludePaths.length === 0) return files;
  return files.filter((file) => !excludePaths.some((glob) => matchesManifestPath(file.path, glob)));
}

/**
 * Resolve the EFFECTIVE repository settings a webhook should act on: `.gittensory.yml` > DB settings >
 * safe defaults. The generic `settings:` override applies first; the friendly `gate:` alias then wins
 * for its fields. This single resolver makes the whole gittensory configuration — gate on/off, blocker
 * modes, comments, labels, surface, audience — controllable from the repo's `.gittensory.yml`.
 */
export function resolveEffectiveSettings(dbSettings: RepositorySettings, manifest: FocusManifest): RepositorySettings {
  const effective: RepositorySettings = { ...dbSettings, ...manifest.settings };
  const gate = manifest.gate;
  if (gate.enabled !== null) effective.gateCheckMode = gate.enabled ? "enabled" : "off";
  if (gate.pack !== null) effective.gatePack = gate.pack;
  if (gate.linkedIssue !== null) effective.linkedIssueGateMode = gate.linkedIssue;
  if (gate.duplicates !== null) effective.duplicatePrGateMode = gate.duplicates;
  if (gate.readinessMode !== null) effective.qualityGateMode = gate.readinessMode;
  if (gate.readinessMinScore !== null) effective.qualityGateMinScore = gate.readinessMinScore;
  if (gate.slopMode !== null) effective.slopGateMode = gate.slopMode;
  if (gate.slopMinScore !== null) effective.slopGateMinScore = gate.slopMinScore;
  if (gate.slopAiAdvisory !== null) effective.slopAiAdvisory = gate.slopAiAdvisory;
  if (gate.aiReviewMode !== null) effective.aiReviewMode = gate.aiReviewMode;
  if (gate.aiReviewByok !== null) effective.aiReviewByok = gate.aiReviewByok;
  if (gate.aiReviewProvider !== null) effective.aiReviewProvider = gate.aiReviewProvider;
  if (gate.aiReviewModel !== null) effective.aiReviewModel = gate.aiReviewModel;
  if (gate.mergeReadiness !== null) effective.mergeReadinessGateMode = gate.mergeReadiness;
  if (gate.manifestPolicy !== null) effective.manifestPolicyGateMode = gate.manifestPolicy;
  if (gate.selfAuthoredLinkedIssue !== null) effective.selfAuthoredLinkedIssueGateMode = gate.selfAuthoredLinkedIssue;
  if (gate.firstTimeContributorGrace !== null) effective.firstTimeContributorGrace = gate.firstTimeContributorGrace;
  // The dashboard "Require linked issue" toggle must not silently diverge from gate blocking: when the
  // boolean is on but linkedIssueGateMode is still off, treat it as a block requirement (#797).
  if (effective.requireLinkedIssue && effective.linkedIssueGateMode === "off") {
    effective.linkedIssueGateMode = "block";
  }
  return effective;
}

/**
 * Tolerantly normalize an already-parsed manifest object into a {@link FocusManifest}.
 * Never throws: malformed shapes degrade to safe defaults and accumulate warnings so callers
 * can surface them instead of crashing.
 */
export function parseFocusManifest(raw: unknown, source?: FocusManifestSource): FocusManifest {
  if (raw === undefined || raw === null) return emptyManifest(source ?? "none");
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return emptyManifest(source ?? "api_record", ["Manifest must be a mapping of fields; ignoring malformed manifest and falling back to deterministic signals."]);
  }
  const record = raw as Record<string, JsonValue>;
  const warnings: string[] = [];
  const manifest: FocusManifest = {
    present: true,
    source: normalizeSource(source, record.source, warnings),
    wantedPaths: normalizeStringList(record.wantedPaths, "wantedPaths", warnings),
    blockedPaths: normalizeStringList(record.blockedPaths, "blockedPaths", warnings),
    preferredLabels: normalizeStringList(record.preferredLabels, "preferredLabels", warnings),
    linkedIssuePolicy: normalizeEnum(record.linkedIssuePolicy, "linkedIssuePolicy", ["required", "preferred", "optional"] as const, "optional", warnings),
    testExpectations: normalizeStringList(record.testExpectations, "testExpectations", warnings),
    issueDiscoveryPolicy: normalizeEnum(record.issueDiscoveryPolicy, "issueDiscoveryPolicy", ["encouraged", "neutral", "discouraged"] as const, "neutral", warnings),
    maintainerNotes: normalizeStringList(record.maintainerNotes, "maintainerNotes", warnings),
    publicNotes: normalizeStringList(record.publicNotes, "publicNotes", warnings).filter(isFocusManifestPublicSafe),
    gate: parseGateConfig(record.gate, warnings),
    settings: parseSettingsOverride(record.settings, warnings),
    review: parseReviewConfig(record.review, warnings),
    warnings,
  };
  if (
    manifest.wantedPaths.length === 0 &&
    manifest.blockedPaths.length === 0 &&
    manifest.preferredLabels.length === 0 &&
    manifest.testExpectations.length === 0 &&
    manifest.maintainerNotes.length === 0 &&
    manifest.publicNotes.length === 0 &&
    manifest.linkedIssuePolicy === "optional" &&
    manifest.issueDiscoveryPolicy === "neutral" &&
    !manifest.gate.present &&
    Object.keys(manifest.settings).length === 0 &&
    !manifest.review.present
  ) {
    warnings.push("Manifest contained no recognized focus fields; falling back to deterministic signals.");
    manifest.present = false;
  }
  return manifest;
}

/**
 * Parse raw manifest file/record content (JSON or YAML). Malformed content degrades to an empty
 * manifest with a warning rather than throwing, so a broken `.gittensory` config never breaks analysis.
 */
export function parseFocusManifestContent(content: string | null | undefined, source: FocusManifestSource = "repo_file"): FocusManifest {
  if (content === undefined || content === null || content.trim() === "") return emptyManifest(source);
  if (content.length > MAX_FOCUS_MANIFEST_BYTES || new TextEncoder().encode(content).byteLength > MAX_FOCUS_MANIFEST_BYTES) {
    return emptyManifest(source, [`Manifest content exceeded ${MAX_FOCUS_MANIFEST_BYTES} bytes; ignoring it and falling back to deterministic signals.`]);
  }
  const trimmed = content.trim();
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  let parsed: unknown;
  try {
    parsed = looksLikeJson ? JSON.parse(trimmed) : parseYaml(trimmed);
  } catch {
    return emptyManifest(source, [
      looksLikeJson
        ? "Manifest content was not valid JSON; ignoring it and falling back to deterministic signals."
        : "Manifest content was not valid YAML; ignoring it and falling back to deterministic signals.",
    ]);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyManifest(source, ["Manifest must be a mapping of fields; ignoring malformed manifest and falling back to deterministic signals."]);
  }
  return parseFocusManifest(parsed, source);
}

function normalizePathForMatch(path: string): string {
  return String(path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
}

/**
 * LINEAR-TIME wildcard matcher for a `*`-glob pattern over an already-normalized path. `*` (and a collapsed
 * run of `*`) matches any run of characters INCLUDING `/` (gittensory globs cross slashes). Implemented as a
 * prefix + suffix + ordered-substring (indexOf) scan rather than a `.*`-per-star regex: the old regex
 * (`^.*a.*a...$`) backtracks catastrophically on a near-miss path and could hang the gate for an entire repo
 * (a manifest glob with many non-adjacent `*`). This algorithm is O(path × parts) with NO backtracking.
 */
function linearGlobMatcher(pattern: string): (path: string) => boolean {
  // The caller only compiles this for a pattern that contains a wildcard, so split always yields >= 2 parts.
  const parts = pattern.split(/\*+/); // literal segments between (collapsed) wildcard runs
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const middles = parts.slice(1, -1).filter((part) => part.length > 0);
  return (path) => {
    if (!path.startsWith(first) || !path.endsWith(last)) return false;
    let idx = first.length;
    for (const part of middles) {
      const found = path.indexOf(part, idx);
      if (found === -1) return false;
      idx = found + part.length;
    }
    return path.length - last.length >= idx; // the suffix must not overlap the consumed prefix/middles
  };
}

/**
 * Compile a manifest path pattern into a predicate over an ALREADY-normalized path. Supports exact paths,
 * directory prefixes (`src/` or `src`), and `*` wildcards (`*` and a double-star both match any run of chars
 * across `/`). A double-star-then-separator prefix means "zero or more path segments", so the mandatory slash
 * is absorbed and a double-star glob also matches a ROOT-level (zero-depth) file, not only nested ones.
 * Compiling once lets a caller test many paths against one pattern without recompiling per path — see
 * {@link matchedPatterns}. An empty/blank pattern never matches.
 */
function compileManifestPathMatcher(pattern: string): (normalizedPath: string) => boolean {
  const normalizedPattern = normalizePathForMatch(pattern);
  if (!normalizedPattern) return () => false;
  if (normalizedPattern.includes("*")) {
    // A double-star-then-slash run collapses the mandatory separator into the wildcard so the glob matches
    // zero-depth/root too (e.g. a leading double-star glob matches a root-level file). Then run the linear matcher.
    const globbed = normalizedPattern.replace(/\*\*\//g, "*");
    return linearGlobMatcher(globbed);
  }
  const dirPattern = normalizedPattern.endsWith("/") ? normalizedPattern : `${normalizedPattern}/`;
  return (normalizedPath) => normalizedPath === normalizedPattern || normalizedPath.startsWith(dirPattern);
}

/**
 * Match a changed path against a manifest path pattern. Supports exact paths, directory
 * prefixes (`src/` or `src`), and `*` wildcards (`**` collapses to `*`).
 */
export function matchesManifestPath(path: string, pattern: string): boolean {
  const normalizedPath = normalizePathForMatch(path);
  if (!normalizedPath) return false;
  return compileManifestPathMatcher(pattern)(normalizedPath);
}

function matchedPatterns(paths: string[], patterns: string[]): string[] {
  // Normalize each path once and compile each pattern once, instead of redoing both for every (path,
  // pattern) pair — the wildcard regex was previously recompiled per path.
  const normalizedPaths = paths.map(normalizePathForMatch).filter(Boolean);
  return patterns.filter((pattern) => {
    const matches = compileManifestPathMatcher(pattern);
    return normalizedPaths.some((normalizedPath) => matches(normalizedPath));
  });
}

/**
 * Build deterministic, public-safe guidance from a focus manifest for a concrete change set.
 * Explains why changed paths are preferred or discouraged and surfaces manifest-driven blockers
 * without leaking maintainer-private notes into public next steps.
 */
export function buildFocusManifestGuidance(args: {
  manifest: FocusManifest;
  changedPaths: string[];
  labels?: string[] | undefined;
  linkedIssueCount?: number | undefined;
  testFileCount?: number | undefined;
  passedValidationCount?: number | undefined;
}): FocusManifestGuidance {
  const { manifest } = args;
  const changedPaths = args.changedPaths.filter((path) => typeof path === "string" && path.length > 0);
  const labels = (args.labels ?? []).map((label) => label.toLowerCase());
  const linkedIssueCount = Math.max(0, args.linkedIssueCount ?? 0);
  const testFileCount = Math.max(0, args.testFileCount ?? 0);
  const passedValidationCount = Math.max(0, args.passedValidationCount ?? 0);

  const matchedBlockedPaths = matchedPatterns(changedPaths, manifest.blockedPaths);
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
      matchedBlockedPaths: [],
      preferredLabelHits: [],
      findings,
      publicNextSteps: [],
      warnings: manifest.warnings,
      summary: "No maintainer focus manifest applied; using deterministic signals only.",
    };
  }

  if (matchedBlockedPaths.length > 0) {
    findings.push({
      code: "manifest_blocked_path",
      severity: "critical",
      title: "Change touches a maintainer-blocked area",
      detail: `Changed paths match maintainer-blocked patterns: ${matchedBlockedPaths.slice(0, 5).join(", ")}.`,
      action: "Move this work out of the maintainer-blocked area or confirm with the maintainer before opening a PR.",
    });
    publicNextSteps.push("Avoid the maintainer-blocked areas this branch currently touches; confirm scope with the maintainer first.");
  } else if (manifest.wantedPaths.length > 0 && matchedWantedPaths.length === 0 && changedPaths.length > 0) {
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

  if (manifest.linkedIssuePolicy === "required" && linkedIssueCount === 0) {
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
    findings.push({
      code: "manifest_missing_tests",
      severity: "warning",
      title: "Maintainer test expectations unmet",
      detail: `Maintainer expects test evidence: ${manifest.testExpectations.slice(0, 3).join("; ")}.`,
      action: "Add or update tests, or attach passing validation output that satisfies the maintainer's test expectations.",
    });
    publicNextSteps.push("Add tests or attach passing validation that meets the maintainer's test expectations.");
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
    matchedBlockedPaths,
    preferredLabelHits,
    findings,
    publicNextSteps: safeNextSteps,
    warnings: manifest.warnings,
    summary: summarize(manifest, matchedBlockedPaths, matchedWantedPaths),
  };
}

function summarize(manifest: FocusManifest, blocked: string[], wanted: string[]): string {
  if (blocked.length > 0) return "Maintainer focus manifest: change touches a blocked area.";
  if (wanted.length > 0) return "Maintainer focus manifest: change aligns with a wanted area.";
  if (manifest.wantedPaths.length > 0) return "Maintainer focus manifest: change is outside the wanted areas.";
  return "Maintainer focus manifest applied with no path-specific verdict.";
}

// ─── Focus Manifest Policy Schema ────────────────────────────────────────────

/** Preference signal for a contribution lane derived from the focus manifest. */
export type FocusManifestLanePreference = "preferred" | "neutral" | "discouraged";

export type FocusManifestPolicyContributionLane = {
  id: string;
  preference: "preferred" | "neutral" | "discouraged";
  title: string;
  summary: string;
  preferredPaths: string[];
  discouragedPaths: string[];
  validationExpectations: string[];
  publicNotes: string[];
};

export type FocusManifestPolicyLabelPolicy = {
  preferredLabels: string[];
  required: boolean;
};

export type FocusManifestPolicyValidation = {
  expectations: string[];
  linkedIssuePolicy: FocusManifestLinkedIssuePolicy;
};

export type FocusManifestPolicy = {
  repoFullName: string;
  generatedAt: string;
  source: FocusManifestSource;
  present: boolean;
  publicSafe: {
    contributionLanes: FocusManifestPolicyContributionLane[];
    labelPolicy: FocusManifestPolicyLabelPolicy;
    validation: FocusManifestPolicyValidation;
    issueDiscoveryPolicy: FocusManifestIssueDiscoveryPolicy;
    publicNotes: string[];
    readinessWarnings: string[];
    entryGuidance: string[];
    summary: string;
  };
  authenticated: {
    manifestSource: FocusManifestSource;
    privateNoteCount: number;
    manifestWarningCount: number;
    parseWarnings: string[];
    readinessWarnings: string[];
    maintainerContext: string[];
  };
};

/**
 * Compile a normalized {@link FocusManifest} into a deterministic, machine-readable
 * {@link FocusManifestPolicy}. Public-safe fields are segregated from authenticated
 * (owner-only) fields. No reward, wallet, hotkey, raw trust, or private scoring
 * language is allowed in public-safe output — unsafe strings are silently dropped.
 *
 * `repoFullName` is optional — when omitted it defaults to an empty string. Callers
 * that persist the policy should supply the full name; single-manifest analysis
 * callers may omit it.
 */
export function compileFocusManifestPolicy(manifest: FocusManifest, options?: { generatedAt?: string }): FocusManifestPolicy;
export function compileFocusManifestPolicy(repoFullName: string, manifest: FocusManifest, options?: { generatedAt?: string }): FocusManifestPolicy;
export function compileFocusManifestPolicy(
  repoFullNameOrManifest: string | FocusManifest,
  manifestOrOptions?: FocusManifest | { generatedAt?: string },
  options: { generatedAt?: string } = {},
): FocusManifestPolicy {
  let repoFullName: string;
  let manifest: FocusManifest;
  if (typeof repoFullNameOrManifest === "string") {
    repoFullName = repoFullNameOrManifest;
    manifest = manifestOrOptions as FocusManifest;
  } else {
    repoFullName = "";
    manifest = repoFullNameOrManifest;
    options = (manifestOrOptions as { generatedAt?: string }) ?? {};
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const safePublicNotes = manifest.publicNotes.filter(isFocusManifestPublicSafe);
  const contributionLanes = buildPolicyContributionLanes(manifest);
  const readinessWarnings = buildPolicyReadinessWarnings(manifest);
  const entryGuidance = buildPolicyEntryGuidance(manifest);
  const summary = buildPolicySummary(manifest);

  return {
    repoFullName,
    generatedAt,
    source: manifest.source,
    present: manifest.present,
    publicSafe: {
      contributionLanes,
      labelPolicy: {
        preferredLabels: manifest.preferredLabels.filter(isFocusManifestPublicSafe),
        required: manifest.linkedIssuePolicy !== "optional",
      },
      validation: {
        expectations: manifest.testExpectations.filter(isFocusManifestPublicSafe),
        linkedIssuePolicy: manifest.linkedIssuePolicy,
      },
      issueDiscoveryPolicy: manifest.issueDiscoveryPolicy,
      publicNotes: safePublicNotes,
      readinessWarnings,
      entryGuidance,
      summary,
    },
    authenticated: {
      manifestSource: manifest.source,
      privateNoteCount: manifest.maintainerNotes.length,
      manifestWarningCount: manifest.warnings.length,
      parseWarnings: manifest.warnings,
      readinessWarnings,
      maintainerContext: manifest.maintainerNotes,
    },
  };
}

function buildPolicyEntryGuidance(manifest: FocusManifest): string[] {
  const guidance: string[] = [];
  if (manifest.wantedPaths.length > 0) {
    guidance.push(`Focus changes on maintainer-wanted areas: ${manifest.wantedPaths.slice(0, 5).join(", ")}.`);
  }
  if (manifest.blockedPaths.length > 0) {
    guidance.push(`Avoid maintainer-blocked areas: ${manifest.blockedPaths.slice(0, 5).join(", ")}.`);
  }
  if (manifest.linkedIssuePolicy === "required") guidance.push("Link a tracked issue before opening a pull request.");
  else if (manifest.linkedIssuePolicy === "preferred") guidance.push("Linking a tracked issue is preferred before opening a pull request.");
  if (manifest.preferredLabels.length > 0) {
    const safeLabels = manifest.preferredLabels.filter(isFocusManifestPublicSafe);
    if (safeLabels.length > 0) guidance.push(`Apply a maintainer-preferred label: ${safeLabels.slice(0, 3).join(", ")}.`);
  }
  guidance.push(...manifest.publicNotes.filter(isFocusManifestPublicSafe));
  return [...new Set(guidance)].filter(isFocusManifestPublicSafe);
}

function buildPolicySummary(manifest: FocusManifest): string {
  if (!manifest.present) return "No maintainer focus manifest; contribution guidance is not constrained.";
  if (manifest.issueDiscoveryPolicy === "encouraged") return "Issue-discovery is the preferred contribution mode for this repo.";
  if (manifest.issueDiscoveryPolicy === "discouraged") return "Direct PRs are preferred; issue-discovery submissions are discouraged.";
  if (manifest.wantedPaths.length > 0) return "Direct PRs on the maintainer-wanted areas are preferred.";
  return "Contribution guidance is derived from the maintainer focus manifest.";
}

function buildPolicyContributionLanes(manifest: FocusManifest): FocusManifestPolicyContributionLane[] {
  if (!manifest.present) return [];

  const lanes: FocusManifestPolicyContributionLane[] = [];
  const safeWantedPaths = manifest.wantedPaths.filter(isFocusManifestPublicSafe);
  const safeBlockedPaths = manifest.blockedPaths.filter(isFocusManifestPublicSafe);

  const directPrPreference: "preferred" | "neutral" | "discouraged" =
    manifest.issueDiscoveryPolicy === "encouraged" ? "discouraged"
    : safeWantedPaths.length > 0 || manifest.testExpectations.length > 0 ? "preferred"
    : "neutral";

  lanes.push({
    id: "direct-pr",
    preference: directPrPreference,
    title: "Direct pull request lane",
    summary:
      directPrPreference === "discouraged"
        ? "Direct pull requests are discouraged; issue discovery is the preferred entry mode."
        : directPrPreference === "preferred"
          ? "Contribute changes in maintainer-wanted areas with required validation evidence."
          : "Direct pull requests are accepted when they stay inside maintainer-wanted scope.",
    preferredPaths: safeWantedPaths,
    discouragedPaths: safeBlockedPaths,
    validationExpectations: manifest.testExpectations.filter(isFocusManifestPublicSafe),
    publicNotes: manifest.publicNotes.filter(isFocusManifestPublicSafe),
  });

  const issueDiscoveryPreference: "preferred" | "neutral" | "discouraged" =
    manifest.issueDiscoveryPolicy === "encouraged" ? "preferred"
    : manifest.issueDiscoveryPolicy === "discouraged" ? "discouraged"
    : "neutral";

  lanes.push({
    id: "issue-discovery",
    preference: issueDiscoveryPreference,
    title: "Issue discovery lane",
    summary:
      issueDiscoveryPreference === "preferred"
        ? "File well-scoped issue reports that the maintainer has indicated are welcome."
        : issueDiscoveryPreference === "discouraged"
          ? "The maintainer has indicated this repo prefers direct fixes over new issue reports."
          : "Issue discovery is optional; confirm maintainer scope before filing new issues.",
    preferredPaths: [],
    discouragedPaths: safeBlockedPaths,
    validationExpectations: [],
    publicNotes: [],
  });

  return lanes;
}

function buildPolicyReadinessWarnings(manifest: FocusManifest): string[] {
  if (!manifest.present) return [];
  const warnings: string[] = [];
  if (manifest.wantedPaths.length === 0 && manifest.preferredLabels.length === 0) {
    warnings.push("Focus manifest does not define wanted paths or preferred labels; contribution scope may be unclear to contributors.");
  }
  if (manifest.testExpectations.length === 0) {
    warnings.push("Focus manifest does not define validation expectations; contributors may not know what tests to run.");
  }
  if (manifest.blockedPaths.length > 0 && manifest.wantedPaths.length === 0) {
    warnings.push("Focus manifest blocks work areas but does not define wanted paths; pair blocked areas with a positive lane.");
  }
  return warnings.filter(isFocusManifestPublicSafe);
}

// ---------------------------------------------------------------------------
// Contribution lane derivation
// ---------------------------------------------------------------------------

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
  const safeBlocked = manifest.blockedPaths.filter(isFocusManifestPublicSafe);
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
    : safeBlocked.length > 0 ? "discouraged"
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
  if (safeBlocked.length > 0) {
    prEntryGuidance.push(`Avoid maintainer-blocked areas: ${manifest.blockedPaths.slice(0, 5).join(", ")}.`);
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
    discouragedEntryPaths: safeBlocked,
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

// ─── Focus Manifest Policy Schema ────────────────────────────────────────────
