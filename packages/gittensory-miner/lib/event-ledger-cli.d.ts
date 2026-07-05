import type { EventLedger, LedgerEntry } from "./event-ledger.js";

export type ParsedLedgerListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
      since: number | null;
      type: string | null;
    }
  | { error: string };

export function parseLedgerListArgs(args: string[]): ParsedLedgerListArgs;

export function filterLedgerEvents(
  events: LedgerEntry[],
  options?: { type?: string | null },
): LedgerEntry[];

export function renderLedgerTable(events: LedgerEntry[]): string;

export function runLedgerList(
  args: string[],
  options?: { initEventLedger?: () => EventLedger },
): number;

export function runLedgerCli(
  subcommand: string | undefined,
  args: string[],
  options?: { initEventLedger?: () => EventLedger },
): number;
