import type { ClaimEntry, ClaimLedger, ClaimStatus } from "./claim-ledger.js";

export type ParsedClaimClaimArgs =
  | {
      repoFullName: string;
      issueNumber: number;
      note: string | undefined;
      json: boolean;
    }
  | { error: string };

export type ParsedClaimReleaseArgs =
  | {
      repoFullName: string;
      issueNumber: number;
      json: boolean;
    }
  | { error: string };

export type ParsedClaimListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
      status: ClaimStatus | null;
    }
  | { error: string };

export function parseClaimClaimArgs(args: string[]): ParsedClaimClaimArgs;

export function parseClaimReleaseArgs(args: string[]): ParsedClaimReleaseArgs;

export function parseClaimListArgs(args: string[]): ParsedClaimListArgs;

export function renderClaimsTable(entries: ClaimEntry[]): string;

export function runClaimClaim(
  args: string[],
  options?: { openClaimLedger?: () => ClaimLedger },
): number;

export function runClaimRelease(
  args: string[],
  options?: { openClaimLedger?: () => ClaimLedger },
): number;

export function runClaimList(
  args: string[],
  options?: { openClaimLedger?: () => ClaimLedger },
): number;

export function runClaimCli(
  subcommand: string | undefined,
  args: string[],
  options?: { openClaimLedger?: () => ClaimLedger },
): number;
