import type { RejectionReason, RejectionContext } from "./rejection-templates.js";

export type PrOutcomeFields = {
  state: string | null;
  merged: boolean;
  mergedAt: string | null;
  closedAt: string | null;
};

export type RejectionSignal = {
  gateClosed?: boolean;
  supersededByDuplicate?: boolean;
};

export type RejectionTransition = {
  outcome: "disengaged";
  reason: RejectionReason;
  note: string;
  fields: PrOutcomeFields;
};

/** Per-PR terminal outcome for a rejected (closed-without-merge) PR. */
export const DISENGAGED_OUTCOME: "disengaged";

export function extractPrOutcomeFields(prPayload: unknown): PrOutcomeFields;

export function isRejectedPr(
  fields: { state?: string | null; merged?: boolean } | null | undefined,
): boolean;

export function classifyRejectionReason(signal?: RejectionSignal): RejectionReason;

export function resolveRejection(
  prPayload: unknown,
  signal: RejectionSignal | undefined,
  context: RejectionContext,
): RejectionTransition | null;
