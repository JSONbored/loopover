// Read-only client for the local ledgers API (#4855). The middleware aggregates the claim / event / governor
// ledgers server-side into status/type counts plus a small feed of SAFE columns — it never republishes raw
// payloads, the free-text claim note, or any secret-shaped value (the same invariant the read-only MCP tools
// enforce). This client just fetches that summary and validates its shape; a failure surfaces as a typed error
// result the view renders, never a crash.

export const LEDGERS_API_PATH = "/api/ledgers";

export const CLAIM_STATUSES = ["active", "released", "expired"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type ClaimStatusCounts = Record<ClaimStatus, number>;

export type ClaimsSummary = { total: number; byStatus: ClaimStatusCounts };
export type EventFeedEntry = { eventType: string; repoFullName: string | null; createdAt: string | null };
export type EventsSummary = { total: number; byType: Record<string, number>; recent: EventFeedEntry[] };
export type GovernorSummary = { total: number; byEventType: Record<string, number> };
export type LedgersSummary = { claims: ClaimsSummary; events: EventsSummary; governor: GovernorSummary };

export type LedgersResult = { ok: true; summary: LedgersSummary } | { ok: false; error: string };

export const emptyLedgersSummary = (): LedgersSummary => ({
  claims: { total: 0, byStatus: { active: 0, released: 0, expired: 0 } },
  events: { total: 0, byType: {}, recent: [] },
  governor: { total: 0, byEventType: {} },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCountMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((count) => typeof count === "number");
}

function isClaimStatusCounts(value: unknown): value is ClaimStatusCounts {
  return isRecord(value) && CLAIM_STATUSES.every((status) => typeof value[status] === "number");
}

function isEventFeedEntry(value: unknown): value is EventFeedEntry {
  if (!isRecord(value)) return false;
  const okName = value.repoFullName === null || typeof value.repoFullName === "string";
  const okAt = value.createdAt === null || typeof value.createdAt === "string";
  return typeof value.eventType === "string" && okName && okAt;
}

function isLedgersSummary(value: unknown): value is LedgersSummary {
  if (!isRecord(value)) return false;
  const { claims, events, governor } = value as Record<string, unknown>;
  if (!isRecord(claims) || typeof claims.total !== "number" || !isClaimStatusCounts(claims.byStatus)) return false;
  if (
    !isRecord(events) ||
    typeof events.total !== "number" ||
    !isCountMap(events.byType) ||
    !Array.isArray(events.recent) ||
    !events.recent.every(isEventFeedEntry)
  ) {
    return false;
  }
  if (!isRecord(governor) || typeof governor.total !== "number" || !isCountMap(governor.byEventType)) return false;
  return true;
}

/** Fetch the local ledgers summary; failures surface as a typed error result the view renders, never a crash. */
export async function fetchLedgers(fetchImpl: typeof fetch = fetch): Promise<LedgersResult> {
  try {
    const response = await fetchImpl(LEDGERS_API_PATH);
    if (!response.ok) return { ok: false, error: `local ledgers API responded ${response.status}` };
    const payload: unknown = await response.json();
    const summary = (payload as { summary?: unknown }).summary;
    if (!isLedgersSummary(summary))
      return { ok: false, error: "local ledgers API returned an unexpected payload shape" };
    return { ok: true, summary };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "failed to reach the local ledgers API" };
  }
}
