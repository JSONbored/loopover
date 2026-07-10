/** An observed claim on an issue: a PR/claimant number plus when it claimed the linked issue (if known). */
export type ObservedClaim = {
  number: number;
  claimedAt?: string | null | undefined;
};

/** The engine `DuplicateClaimMember` shape this module bridges an {@link ObservedClaim} to. */
export type ClaimMember = {
  number: number;
  linkedIssueClaimedAt: string | null;
};

/** The adjudication result: the go/no-go `isWinner`, plus a DISPLAY-only `winnerNumber` (null when not determinable). */
export type ClaimAdjudication = {
  isWinner: boolean;
  winnerNumber: number | null;
};

export function toClaimMember(claim: ObservedClaim): ClaimMember;

export function adjudicateSoftClaim(self: ObservedClaim, competing?: readonly ObservedClaim[]): ClaimAdjudication;
