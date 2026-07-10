import type { AttemptLogEvent } from "@jsonbored/gittensory-engine";

export type AttemptLogEntry = {
  id: number;
  seq: number;
  eventType: string;
  attemptId: string;
  actionClass: string;
  mode: string;
  reason: string;
  payload: Record<string, unknown>;
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
