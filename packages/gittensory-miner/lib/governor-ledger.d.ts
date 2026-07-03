export type GovernorEventType = "allowed" | "denied" | "throttled" | "kill_switch_tripped";

export type GovernorLedgerEntry = {
  id: number;
  seq: number;
  ts: string;
  type: GovernorEventType;
  repoFullName: string | null;
  actionClass: string | null;
  decision: GovernorEventType | null;
  reason: string | null;
  payload: Record<string, unknown>;
};

export type AppendGovernorEventInput = {
  type: GovernorEventType;
  repoFullName?: string;
  actionClass?: string;
  decision?: GovernorEventType;
  reason?: string;
  payload: Record<string, unknown>;
};

export type ReadGovernorEventsFilter = {
  repoFullName?: string;
  since?: number;
};

export type GovernorLedger = {
  dbPath: string;
  appendEvent(event: AppendGovernorEventInput): GovernorLedgerEntry;
  readEvents(filter?: ReadGovernorEventsFilter): GovernorLedgerEntry[];
  close(): void;
};

export function resolveGovernorLedgerDbPath(env?: Record<string, string | undefined>): string;

export function initGovernorLedger(dbPath?: string): GovernorLedger;

export function appendEvent(event: AppendGovernorEventInput): GovernorLedgerEntry;

export function readEvents(filter?: ReadGovernorEventsFilter): GovernorLedgerEntry[];

export function closeDefaultGovernorLedger(): void;