export interface LoopClosureEventLedger {
  readEvents(filter?: { since?: number; repoFullName?: string }): Array<{ seq?: number; type?: unknown; repoFullName?: string | null }>;
}

export interface LoopClosurePortfolioQueue {
  listQueue(repoFullName: string | null): Array<{ status?: unknown }>;
}

export interface LoopClosureRunState {
  getRunState(repoFullName: string): string | null;
}

export interface LoopClosureSources {
  eventLedger: LoopClosureEventLedger;
  portfolioQueue: LoopClosurePortfolioQueue;
  runState?: LoopClosureRunState;
}

export interface LoopClosureOptions {
  /** Event-ledger seq at the END of the prior cycle; events with a strictly greater seq are "this cycle". */
  sinceSeq?: number;
  /** Scope the summary to a single repo (its events and queue entries) when set. */
  repoFullName?: string;
}

export interface LoopClosureSummary {
  sinceSeq: number | null;
  /** Highest event seq observed this cycle (>= sinceSeq); the boundary a caller passes as the next cycle's sinceSeq. */
  lastSeq: number;
  events: { total: number; byType: Record<string, number> };
  queue: { total: number; byStatus: Record<string, number> };
  runState: string | null;
}

export function buildLoopClosureSummary(sources: LoopClosureSources, options?: LoopClosureOptions): LoopClosureSummary;
