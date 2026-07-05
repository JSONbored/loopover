// Portable first-contact track-record summary (#3008).
//
// The miner runtime can render this block locally from public PR outcomes and public moderation records. The type
// surface intentionally has no score/ranking fields, and the formatter renders from computed fields only so arbitrary
// caller metadata cannot cross the public boundary.

export type TrackRecordPullRequestState = "merged" | "closed" | "open";

export type TrackRecordPullRequestOutcome = {
  id?: string | number | undefined;
  repoFullName: string;
  authorLogin: string;
  state: TrackRecordPullRequestState | string;
  createdAt?: string | Date | null | undefined;
  closedAt?: string | Date | null | undefined;
  mergedAt?: string | Date | null | undefined;
  url?: string | null | undefined;
};

export type TrackRecordIncidentKind =
  | "ban"
  | "moderation"
  | "code_of_conduct"
  | "abuse"
  | "spam"
  | "unknown";

export type TrackRecordIncidentRecord = {
  login: string;
  kind: TrackRecordIncidentKind | string;
  active?: boolean | null | undefined;
  recordedAt?: string | Date | null | undefined;
  publicEvidenceUrl?: string | null | undefined;
};

export type TrackRecordSummaryManifest = {
  miner?: {
    trackRecordSummary?: {
      enabled?: unknown;
    } | null;
  } | null;
  trackRecordSummary?: {
    enabled?: unknown;
  } | null;
};

export type TrackRecordSummaryConfig = {
  includeTrackRecordSummary: boolean;
  warnings: string[];
};

export type TrackRecordSummaryOutcomeCounts = {
  merged: number;
  closedWithoutMerge: number;
  resolved: number;
  openIgnored: number;
  ignored: number;
};

export type TrackRecordTenure = {
  firstObservedAt: string | null;
  days: number | null;
  label: string;
};

export type TrackRecordMergeRate = {
  numerator: number;
  denominator: number;
  ratio: number | null;
  percent: number | null;
  label: string;
};

export type TrackRecordIncidentStatus = {
  hasPublicIncident: boolean;
  checkedPublicRecords: number;
  activePublicRecords: number;
  label: string;
  evidenceUrls: string[];
};

export type TrackRecordSummaryAudit = {
  normalizedLogin: string;
  consideredOutcomeIds: string[];
  ignoredOutcomeIds: string[];
  firstObservedCandidates: string[];
};

export type TrackRecordSummary = {
  enabled: boolean;
  login: string;
  mergeRate: TrackRecordMergeRate;
  tenure: TrackRecordTenure;
  incidents: TrackRecordIncidentStatus;
  outcomes: TrackRecordSummaryOutcomeCounts;
  audit: TrackRecordSummaryAudit;
};

const DEFAULT_TRACK_RECORD_CONFIG: TrackRecordSummaryConfig = {
  includeTrackRecordSummary: false,
  warnings: [],
};

const BOOLEAN_TRUE = new Set(["1", "true", "yes", "y", "on", "enabled", "include"]);
const BOOLEAN_FALSE = new Set(["0", "false", "no", "n", "off", "disabled", "exclude"]);
const RESOLVED_MERGED_STATES = new Set(["merged", "merge", "accepted"]);
const RESOLVED_CLOSED_STATES = new Set(["closed", "declined", "rejected", "closed_unmerged", "not_merged"]);
const OPEN_STATES = new Set(["open", "draft", "pending", "ready_for_review"]);
const INCIDENT_KINDS = new Set(["ban", "moderation", "code_of_conduct", "abuse", "spam"]);
const PUBLIC_FIELD_BLOCKLIST = [
  /\btrust\s*score\b/iu,
  /\btrustscore\b/iu,
  /\bscoreability\b/iu,
  /\breward\b/iu,
  /\bpayout\b/iu,
  /\branking\b/iu,
  /\bprivate\s*scor/iu,
  /\bwallet\b/iu,
  /\bhotkey\b/iu,
  /\bcoldkey\b/iu,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (BOOLEAN_TRUE.has(normalized)) return true;
  if (BOOLEAN_FALSE.has(normalized)) return false;
  return undefined;
}

function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeId(value: string | number | undefined, fallbackIndex: number): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) return collapseInline(trimmed);
  }
  return `row-${fallbackIndex + 1}`;
}

function normalizeState(value: string): TrackRecordPullRequestState | "ignored" {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (RESOLVED_MERGED_STATES.has(normalized)) return "merged";
  if (RESOLVED_CLOSED_STATES.has(normalized)) return "closed";
  if (OPEN_STATES.has(normalized)) return "open";
  return "ignored";
}

function normalizeIncidentKind(value: string): TrackRecordIncidentKind {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (INCIDENT_KINDS.has(normalized)) return normalized as TrackRecordIncidentKind;
  return "unknown";
}

function parseInstant(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseNow(value: string | Date | null | undefined): Date {
  const parsed = parseInstant(value ?? undefined);
  return parsed ? new Date(parsed) : new Date();
}

function clampWholeDays(startIso: string, now: Date): number {
  const deltaMs = now.getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 0;
  return Math.floor(deltaMs / 86_400_000);
}

function collapseInline(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
}

function markdownSafe(value: string): string {
  return collapseInline(value).replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function normalizeEvidenceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const collapsed = collapseInline(value);
  if (!collapsed) return null;
  if (!/^https?:\/\/[^\s<>"`|\\]+$/iu.test(collapsed)) return null;
  return collapsed;
}

function firstPresentInstant(values: readonly (string | Date | null | undefined)[]): string | null {
  const parsed = values.flatMap((value) => {
    const instant = parseInstant(value);
    return instant ? [instant] : [];
  });
  if (parsed.length === 0) return null;
  parsed.sort();
  return parsed[0]!;
}

function formatPercent(ratio: number | null): { percent: number | null; label: string } {
  if (ratio === null) return { percent: null, label: "not enough resolved public PR history" };
  const percent = Math.round(ratio * 100);
  return { percent, label: `${percent}%` };
}

function formatTenure(days: number | null): string {
  if (days === null) return "not enough public history";
  if (days === 0) return "less than 1 day";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month" : `${months} months`;
  const years = Math.floor(days / 365);
  const remainderMonths = Math.floor((days % 365) / 30);
  if (remainderMonths === 0) return years === 1 ? "1 year" : `${years} years`;
  return `${years}y ${remainderMonths}m`;
}

function assertPublicSummaryText(text: string): void {
  for (const pattern of PUBLIC_FIELD_BLOCKLIST) {
    if (pattern.test(text)) {
      throw new Error("Track-record summary attempted to render a blocked public field.");
    }
  }
}

function summarizeIncidents(
  login: string,
  incidents: readonly TrackRecordIncidentRecord[],
): TrackRecordIncidentStatus {
  const normalizedLogin = normalizeLogin(login);
  const matching = incidents.filter((incident) => normalizeLogin(incident.login) === normalizedLogin);
  const active = matching.filter((incident) => incident.active !== false);
  const activeKnown = active.filter((incident) => normalizeIncidentKind(incident.kind) !== "unknown");
  const evidenceUrls = Array.from(
    new Set(
      activeKnown.flatMap((incident) => {
        const url = normalizeEvidenceUrl(incident.publicEvidenceUrl);
        return url ? [url] : [];
      }),
    ),
  ).sort();
  const hasPublicIncident = activeKnown.length > 0;
  return {
    hasPublicIncident,
    checkedPublicRecords: matching.length,
    activePublicRecords: activeKnown.length,
    label: hasPublicIncident ? "public conduct incident present" : "no public conduct incidents found",
    evidenceUrls,
  };
}

/**
 * Resolve the explicit miner-side opt-in. Missing and malformed values fail closed so operators must choose to include
 * a public first-contact summary.
 */
export function resolveTrackRecordSummaryConfig(
  manifest: TrackRecordSummaryManifest | Record<string, unknown> | null | undefined,
): TrackRecordSummaryConfig {
  const root = isRecord(manifest) ? manifest : {};
  const miner = isRecord(root.miner) ? root.miner : {};
  const minerConfig = isRecord(miner.trackRecordSummary) ? miner.trackRecordSummary : {};
  const topConfig = isRecord(root.trackRecordSummary) ? root.trackRecordSummary : {};
  const raw = minerConfig.enabled ?? topConfig.enabled ?? undefined;
  const normalized = normalizeBoolean(raw);
  const warnings: string[] = [];
  if (raw !== undefined && normalized === undefined) {
    warnings.push("miner.trackRecordSummary.enabled must be a boolean-like value; defaulting to false.");
  }
  return {
    includeTrackRecordSummary: normalized ?? DEFAULT_TRACK_RECORD_CONFIG.includeTrackRecordSummary,
    warnings,
  };
}

export function computeTrackRecordSummary(input: {
  login: string;
  outcomes: readonly TrackRecordPullRequestOutcome[];
  incidents?: readonly TrackRecordIncidentRecord[] | undefined;
  now?: string | Date | null | undefined;
  config?: TrackRecordSummaryConfig | TrackRecordSummaryManifest | Record<string, unknown> | null | undefined;
}): TrackRecordSummary {
  const config =
    input.config && "includeTrackRecordSummary" in input.config
      ? (input.config as TrackRecordSummaryConfig)
      : resolveTrackRecordSummaryConfig(input.config);
  const normalizedLogin = normalizeLogin(input.login);
  const now = parseNow(input.now);
  const outcomes: TrackRecordSummaryOutcomeCounts = {
    merged: 0,
    closedWithoutMerge: 0,
    resolved: 0,
    openIgnored: 0,
    ignored: 0,
  };
  const consideredOutcomeIds: string[] = [];
  const ignoredOutcomeIds: string[] = [];
  const firstObservedCandidates: string[] = [];

  input.outcomes.forEach((outcome, index) => {
    const id = normalizeId(outcome.id, index);
    if (normalizeLogin(outcome.authorLogin) !== normalizedLogin) {
      outcomes.ignored += 1;
      ignoredOutcomeIds.push(id);
      return;
    }

    const mergedAt = parseInstant(outcome.mergedAt);
    const state = mergedAt ? "merged" : normalizeState(outcome.state);
    const firstObserved = firstPresentInstant([outcome.createdAt, outcome.closedAt, outcome.mergedAt]);
    if (firstObserved) firstObservedCandidates.push(firstObserved);

    if (state === "merged") {
      outcomes.merged += 1;
      outcomes.resolved += 1;
      consideredOutcomeIds.push(id);
      return;
    }
    if (state === "closed") {
      outcomes.closedWithoutMerge += 1;
      outcomes.resolved += 1;
      consideredOutcomeIds.push(id);
      return;
    }
    if (state === "open") {
      outcomes.openIgnored += 1;
      ignoredOutcomeIds.push(id);
      return;
    }

    outcomes.ignored += 1;
    ignoredOutcomeIds.push(id);
  });

  const ratio = outcomes.resolved === 0 ? null : outcomes.merged / outcomes.resolved;
  const formattedRate = formatPercent(ratio);
  const firstObservedAt = firstObservedCandidates.length === 0 ? null : [...firstObservedCandidates].sort()[0]!;
  const tenureDays = firstObservedAt ? clampWholeDays(firstObservedAt, now) : null;
  const incidents = summarizeIncidents(input.login, input.incidents ?? []);

  return {
    enabled: config.includeTrackRecordSummary,
    login: normalizedLogin,
    mergeRate: {
      numerator: outcomes.merged,
      denominator: outcomes.resolved,
      ratio,
      percent: formattedRate.percent,
      label: formattedRate.label,
    },
    tenure: {
      firstObservedAt,
      days: tenureDays,
      label: formatTenure(tenureDays),
    },
    incidents,
    outcomes,
    audit: {
      normalizedLogin,
      consideredOutcomeIds: consideredOutcomeIds.sort(),
      ignoredOutcomeIds: ignoredOutcomeIds.sort(),
      firstObservedCandidates: firstObservedCandidates.sort(),
    },
  };
}

export function shouldIncludeTrackRecordSummary(
  config: TrackRecordSummaryConfig | TrackRecordSummaryManifest | Record<string, unknown> | null | undefined,
): boolean {
  if (config && "includeTrackRecordSummary" in config) {
    return (config as TrackRecordSummaryConfig).includeTrackRecordSummary === true;
  }
  return resolveTrackRecordSummaryConfig(config).includeTrackRecordSummary;
}

/**
 * Render a deterministic Markdown block suitable for a PR body or first comment. Disabled summaries render to an empty
 * string so caller code can concatenate safely without adding extra blank lines.
 */
export function renderTrackRecordSummaryMarkdown(summary: TrackRecordSummary): string {
  if (!summary.enabled) return "";
  const lines = [
    "### Public contributor record",
    "",
    `- GitHub login: ${markdownSafe(summary.login)}`,
    `- Resolved public PRs: ${summary.outcomes.resolved} (${summary.outcomes.merged} merged, ${summary.outcomes.closedWithoutMerge} closed without merge)`,
    `- Public merge rate: ${summary.mergeRate.label}`,
    `- Public tenure: ${summary.tenure.label}`,
    `- Public conduct record: ${summary.incidents.label}`,
  ];

  if (summary.outcomes.openIgnored > 0) {
    lines.push(`- Open PRs ignored for rate: ${summary.outcomes.openIgnored}`);
  }
  if (summary.incidents.hasPublicIncident && summary.incidents.evidenceUrls.length > 0) {
    lines.push(
      `- Public evidence: ${summary.incidents.evidenceUrls.map((url) => markdownSafe(url)).join(", ")}`,
    );
  }

  const rendered = `${lines.join("\n")}\n`;
  assertPublicSummaryText(rendered);
  return rendered;
}
