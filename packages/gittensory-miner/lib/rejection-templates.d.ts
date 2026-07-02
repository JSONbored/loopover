export type RejectionReasonBucket =
  | "gate_close"
  | "maintainer_close_no_reason"
  | "superseded_by_duplicate"
  | "ci_failed";

export function listRejectionTemplateReasons(): string[];
export function renderRejectionTemplate(reason: RejectionReasonBucket): string;

