import { existsSync } from "node:fs";
import type { Plugin } from "vite";

// Local read-only ledgers API (#4855) — sibling of `vite-portfolio-queue-api.ts` / `vite-run-state-api.ts`, same
// shape and same reason: the dashboard is a browser app while the claim / event / governor ledgers are
// `node:sqlite` files on disk, so the dev server bridges the two by calling into the EXISTING read exports of
// `packages/gittensory-miner/lib/{claim,event,governor}-ledger.js`.
//
// SAFETY: every ledger is aggregated SERVER-SIDE to status/type COUNTS plus a small feed of explicitly-projected
// SAFE columns. Raw `payload_json` (governor/event) and the free-text claim `note` NEVER cross the wire — the
// same "no secret-shaped value, no excluded raw column" invariant the read-only MCP tools enforce (#5199).
//
// Same read-only fresh-install rule as the sibling endpoints: the default `list*`/`read*` exports lazily
// initialize their store, which would CREATE the SQLite file — so each ledger's resolved DB path is probed first
// and reported empty without ever touching the store when no DB exists yet.

const RECENT_EVENT_LIMIT = 25;

export const CLAIM_STATUSES = ["active", "released", "expired"] as const;
type ClaimStatus = (typeof CLAIM_STATUSES)[number];

type ClaimRow = { repoFullName?: unknown; issueNumber?: unknown; status?: unknown; claimedAt?: unknown };
type EventRow = { type?: unknown; repoFullName?: unknown; createdAt?: unknown };
type GovernorRow = { eventType?: unknown; repoFullName?: unknown; ts?: unknown };

type ClaimLedgerModule = { resolveClaimLedgerDbPath: () => string; listClaims: (filter?: unknown) => ClaimRow[] };
type EventLedgerModule = { resolveEventLedgerDbPath: () => string; readEvents: (filter?: unknown) => EventRow[] };
type GovernorLedgerModule = {
  resolveGovernorLedgerDbPath: () => string;
  readGovernorEvents: (filter?: unknown) => GovernorRow[];
};

export type ClaimsSummary = { total: number; byStatus: Record<ClaimStatus, number> };
export type EventFeedEntry = { eventType: string; repoFullName: string | null; createdAt: string | null };
export type EventsSummary = { total: number; byType: Record<string, number>; recent: EventFeedEntry[] };
export type GovernorSummary = { total: number; byEventType: Record<string, number> };
export type LedgersSummary = { claims: ClaimsSummary; events: EventsSummary; governor: GovernorSummary };

export function emptyLedgersSummary(): LedgersSummary {
  return {
    claims: { total: 0, byStatus: { active: 0, released: 0, expired: 0 } },
    events: { total: 0, byType: {}, recent: [] },
    governor: { total: 0, byEventType: {} },
  };
}

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function summarizeClaims(rows: ClaimRow[]): ClaimsSummary {
  const byStatus: Record<ClaimStatus, number> = { active: 0, released: 0, expired: 0 };
  for (const row of rows) {
    if (typeof row.status === "string" && (CLAIM_STATUSES as readonly string[]).includes(row.status)) {
      byStatus[row.status as ClaimStatus] += 1;
    }
  }
  return { total: rows.length, byStatus };
}

function summarizeEvents(rows: EventRow[]): EventsSummary {
  const byType: Record<string, number> = {};
  for (const row of rows) {
    const type = asString(row.type);
    if (type) byType[type] = (byType[type] ?? 0) + 1;
  }
  // Newest-first, capped — and projected to SAFE columns only (never the raw payload).
  const recent = rows
    .slice(-RECENT_EVENT_LIMIT)
    .reverse()
    .map((row) => ({
      eventType: asString(row.type) ?? "unknown",
      repoFullName: asString(row.repoFullName),
      createdAt: asString(row.createdAt),
    }));
  return { total: rows.length, byType, recent };
}

function summarizeGovernor(rows: GovernorRow[]): GovernorSummary {
  const byEventType: Record<string, number> = {};
  for (const row of rows) {
    const type = asString(row.eventType);
    if (type) byEventType[type] = (byEventType[type] ?? 0) + 1;
  }
  return { total: rows.length, byEventType };
}

export type LedgersApiDeps = {
  loadClaimLedgerModule: () => Promise<ClaimLedgerModule>;
  loadEventLedgerModule: () => Promise<EventLedgerModule>;
  loadGovernorLedgerModule: () => Promise<GovernorLedgerModule>;
  fileExists: (path: string) => boolean;
};

const defaultDeps: LedgersApiDeps = {
  loadClaimLedgerModule: () =>
    import("../../packages/gittensory-miner/lib/claim-ledger.js") as Promise<ClaimLedgerModule>,
  loadEventLedgerModule: () =>
    import("../../packages/gittensory-miner/lib/event-ledger.js") as Promise<EventLedgerModule>,
  loadGovernorLedgerModule: () =>
    import("../../packages/gittensory-miner/lib/governor-ledger.js") as Promise<GovernorLedgerModule>,
  fileExists: existsSync,
};

/** Request handler factored out of the Vite plugin shape so tests drive it directly (mirrors the sibling APIs). */
export async function handleLedgersRequest(
  method: string | undefined,
  url: string | undefined,
  deps: LedgersApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  if (url !== "/api/ledgers" || (method !== undefined && method !== "GET")) return null;
  try {
    const summary = emptyLedgersSummary();

    const claims = await deps.loadClaimLedgerModule();
    if (deps.fileExists(claims.resolveClaimLedgerDbPath())) {
      summary.claims = summarizeClaims(claims.listClaims());
    }
    const events = await deps.loadEventLedgerModule();
    if (deps.fileExists(events.resolveEventLedgerDbPath())) {
      summary.events = summarizeEvents(events.readEvents());
    }
    const governor = await deps.loadGovernorLedgerModule();
    if (deps.fileExists(governor.resolveGovernorLedgerDbPath())) {
      summary.governor = summarizeGovernor(governor.readGovernorEvents());
    }
    return { status: 200, body: JSON.stringify({ summary }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to read the local ledgers";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Vite dev/preview middleware serving the local read-only ledgers endpoint. */
export function ledgersApiPlugin(deps: LedgersApiDeps = defaultDeps): Plugin {
  const attach = (middlewares: {
    use: (
      fn: (
        req: { method?: string; url?: string },
        res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
        next: () => void,
      ) => void,
    ) => void;
  }) => {
    middlewares.use((req, res, next) => {
      void handleLedgersRequest(req.method, req.url, deps).then((handled) => {
        if (!handled) return next();
        res.statusCode = handled.status;
        res.setHeader("Content-Type", "application/json");
        res.end(handled.body);
      });
    });
  };
  return {
    name: "gittensory-miner-ui:ledgers-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
