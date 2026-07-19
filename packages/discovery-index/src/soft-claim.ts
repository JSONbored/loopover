// Soft-claim coordination for POST /v1/discovery-index/soft-claim (#7166): lets opted-in miner instances
// avoid starting duplicate work on the same discovered opportunity. Accepts the payload shape
// packages/loopover-engine/src/discovery-soft-claim.ts's buildSoftClaimRequest already produces client-side.
//
// Design note: buildSoftClaimRequest hardcodes `note: null` / `instanceId: null` on the wire -- the shipped
// client contract carries NO caller identity at all, only repoFullName + issueNumber + claimedAt + action.
// So this endpoint's "refresh rather than double-count on repeat calls from the same identifier" (the
// issue's own wording) can only mean: since there is no identity field to distinguish callers, ANY repeat
// "claim" call for a still-active key refreshes its TTL rather than erroring -- the server cannot and does
// not attempt caller-identity tracking the contract doesn't transmit. This module never reads `note` or
// `instanceId` from the incoming payload at all (structural safety, same pattern as discovery-query.ts):
// nothing forbidden can leak into the stored record or the response because nothing but repoFullName/
// issueNumber/action is ever looked at.
import type { TtlCache } from "./cache.js";

export const DEFAULT_SOFT_CLAIM_TTL_MS = 1_800_000; // 30 minutes

export type SoftClaimAction = "claim" | "release";

export interface ParsedSoftClaimRequest {
  repoFullName: string;
  issueNumber: number;
  action: SoftClaimAction;
}

export interface SoftClaimOutcome {
  accepted: boolean;
  /** The existing claim's age in ms when not accepted (already held); null when accepted or on release. */
  ageMs: number | null;
}

/** `owner/repo` with exactly one slash and non-empty halves; anything else -> null. */
function normalizeRepoFullName(value: string): string | null {
  const parts = value.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/**
 * Tolerant parse of an incoming soft-claim request. Returns null (never throws) if `repoFullName` doesn't
 * normalize to `owner/repo`, `issueNumber` isn't a positive integer, or `action` isn't `"claim"`/`"release"`.
 * Deliberately never reads `note`/`instanceId`/any other field -- see this module's header.
 */
export function parseSoftClaimRequest(raw: unknown): ParsedSoftClaimRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const repoFullName = typeof record.repoFullName === "string" ? normalizeRepoFullName(record.repoFullName) : null;
  if (repoFullName === null) return null;
  const issueNumber = record.issueNumber;
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  const action = record.action;
  if (action !== "claim" && action !== "release") return null;
  return { repoFullName, issueNumber, action };
}

export function softClaimKey(repoFullName: string, issueNumber: number): string {
  return `${repoFullName}#${issueNumber}`;
}

interface SoftClaimRecord {
  claimedAt: number;
}

/** The subset of SoftClaimStore the app actually calls — kept as an interface so tests can inject a plain
 *  stub (e.g. one whose methods throw, to exercise the route's error path), mirroring GitHubClientLike in
 *  discovery-query.ts. */
export interface SoftClaimStoreLike {
  claim(key: string): SoftClaimOutcome;
  release(key: string): void;
}

/** Thin TTL-backed claim/release store, reusing cache.ts's TtlCache (the issue's own deliverable: reuse an
 *  existing store rather than adding a new storage mechanism) rather than the discovery-query result/policy
 *  caches themselves, which hold semantically different data. */
export class SoftClaimStore implements SoftClaimStoreLike {
  constructor(
    private readonly cache: TtlCache<SoftClaimRecord>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Accepts a fresh claim, or reports+refreshes an existing unexpired one. `claimedAt` is never reset on a
   *  refresh, so the reported age stays meaningful (how long ago the ORIGINAL claim was made) across repeats. */
  claim(key: string): SoftClaimOutcome {
    const existing = this.cache.get(key);
    if (existing) {
      this.cache.set(key, existing, this.ttlMs);
      return { accepted: false, ageMs: this.now() - existing.claimedAt };
    }
    this.cache.set(key, { claimedAt: this.now() }, this.ttlMs);
    return { accepted: true, ageMs: null };
  }

  /** Idempotent: removing an absent key is a no-op, same as removing a present one. */
  release(key: string): void {
    this.cache.delete(key);
  }
}
