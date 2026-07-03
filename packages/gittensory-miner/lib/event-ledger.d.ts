export type LedgerEntry = {
  id: number;
  seq: number;
  type: string;
  repoFullName: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AppendEventInput = {
  type: string;
  repoFullName?: string;
  payload: Record<string, unknown>;
};

export type ReadEventsFilter = {
  repoFullName?: string;
  since?: number;
};

export type EventLedger = {
  dbPath: string;
  appendEvent(event: AppendEventInput): LedgerEntry;
  readEvents(filter?: ReadEventsFilter): LedgerEntry[];
  close(): void;
};

export function resolveEventLedgerDbPath(env?: Record<string, string | undefined>): string;

export function initEventLedger(dbPath?: string): EventLedger;

export function appendEvent(event: AppendEventInput): LedgerEntry;

export function readEvents(filter?: ReadEventsFilter): LedgerEntry[];

export function closeDefaultEventLedger(): void;
