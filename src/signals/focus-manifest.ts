import { parse as parseYaml } from "yaml";
import type { JsonValue } from "../types";

export type FocusManifestSource = "repo_file" | "api_record" | "none";
export type FocusManifestLinkedIssuePolicy = "required" | "preferred" | "optional";
export type FocusManifestIssueDiscoveryPolicy = "encouraged" | "neutral" | "discouraged";

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
  warnings: [],
};

/**
 * Public-safe redaction guard shared with the local-branch packet renderer. Public manifest
 * text must not leak reward, wallet/key, ranking, or local filesystem path material.
 */
export function isFocusManifestPublicSafe(text: string): boolean {
  return !/\b(reward\w*|score\w*|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|raw[-\s]?trust|trust score|private[-\s]?reviewability|reviewability)\b|\/Users\/|\/home\/|\/tmp\/|[A-Z]:\\Users\\/i.test(text);
}

function emptyManifest(source: FocusManifestSource, warnings: string[] = []): FocusManifest {
  return { ...EMPTY_MANIFEST, source, warnings };
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
    if (trimmed.length > MAX_ITEM_LENGTH) {
      warnings.push(`Manifest field "${field}" truncated an over-long entry.`);
      result.push(trimmed.slice(0, MAX_ITEM_LENGTH));
      continue;
    }
    if (!result.includes(trimmed)) result.push(trimmed);
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
    manifest.issueDiscoveryPolicy === "neutral"
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
 * Match a changed path against a manifest path pattern. Supports exact paths, directory
 * prefixes (`src/` or `src`), and `*` wildcards (`**` collapses to `*`).
 */
export function matchesManifestPath(path: string, pattern: string): boolean {
  const normalizedPath = normalizePathForMatch(path);
  const normalizedPattern = normalizePathForMatch(pattern);
  if (!normalizedPath || !normalizedPattern) return false;
  if (normalizedPattern.includes("*")) {
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
    return new RegExp(`^${escaped}$`).test(normalizedPath);
  }
  if (normalizedPath === normalizedPattern) return true;
  const dirPattern = normalizedPattern.endsWith("/") ? normalizedPattern : `${normalizedPattern}/`;
  return normalizedPath.startsWith(dirPattern);
}

function matchedPatterns(paths: string[], patterns: string[]): string[] {
  return patterns.filter((pattern) => paths.some((path) => matchesManifestPath(path, pattern)));
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
