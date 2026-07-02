const REJECTION_TEMPLATE_MAP = {
  gate_close:
    "This attempt is closed by the project gate for now. We will address the listed checks and only retry with a clean, fully validated update.",
  maintainer_close_no_reason:
    "This attempt is closed by maintainers. We will pause, re-check repository expectations, and only continue when we can satisfy the project standards.",
  superseded_by_duplicate:
    "This attempt is closed because overlapping work already exists. We will avoid duplicate effort and align future updates with the active thread.",
  ci_failed:
    "This attempt is closed after CI failure. We will resolve every failing check and only retry when validation is fully green.",
};

const FORBIDDEN_PUBLIC_TOKENS = [
  "wallet",
  "hotkey",
  "coldkey",
  "mnemonic",
  "reward",
  "score",
  "farming",
  "payout",
  "ranking",
  "trust score",
  "reviewability",
];

const unresolvedPlaceholderPattern = /\{\{[^}]+\}\}/;

const forbiddenPublicPattern = new RegExp(
  `\\b(?:${FORBIDDEN_PUBLIC_TOKENS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|")})\\b`,
  "i",
);

export function listRejectionTemplateReasons() {
  return Object.keys(REJECTION_TEMPLATE_MAP);
}

export function renderRejectionTemplate(reason) {
  const template = REJECTION_TEMPLATE_MAP[reason];
  if (!template) {
    throw new Error(`unknown_rejection_reason:${reason}`);
  }
  const message = template.trim().replace(/\s+/g, " ");
  if (unresolvedPlaceholderPattern.test(message)) {
    throw new Error(`unresolved_placeholder:${reason}`);
  }
  if (forbiddenPublicPattern.test(message)) {
    throw new Error(`private_language_token:${reason}`);
  }
  return message;
}

