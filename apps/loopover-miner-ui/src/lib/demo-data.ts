// Demo mode (#5963): a build-time-flagged, zero-backend mock data layer so this dashboard can be deployed as a
// static demo with no real miner harness, local ledger files, or operator credentials behind it -- the same
// mechanism family as loopover-ui's signInPreview() escape hatch (apps/loopover-ui/src/lib/api/session.ts), just
// covering N fabricated API responses instead of one fake session object. `import.meta.env.VITE_DEMO_MODE` is a
// build-time constant, so the "off" branch (the real fetch calls) is dead-code-eliminated from a demo bundle and
// vice versa -- a production self-host build never carries this module's data.
//
// Scope: the six REST fetchers backing the four main dashboard routes (run-history, ledgers, portfolio + its
// queue actions, governor, ranked-candidates (#7675)). discover/attempt/chat are NOT covered here -- those
// trigger a real coding-agent iteration or ground against a live MCP connection, and fabricating a convincing
// multi-minute agent run is a separate, much larger content-design task than tabular summary data (tracked as
// follow-up work, not this PR).
//
// Every value below is entirely synthetic -- no real repo, run, ledger entry, or account referenced anywhere.

import type { RunStateRow } from "./run-history";
import type { LedgersSummary } from "./ledgers";
import type { PortfolioQueueSummary } from "./portfolio-queue";
import type { PortfolioQueueActionItem } from "./portfolio-queue-actions";
import type { GovernorPauseState } from "./governor";
import type { RankedCandidateRow } from "./ranked-candidates";

export function isDemoMode(): boolean {
  return import.meta.env.VITE_DEMO_MODE === "1";
}

export const DEMO_RUN_STATES: RunStateRow[] = [
  {
    apiBaseUrl: "https://forge.example.com",
    repoFullName: "acme/widgets",
    state: "preparing",
    updatedAt: "2026-07-18T14:02:00.000Z",
  },
  {
    apiBaseUrl: "https://forge.example.com",
    repoFullName: "acme/api-gateway",
    state: "discovering",
    updatedAt: "2026-07-18T13:47:00.000Z",
  },
  {
    apiBaseUrl: "https://forge.example.com",
    repoFullName: "acme/docs-site",
    state: "idle",
    updatedAt: "2026-07-18T11:15:00.000Z",
  },
  {
    apiBaseUrl: "https://forge.example.com",
    repoFullName: "northwind/inventory",
    state: "planning",
    updatedAt: "2026-07-18T12:30:00.000Z",
  },
];

export const DEMO_RANKED_CANDIDATES: RankedCandidateRow[] = [
  {
    repoFullName: "acme/widgets",
    issueNumber: 214,
    title: "Add retry helper for flaky forge requests",
    htmlUrl: "https://github.com/acme/widgets/issues/214",
    rankScore: 0.87,
    laneFit: 0.92,
    freshness: 0.81,
    potential: 0.88,
    feasibility: 0.79,
    dupRisk: 0.05,
    rankedAt: "2026-07-18T14:05:00.000Z",
  },
  {
    repoFullName: "acme/api-gateway",
    issueNumber: 58,
    title: "Cache the OpenAPI schema between requests",
    htmlUrl: "https://github.com/acme/api-gateway/issues/58",
    rankScore: 0.74,
    laneFit: 0.7,
    freshness: 0.66,
    potential: 0.8,
    feasibility: 0.72,
    dupRisk: 0.12,
    rankedAt: "2026-07-18T13:50:00.000Z",
  },
  {
    repoFullName: "northwind/inventory",
    issueNumber: 133,
    title: "Fix pagination cursor drift on the audit feed",
    htmlUrl: null,
    rankScore: 0.52,
    laneFit: 0.48,
    freshness: 0.55,
    potential: 0.6,
    feasibility: 0.5,
    dupRisk: 0.35,
    rankedAt: "2026-07-18T12:20:00.000Z",
  },
];

export const DEMO_LEDGERS_SUMMARY: LedgersSummary = {
  claims: { total: 18, byStatus: { active: 3, released: 12, expired: 3 } },
  events: {
    total: 142,
    byType: { claimed: 41, released: 38, event_recorded: 63 },
    recent: [
      { eventType: "claimed", repoFullName: "acme/widgets", createdAt: "2026-07-18T14:00:00.000Z" },
      { eventType: "released", repoFullName: "acme/api-gateway", createdAt: "2026-07-18T13:45:00.000Z" },
      { eventType: "event_recorded", repoFullName: "acme/docs-site", createdAt: "2026-07-18T11:10:00.000Z" },
      { eventType: "claimed", repoFullName: "northwind/inventory", createdAt: "2026-07-18T09:30:00.000Z" },
      { eventType: "released", repoFullName: "acme/widgets", createdAt: "2026-07-17T22:14:00.000Z" },
    ],
  },
  governor: { total: 9, byEventType: { paused: 4, resumed: 5 } },
};

export const DEMO_PORTFOLIO_QUEUE_SUMMARY: PortfolioQueueSummary = {
  total: 27,
  byStatus: { queued: 9, in_progress: 3, done: 15 },
  repos: [
    {
      repoFullName: "acme/widgets",
      apiBaseUrl: "https://forge.example.com",
      byStatus: { queued: 4, in_progress: 1, done: 6 },
      total: 11,
    },
    {
      repoFullName: "acme/api-gateway",
      apiBaseUrl: "https://forge.example.com",
      byStatus: { queued: 2, in_progress: 1, done: 4 },
      total: 7,
    },
    {
      repoFullName: "acme/docs-site",
      apiBaseUrl: "https://forge.example.com",
      byStatus: { queued: 1, in_progress: 0, done: 3 },
      total: 4,
    },
    {
      repoFullName: "northwind/inventory",
      apiBaseUrl: "https://forge.example.com",
      byStatus: { queued: 2, in_progress: 1, done: 2 },
      total: 5,
    },
  ],
  oldestQueuedAgeMs: 6 * 60 * 60 * 1000, // 6h
};

// Every actionable (in_progress/done) row the fleet's DEMO_PORTFOLIO_QUEUE_SUMMARY reports (#7227): 3
// in_progress + 15 done = 18, so the demo "Queue actions" table can't visibly disagree with the status cards.
// The per-repo in_progress/done split also matches each repo's summary byStatus (widgets 1/6, api-gateway 1/4,
// docs-site 0/3, inventory 1/2) -- only the summary's `queued` rows, which PortfolioQueueActionItem can't
// represent, are absent. Entirely synthetic: only the four demo repos and the existing wgt-/gw-/docs-/inv- ids.
const FORGE = "https://forge.example.com";
const DEFAULT_DEMO_PORTFOLIO_QUEUE_ITEMS: PortfolioQueueActionItem[] = [
  // acme/widgets — 1 in_progress, 6 done
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2451", status: "in_progress" },
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2438", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2402", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2377", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2340", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2311", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2288", status: "done" },
  // acme/api-gateway — 1 in_progress, 4 done
  { apiBaseUrl: FORGE, repoFullName: "acme/api-gateway", identifier: "gw-118", status: "in_progress" },
  { apiBaseUrl: FORGE, repoFullName: "acme/api-gateway", identifier: "gw-104", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/api-gateway", identifier: "gw-97", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/api-gateway", identifier: "gw-83", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/api-gateway", identifier: "gw-76", status: "done" },
  // acme/docs-site — 0 in_progress, 3 done
  { apiBaseUrl: FORGE, repoFullName: "acme/docs-site", identifier: "docs-58", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/docs-site", identifier: "docs-51", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/docs-site", identifier: "docs-49", status: "done" },
  // northwind/inventory — 1 in_progress, 2 done
  { apiBaseUrl: FORGE, repoFullName: "northwind/inventory", identifier: "inv-77", status: "in_progress" },
  { apiBaseUrl: FORGE, repoFullName: "northwind/inventory", identifier: "inv-71", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "northwind/inventory", identifier: "inv-64", status: "done" },
];

// Mutable, in-memory, browser-session-only copy -- release/requeue removes the item from this actionable list
// (simulating it going back to "queued", which this endpoint doesn't itself track), same session-only-state
// reasoning as the governor pause state below: a demo control that visibly does nothing is a worse demo than
// one that responds, and there's no real queue here to protect from a fabricated write.
let demoPortfolioQueueItems: PortfolioQueueActionItem[] = [...DEFAULT_DEMO_PORTFOLIO_QUEUE_ITEMS];

export function getDemoPortfolioQueueItems(): PortfolioQueueActionItem[] {
  return demoPortfolioQueueItems;
}

/** Remove one item (by repoFullName + identifier) from the demo actionable list, simulating a release/requeue.
 *  Returns the removed item, or null if no matching item was found (mirrors the real API's not-found shape). */
export function removeDemoPortfolioQueueItem(
  repoFullName: string,
  identifier: string,
): PortfolioQueueActionItem | null {
  const index = demoPortfolioQueueItems.findIndex(
    (item) => item.repoFullName === repoFullName && item.identifier === identifier,
  );
  if (index === -1) return null;
  const [removed] = demoPortfolioQueueItems.splice(index, 1);
  // A valid index always has exactly one element to splice out; the fallback only guards the array-access
  // type, not a real runtime path.
  return removed ?? null;
}

/** Test-only: restores the module-level mutable demo state (governor pause state + queue items) to its
 *  defaults, so one test's release/pause doesn't leak into the next. Never called from app code. */
export function resetDemoDataForTest(): void {
  demoPortfolioQueueItems = [...DEFAULT_DEMO_PORTFOLIO_QUEUE_ITEMS];
  demoGovernorState = { paused: false, reason: null, pausedAt: null };
}

// Mutable, in-memory, browser-session-only -- pause/resume is harmless to actually simulate (no real governor,
// nothing to protect), and a static read-only demo of a control that visibly does nothing is a worse demo than
// one that responds. Resets to this default on every page reload; never persisted anywhere.
let demoGovernorState: GovernorPauseState = { paused: false, reason: null, pausedAt: null };

export function getDemoGovernorState(): GovernorPauseState {
  return demoGovernorState;
}

export function setDemoGovernorPaused(reason: string | null): GovernorPauseState {
  demoGovernorState = { paused: true, reason, pausedAt: new Date().toISOString() };
  return demoGovernorState;
}

export function setDemoGovernorResumed(): GovernorPauseState {
  demoGovernorState = { paused: false, reason: null, pausedAt: null };
  return demoGovernorState;
}
