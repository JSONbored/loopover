import type { EventLedger } from "./event-ledger.js";

export type DiscoveredRankedCandidate = {
  repoFullName: string;
  issueNumber: number;
  title: string;
  labels: string[];
  rankScore: number;
};

export type ListDiscoveredRankedCandidatesOptions = {
  eventLedger?: EventLedger;
  initEventLedger?: () => EventLedger;
  repoFullName?: string | null;
};

export function listDiscoveredRankedCandidates(
  options?: ListDiscoveredRankedCandidatesOptions,
): DiscoveredRankedCandidate[];
