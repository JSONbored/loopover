export type DeadLetterQueueItem = {
  id: number;
  jobType: string;
  attempts: number;
  lastError: string | null;
  createdAtMs: number;
  deadAtMs: number | null;
};

export type DeadLetterQueuePage = {
  generatedAt: string;
  limit: number;
  offset: number;
  total: number;
  items: DeadLetterQueueItem[];
};

export const DEAD_LETTER_QUEUE_PAGE_SIZE = 25;
export const DEAD_LETTER_ERROR_TRUNCATE_LENGTH = 80;

export function buildDeadLetterQueuePath(
  offset: number,
  limit = DEAD_LETTER_QUEUE_PAGE_SIZE,
): string {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return `/v1/app/selfhost/queue/dead?${params.toString()}`;
}

function isDeadLetterQueueItem(value: unknown): value is DeadLetterQueueItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DeadLetterQueueItem>;
  return (
    typeof item.id === "number" &&
    typeof item.jobType === "string" &&
    typeof item.attempts === "number" &&
    (item.lastError === null || typeof item.lastError === "string") &&
    typeof item.createdAtMs === "number" &&
    (item.deadAtMs === null || typeof item.deadAtMs === "number")
  );
}

export function normalizeDeadLetterQueuePage(data: unknown): DeadLetterQueuePage | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Partial<DeadLetterQueuePage>;
  if (
    typeof raw.generatedAt !== "string" ||
    typeof raw.limit !== "number" ||
    typeof raw.offset !== "number" ||
    typeof raw.total !== "number" ||
    !Array.isArray(raw.items) ||
    // A malformed item means the response itself is untrustworthy -- filtering it out silently would render
    // a corrupted backend response as a plausible partial/empty queue instead of surfacing the corruption.
    !raw.items.every(isDeadLetterQueueItem)
  ) {
    return null;
  }
  return {
    generatedAt: raw.generatedAt,
    limit: raw.limit,
    offset: raw.offset,
    total: raw.total,
    items: raw.items,
  };
}

export function formatDeadLetterTimestamp(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Truncates a last-error message for the collapsed table row; the panel expands the full text on click. */
export function truncateErrorMessage(
  message: string,
  maxLength = DEAD_LETTER_ERROR_TRUNCATE_LENGTH,
): string {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength).trimEnd()}…`;
}
