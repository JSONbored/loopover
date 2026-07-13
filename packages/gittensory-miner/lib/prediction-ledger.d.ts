export type PredictionLedgerEntry = {
  id: number;
  ts: string;
  repoFullName: string;
  targetId: number;
  headSha: string | null;
  conclusion: string;
  pack: string;
  readinessScore: number | null;
  blockerCodes: string[];
  warningCodes: string[];
  engineVersion: string;
};

export type AppendPredictionInput = {
  repoFullName: string;
  targetId: number;
  headSha?: string | null;
  conclusion: string;
  pack: string;
  readinessScore?: number | null;
  blockerCodes?: string[];
  warningCodes?: string[];
  engineVersion: string;
};

export type ReadPredictionsFilter = {
  repoFullName?: string | null;
};

export type PredictionLedger = {
  dbPath: string;
  appendPrediction(input: AppendPredictionInput): PredictionLedgerEntry;
  readPredictions(filter?: ReadPredictionsFilter): PredictionLedgerEntry[];
  purgeByRepo(repoFullName: string): number;
  close(): void;
};

export function resolvePredictionLedgerDbPath(env?: Record<string, string | undefined>): string;

export function initPredictionLedger(dbPath?: string): PredictionLedger;

export function appendPrediction(input: AppendPredictionInput): PredictionLedgerEntry;

export function readPredictions(filter?: ReadPredictionsFilter): PredictionLedgerEntry[];

export function closeDefaultPredictionLedger(): void;
