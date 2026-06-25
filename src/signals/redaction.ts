// #542: the canonical public/private boundary primitive. Any text destined for a PUBLIC surface — PR/issue
// comments, check annotations, notifications, badge, extension payloads, slop/advisory reasons — must pass
// `isPublicSafeText` first, so a single regex governs redaction and new surfaces cannot drift their own copy.
//
// It rejects gittensor economic/identity signals (rewards, raw/trust score, wallet/hotkey/coldkey/mnemonic,
// farming, payout, ranking, (private) reviewability) and local filesystem paths.
//
// The pattern is intentionally NON-GLOBAL so `.test()` stays stateless (no `lastIndex` carry-over between
// calls) and the exported constant can be reused safely across call sites and modules.
//
// `PUBLIC_UNSAFE_TERMS` is the canonical economic/identity term vocabulary (alternation source only — no
// flags, no `\b` anchors), so a surface that redacts/gates with these terms can compose from one source
// instead of re-typing the list and drifting. `pr-body-draft.ts` builds its scrubber + final guard from it.
//
// NOTE: two other public surfaces — `agent-action-explanation-card.ts` and `miner-dashboard-recommendations.ts`
// — keep their own context-specific, phrase-tuned vocabularies (they redact whole phrases like "public score
// estimate" and extra terms like "seed phrase"/"private key" for cleaner output, and deliberately do not
// redact a bare "score"/"reward"). Those are curated for their surface, not drift of this core, so they are
// intentionally NOT collapsed onto `PUBLIC_UNSAFE_TERMS`.
export const PUBLIC_UNSAFE_TERMS = String.raw`reward\w*|score\w*|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability`;

export const PUBLIC_UNSAFE_PATTERN = new RegExp(String.raw`\b(${PUBLIC_UNSAFE_TERMS})\b|/Users/|/home/|/root/|/tmp/|[A-Z]:[\\/]Users[\\/]`, "i");

/** True iff `text` contains nothing that must stay private — i.e. it is safe to surface on a public GitHub surface. */
export function isPublicSafeText(text: string): boolean {
  return !PUBLIC_UNSAFE_PATTERN.test(text);
}
