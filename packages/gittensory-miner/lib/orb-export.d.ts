import type { NormalizedPrOutcomePayload, PrOutcomeLedgerReader } from "./pr-outcome.js";

/** OPT-IN default: a laptop miner exports nothing unless a contributor turns it on. */
export const ORB_EXPORT_ENABLED_BY_DEFAULT: false;

/** One anonymized outcome in an export batch — no raw repo name, PR number, or free-text reason. */
export interface OrbExportRow {
  repoHash: string;
  prHash: string;
  decision: string;
  reasonBucket: string;
  closedAt: string | null;
}

/** The local orb-export store: the per-instance anonymization secret + export cursor, in local SQLite. */
export interface OrbExportStore {
  dbPath: string;
  getOrCreateAnonSecret(): string;
  getCursor(): string | null;
  setCursor(cursor: string): void;
  close(): void;
}

/** A pr_outcome record as produced by `readPrOutcomes` (the local ledger's latest-per-PR reduction). */
export type OrbExportOutcome = NormalizedPrOutcomePayload & { repoFullName: string };

export function resolveOrbExportDbPath(env?: Record<string, string | undefined>): string;

export function hmacAnonymize(value: string | number, secret: string): string;

export function buildAnonymizedOrbBatch(
  outcomes: Iterable<OrbExportOutcome> | Map<string, OrbExportOutcome>,
  secret: string,
): OrbExportRow[];

export function openOrbExportStore(dbPath?: string): OrbExportStore;

export function collectOrbExportBatch(options?: {
  store: OrbExportStore;
  eventLedger: PrOutcomeLedgerReader;
  enabled?: boolean;
}): OrbExportRow[] | null;

export type ParsedOrbExportArgs = { json: boolean; enable: boolean } | { error: string };

export function parseOrbExportArgs(args: string[]): ParsedOrbExportArgs;

export function runOrbExportCli(
  args: string[],
  options?: {
    openOrbExportStore?: () => OrbExportStore;
    initEventLedger?: () => PrOutcomeLedgerReader;
  },
): number;
