export type SkippedPrAuditReason =
  | "surface_off"
  | "missing_author"
  | "bot_author"
  | "maintainer_author"
  | "miner_detection_unavailable"
  | "not_official_gittensor_miner";

export type SkippedPrAuditItem = {
  repoFullName: string;
  pullNumber: number;
  reason: string;
  timestamp: string;
  remediation: string;
};

export type SkippedPrAuditExport = {
  generatedAt: string;
  limit: number;
  hasMore: boolean;
  filters: {
    repoFullName: string | null;
    reason: SkippedPrAuditReason | null;
    since: string | null;
  };
  items: SkippedPrAuditItem[];
};

export const SKIP_REASON_OPTIONS: Array<{ value: "" | SkippedPrAuditReason; label: string }> = [
  { value: "", label: "All reasons" },
  { value: "surface_off", label: "Surface off" },
  { value: "missing_author", label: "Missing author" },
  { value: "bot_author", label: "Bot author" },
  { value: "maintainer_author", label: "Maintainer author" },
  { value: "miner_detection_unavailable", label: "Miner detection unavailable" },
  { value: "not_official_gittensor_miner", label: "Not official Gittensor miner" },
];

export function buildSkippedPrAuditPath(options: {
  limit: number;
  repoFullName?: string;
  reason?: SkippedPrAuditReason;
  since?: string;
}): string {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit));
  if (options.repoFullName?.trim()) params.set("repoFullName", options.repoFullName.trim());
  if (options.reason) params.set("reason", options.reason);
  if (options.since?.trim()) params.set("since", options.since.trim());
  return `/v1/app/skipped-pr-audit?${params.toString()}`;
}

/** Parse a datetime-local or ISO-ish value without throwing from Apply Filters. */
export function normalizeSinceInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return "";
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toISOString();
  } catch {
    return "";
  }
}

export function normalizeSkippedPrAuditExport(data: unknown): SkippedPrAuditExport | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Partial<SkippedPrAuditExport>;
  if (typeof raw.generatedAt !== "string" || !Array.isArray(raw.items)) return null;
  const items = raw.items.filter(
    (item): item is SkippedPrAuditItem =>
      item != null &&
      typeof item === "object" &&
      typeof item.repoFullName === "string" &&
      typeof item.pullNumber === "number" &&
      typeof item.reason === "string" &&
      typeof item.timestamp === "string" &&
      typeof item.remediation === "string",
  );
  const filters = raw.filters;
  return {
    generatedAt: raw.generatedAt,
    limit: typeof raw.limit === "number" ? raw.limit : items.length,
    hasMore: Boolean(raw.hasMore),
    filters: {
      repoFullName:
        filters && typeof filters.repoFullName === "string" ? filters.repoFullName : null,
      reason:
        filters && typeof filters.reason === "string"
          ? (filters.reason as SkippedPrAuditReason)
          : null,
      since: filters && typeof filters.since === "string" ? filters.since : null,
    },
    items,
  };
}

export function formatSkipReason(reason: string): string {
  const match = SKIP_REASON_OPTIONS.find((option) => option.value === reason);
  if (match && match.value) return match.label;
  return reason.replaceAll("_", " ");
}

export function formatAuditTimestamp(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return timestamp;
  return new Date(parsed).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function pullRequestHref(repoFullName: string, pullNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${pullNumber}`;
}

export function skipReasonTone(reason: string): "ready" | "info" | "warn" | "degraded" {
  if (reason === "bot_author" || reason === "not_official_gittensor_miner") return "info";
  if (reason === "surface_off" || reason === "maintainer_author") return "warn";
  if (reason === "miner_detection_unavailable" || reason === "missing_author") return "degraded";
  return "ready";
}
