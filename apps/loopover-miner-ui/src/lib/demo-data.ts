// Demo mode (#5963): a build-time-flagged, zero-backend mock data layer so this dashboard can be deployed as a
// static demo with no real miner harness, local ledger files, or operator credentials behind it -- the same
// mechanism family as loopover-ui's signInPreview() escape hatch (apps/loopover-ui/src/lib/api/session.ts), just
// covering N fabricated API responses instead of one fake session object. `import.meta.env.VITE_DEMO_MODE` is a
// build-time constant, so the "off" branch (the real fetch calls) is dead-code-eliminated from a demo bundle and
// vice versa -- a production self-host build never carries this module's data.
//
// Scope: the five REST fetchers backing the three main dashboard routes (run-history, ledgers, portfolio +
// its queue actions, governor). discover/attempt/chat are NOT covered here -- those trigger a real coding-agent
// iteration or ground against a live MCP connection, and fabricating a convincing multi-minute agent run is a
// separate, much larger content-design task than tabular summary data (tracked as follow-up work, not this PR).
//
// Every value below is entirely synthetic -- no real repo, run, ledger entry, or account referenced anywhere.

import type { RunStateRow } from "./run-history";
import type { LedgersSummary } from "./ledgers";
import type { PortfolioQueueSummary } from "./portfolio-queue";
import type { PortfolioQueueActionItem } from "./portfolio-queue-actions";
import type { GovernorPauseState } from "./governor";

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

// Every actionable (in_progress/done) row the fleet's DEMO_PORTFOLIO_QUEUE_SUMMARY.byStatus reports (#7227):
// exactly 3 in_progress and 15 done, so the demo "Queue actions" table can't visibly disagree with the status
// cards above it. Entirely synthetic -- only the four demo repos and the existing wgt-/gw-/docs-/inv- id style.
const FORGE = "https://forge.example.com";
const DEFAULT_DEMO_PORTFOLIO_QUEUE_ITEMS: PortfolioQueueActionItem[] = [
  // 3 in_progress
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2451", status: "in_progress" },
  { apiBaseUrl: FORGE, repoFullName: "acme/api-gateway", identifier: "gw-118", status: "in_progress" },
  { apiBaseUrl: FORGE, repoFullName: "acme/docs-site", identifier: "docs-64", status: "in_progress" },
  // 15 done
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2438", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2402", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2377", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2340", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/api-gateway", identifier: "gw-104", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/api-gateway", identifier: "gw-97", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/api-gateway", identifier: "gw-83", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/docs-site", identifier: "docs-58", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/docs-site", identifier: "docs-51", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/docs-site", identifier: "docs-49", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "northwind/inventory", identifier: "inv-77", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "northwind/inventory", identifier: "inv-71", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/widgets", identifier: "wgt-2311", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/api-gateway", identifier: "gw-76", status: "done" },
  { apiBaseUrl: FORGE, repoFullName: "acme/docs-site", identifier: "docs-42", status: "done" },
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
