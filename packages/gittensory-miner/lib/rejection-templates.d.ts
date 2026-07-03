export type RejectionReason = "gate_close" | "maintainer_close_no_reason" | "superseded_by_duplicate";

export type RejectionContext = {
  repoFullName: string;
  prNumber: number;
};

export const REJECTION_REASONS: readonly RejectionReason[];

export function containsPrivateLanguage(text: string): boolean;

export function renderRejectionMessage(reason: RejectionReason, context: RejectionContext): string;
