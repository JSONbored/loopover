import type { AttemptLogEvent } from "@loopover/engine";

export type AttemptLogEntry = {
  id: number;
  seq: number;
  eventType: string;
  attemptId: string;
  actionClass: string;
  mode: string;
  reason: string;
  payload: Record<string, unknown>;
  /** Coding-agent provider name, when the event set one (#5185). Null for every event type that predates this
   *  field. */
  provider: string | null;
  /** Real dollar cost, when the event set one (#5185). Null (not 0) when absent -- never fabricated. */
  costUsd: number | null;
  /** Real token count, when some future driver reports one (#5185). Always null today -- no driver reports real
   *  token usage yet (#5395). */
  tokensUsed: number | null;
  createdAt: string;
};

export type ReadAttemptLogEventsFilter = {
  attemptId?: string | null;
};

export type AttemptLog = {
  dbPath: string;
  appendAttemptLogEvent(event: AttemptLogEvent): AttemptLogEntry;
  readAttemptLogEvents(filter?: ReadAttemptLogEventsFilter): AttemptLogEntry[];
  exportAttemptLogJsonl(attemptId: string): string;
  close(): void;
};

export function resolveAttemptLogDbPath(env?: Record<string, string | undefined>): string;

export function initAttemptLog(dbPath?: string): AttemptLog;

export function appendAttemptLogEvent(event: AttemptLogEvent): AttemptLogEntry;

export function readAttemptLogEvents(filter?: ReadAttemptLogEventsFilter): AttemptLogEntry[];

export function exportAttemptLogJsonl(attemptId: string): string;

export function closeDefaultAttemptLog(): void;
