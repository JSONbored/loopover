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
export declare function resolvePredictionLedgerDbPath(env?: Record<string, string | undefined>): string;
/**
 * Opens the append-only prediction ledger, creating the table on first use. Rows are returned in ascending `id`
 * order (insertion order). (#4263)
 */
export declare function initPredictionLedger(dbPath?: string): PredictionLedger;
export declare function appendPrediction(input: AppendPredictionInput): PredictionLedgerEntry;
export declare function readPredictions(filter?: ReadPredictionsFilter): PredictionLedgerEntry[];
export declare function closeDefaultPredictionLedger(): void;
