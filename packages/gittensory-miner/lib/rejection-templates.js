// CoC-compliant rejection message templates (#2324). When one of the miner's PRs is closed/rejected, it may leave
// a single, final, human-readable local note (e.g. in a run summary or CLI output — posting anywhere is a separate
// write action, out of scope here). The note must be courteous, non-defensive, and never re-litigate the
// maintainer's decision. This module is pure content/formatting: static template strings + a deterministic
// renderer — no GitHub calls, no LLM, no network. Same inputs always render the same message.

// Templates keyed by rejection-reason bucket. Every placeholder is `{name}`; the renderer resolves the structured
// context (a PR number + a repo) and never interpolates free-form/private text.
const REASON_TEMPLATES = {
  gate_close:
    "The automated review gate closed PR #{prNumber} on {repoFullName}. Thanks for the review — I'll address the flagged points and open a fresh PR if the change still fits.",
  maintainer_close_no_reason:
    "PR #{prNumber} on {repoFullName} was closed by the maintainer. Thanks for taking the time to look — I'll leave it here unless you'd like me to revisit it.",
  superseded_by_duplicate:
    "PR #{prNumber} on {repoFullName} looks superseded by other work on the same issue, so I'm closing it on my side to avoid duplication. Thanks to whoever is carrying it forward.",
};

/** The supported rejection-reason buckets, in declaration order. */
export const REJECTION_REASONS = Object.freeze(Object.keys(REASON_TEMPLATES));

// Private-language tokens that must never surface in a public-facing courtesy note (mirrors the redaction set in
// `sanitizePublicComment`, src/github/commands.ts). Templates are authored clean and this is asserted in tests;
// the structured context (a PR number + a validated `owner/repo`) carries no private scoring/reward/wallet data,
// so — deliberately — no value-level redaction is applied that could mangle a legitimate repo name.
const PRIVATE_LANGUAGE =
  /\b(?:raw trust scores?|trust scores?|wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?|payouts?|rewards?)\b/i;

/** True when the given text contains any banned private-language token. */
export function containsPrivateLanguage(text) {
  return PRIVATE_LANGUAGE.test(text);
}

// A GitHub `owner/repo`: owner is 1-39 chars of alphanumerics/hyphens starting alphanumeric; repo is
// alphanumerics/`.`/`_`/`-`. Anchored + character-class-restricted so control characters, whitespace, markup, or an
// extra `/` (e.g. `owner/repo\nextra`, `owner/<repo>`) are rejected — the note interpolates this text directly, so a
// malformed value must throw rather than leak caller-controlled display text.
const GITHUB_FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

function normalizeRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const trimmed = repoFullName.trim();
  if (!GITHUB_FULL_NAME.test(trimmed)) throw new Error("invalid_repo_full_name");
  return trimmed;
}

function normalizePrNumber(prNumber) {
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error("invalid_pr_number");
  return prNumber;
}

/**
 * Render the courtesy note for a closed/rejected PR. `reason` must be one of {@link REJECTION_REASONS}; `context`
 * supplies `repoFullName` (`owner/repo`) and `prNumber` (a positive integer). Throws on an unknown reason, a
 * malformed context, or (defensively) any placeholder a template leaves unresolved — so a caller can never emit a
 * half-rendered note. Pure and deterministic.
 */
export function renderRejectionMessage(reason, context = {}) {
  const template = REASON_TEMPLATES[reason];
  if (template === undefined) throw new Error("invalid_rejection_reason");
  const values = {
    repoFullName: normalizeRepoFullName(context.repoFullName),
    prNumber: normalizePrNumber(context.prNumber),
  };
  const rendered = template.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = values[key];
    if (value === undefined) throw new Error(`missing_placeholder:${key}`);
    return String(value);
  });
  if (/\{[^}]+\}/.test(rendered)) throw new Error("unresolved_placeholder");
  return rendered;
}
