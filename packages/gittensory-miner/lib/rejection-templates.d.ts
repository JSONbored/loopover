export type RejectionReasonBucket =
  | "gate_close"
  | "maintainer_close_no_reason"
  | "superseded_by_duplicate"
  | "ci_failed";

export function listRejectionTemplateReasons(): RejectionReasonBucket[];
export function renderRejectionTemplate(reason: RejectionReasonBucket): string;

