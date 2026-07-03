export type GovernorLedgerEntry = {
  id: number;
  ts: string;
  eventType: string;
  repoFullName: string | null;
  actionClass: string;
  decision: string;
  reason: string;
  payload: Record<string, unknown>;
};

export type AppendGovernorEventInput = {
  eventType: string;
  repoFullName?: string | null;
  actionClass: string;
  decision: string;
  reason: string;
  payload?: Record<string, unknown>;
};

export type ReadGovernorEventsFilter = {
  repoFullName?: string | null;
};

export type GovernorLedger = {
  dbPath: string;
  appendGovernorEvent(event: AppendGovernorEventInput): GovernorLedgerEntry;
  readGovernorEvents(filter?: ReadGovernorEventsFilter): GovernorLedgerEntry[];
  close(): void;
};

export function resolveGovernorLedgerDbPath(env?: Record<string, string | undefined>): string;

export function initGovernorLedger(dbPath?: string): GovernorLedger;

export function appendGovernorEvent(event: AppendGovernorEventInput): GovernorLedgerEntry;

export function readGovernorEvents(filter?: ReadGovernorEventsFilter): GovernorLedgerEntry[];

export function closeDefaultGovernorLedger(): void;
