import type { GovernorLedger, GovernorLedgerEntry } from "./governor-ledger.js";

export type GovernorLedgerEventType = "allowed" | "denied" | "throttled" | "kill_switch";

export type ParsedGovernorListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
      type: GovernorLedgerEventType | null;
    }
  | { error: string };

export function parseGovernorListArgs(args: string[]): ParsedGovernorListArgs;

export function filterGovernorEvents(
  events: GovernorLedgerEntry[],
  options?: { type?: string | null },
): GovernorLedgerEntry[];

export function renderGovernorTable(events: GovernorLedgerEntry[]): string;

export function runGovernorList(
  args: string[],
  options?: { initGovernorLedger?: () => GovernorLedger },
): Promise<number>;

export function runGovernorCli(
  subcommand: string | undefined,
  args: string[],
  options?: { initGovernorLedger?: () => GovernorLedger },
): Promise<number>;
