import type { ClaimEntry, ClaimLedger, ClaimStatus } from "./claim-ledger.js";

export type ParsedClaimsListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
      status: ClaimStatus | null;
    }
  | { error: string };

export type ParsedClaimsClaimArgs =
  | {
      repoFullName: string;
      issueNumber: number;
      note: string | null;
      json: boolean;
    }
  | { error: string };

export type ParsedClaimsReleaseArgs =
  | {
      repoFullName: string;
      issueNumber: number;
      json: boolean;
    }
  | { error: string };

export type ParsedClaimsSweepArgs =
  | {
      json: boolean;
      maxAgeDays: number;
    }
  | { error: string };

export function parseClaimsListArgs(args: string[]): ParsedClaimsListArgs;

export function parseClaimsClaimArgs(args: string[]): ParsedClaimsClaimArgs;

export function parseClaimsReleaseArgs(args: string[]): ParsedClaimsReleaseArgs;

export function parseClaimsSweepArgs(args: string[]): ParsedClaimsSweepArgs;

export function renderClaimsTable(claims: ClaimEntry[]): string;

export function runClaimsList(
  args: string[],
  options?: { openClaimLedger?: () => ClaimLedger },
): number;

export function runClaimsClaim(
  args: string[],
  options?: { openClaimLedger?: () => ClaimLedger },
): number;

export function runClaimsRelease(
  args: string[],
  options?: { openClaimLedger?: () => ClaimLedger },
): number;

export function runClaimsSweep(
  args: string[],
  options?: { openClaimLedger?: () => ClaimLedger; nowMs?: number },
): number;

export function runClaimsCli(
  subcommand: string | undefined,
  args: string[],
  options?: { openClaimLedger?: () => ClaimLedger; nowMs?: number },
): number;
