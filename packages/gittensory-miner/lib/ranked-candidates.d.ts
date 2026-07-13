export type RankedCandidateInput = {
  repoFullName: string;
  issueNumber: number;
  title?: string;
  htmlUrl?: string | null;
  rankScore: number;
  laneFit?: number;
  freshness?: number;
  potential?: number;
  feasibility?: number;
  dupRisk?: number;
};

export type RankedCandidateRow = {
  repoFullName: string;
  issueNumber: number;
  title: string;
  htmlUrl: string | null;
  rankScore: number;
  laneFit: number;
  freshness: number;
  potential: number;
  feasibility: number;
  dupRisk: number;
  rankedAt: string;
};

export type RankedCandidatesSaveResult = {
  count: number;
  rankedAt: string;
};

export type RankedCandidatesStore = {
  dbPath: string;
  saveRankedCandidates(candidates: RankedCandidateInput[], nowMs?: number): RankedCandidatesSaveResult;
  listRankedCandidates(): RankedCandidateRow[];
  close(): void;
};

export function resolveRankedCandidatesDbPath(env?: Record<string, string | undefined>): string;

export function initRankedCandidatesStore(dbPath?: string): RankedCandidatesStore;

export function saveRankedCandidates(
  candidates: RankedCandidateInput[],
  nowMs?: number,
): RankedCandidatesSaveResult;

export function listRankedCandidates(): RankedCandidateRow[];

export function closeDefaultRankedCandidatesStore(): void;
