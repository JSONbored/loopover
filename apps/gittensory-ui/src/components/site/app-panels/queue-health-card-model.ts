export type QueueHealthCardModel = {
  generatedAt: string;
  stale: boolean;
  pending: number;
  inFlight: number;
  stuck: number;
  dlq: number;
  queueDepthTrend: number[];
  summary: string;
};

export function queueHealthStatus(
  card: QueueHealthCardModel,
): "ready" | "warn" | "stale" | "blocked" {
  if (card.stale) return "stale";
  if (card.dlq > 0) return "blocked";
  if (card.stuck > 0) return "warn";
  return "ready";
}

export function formatQueueHealthGeneratedAt(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}
