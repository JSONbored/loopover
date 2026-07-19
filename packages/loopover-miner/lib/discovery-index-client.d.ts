import type { DiscoveryIndexQuery, DiscoveryIndexResponse } from "@loopover/engine";

export const DISCOVERY_PLANE_FLAG: string;
export const DISCOVERY_INDEX_URL_FLAG: string;
export const DISCOVERY_TELEMETRY_FLAG: string;

export type DiscoveryIndexClientOptions = {
  env?: Record<string, string | undefined>;
  /** Always called as `fetchImpl(url, init)` with a plain string URL -- narrower than `typeof fetch` on
   *  purpose, since that's the only shape this module ever actually calls it with. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
};

/** The shape claim-ledger.js's rowToClaim (and claimIssueWithinCap(...).claim) already produces -- passed
 *  straight into @loopover/engine's buildSoftClaimRequest with no translation. */
export type SoftClaimLedgerRecord = {
  repoFullName: string;
  issueNumber: number;
  claimedAt: string;
  status: "active" | "released" | "expired";
  note?: string | null;
};

export function isDiscoveryPlaneEnabled(env?: Record<string, string | undefined>): boolean;

export function isDiscoveryTelemetryEnabled(env?: Record<string, string | undefined>): boolean;

export function queryDiscoveryIndex(
  query: Partial<DiscoveryIndexQuery>,
  options?: DiscoveryIndexClientOptions,
): Promise<DiscoveryIndexResponse>;

export function submitSoftClaim(
  claim: SoftClaimLedgerRecord,
  options?: DiscoveryIndexClientOptions,
): Promise<{ sent: boolean }>;

export function recordDiscoveryTelemetry(
  event: string,
  outcome: string,
  options?: { env?: Record<string, string | undefined> },
): void;
