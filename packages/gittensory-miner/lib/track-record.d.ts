export const PUBLIC_SUMMARY_FIELDS: readonly string[];

export type TrackRecordInput = {
  mergedCount?: number;
  closedCount?: number;
  firstMergedAtIso?: string;
  nowIso?: string;
  incidents?: unknown[];
};

export type TrackRecord = {
  mergedCount: number;
  closedCount: number;
  mergeRatePercent: number;
  tenureDays: number;
  cleanRecord: boolean;
};

export type PublicSummary = {
  mergedCount: number;
  closedCount: number;
  mergeRatePercent: number;
  tenureDays: number;
  cleanRecord: boolean;
};

export function computeTrackRecord(input: TrackRecordInput | null | undefined): TrackRecord;

export function toPublicSummary(
  record: Partial<TrackRecord> | Record<string, unknown> | null | undefined,
): PublicSummary;

export function renderTrackRecordSummary(
  record: Partial<TrackRecord> | Record<string, unknown> | null | undefined,
  options?: { enabled?: boolean },
): string;
