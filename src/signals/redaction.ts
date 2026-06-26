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
// Pluralizable nouns share one trailing `\w*`: callers wrap this in `\b(…)\b`, so a bare term's closing
// boundary would land before a plural "s" and leak it ("wallets", "payouts"); `farming` and the compounds stay bare.
//
// NOTE: two other public surfaces — `agent-action-explanation-card.ts` and `miner-dashboard-recommendations.ts`
// — keep their own context-specific, phrase-tuned vocabularies (they redact whole phrases like "public score
// estimate" and extra terms like "seed phrase"/"private key" for cleaner output, and deliberately do not
// redact a bare "score"/"reward"). Those are curated for their surface, not drift of this core, so they are
// intentionally NOT collapsed onto `PUBLIC_UNSAFE_TERMS`.
export const PUBLIC_UNSAFE_TERMS = String.raw`(?:reward|score|wallet|hotkey|coldkey|mnemonic|payout|ranking)\w*|farming|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability`;

/** Posix local path roots that must not appear on public surfaces. */
export const PUBLIC_LOCAL_PATH_ROOTS = String.raw`/Users/|/home/|/root/|/tmp/|/var/`;

/** Windows user-profile paths that must not appear on public surfaces. */
export const PUBLIC_LOCAL_PATH_WINDOWS = String.raw`[A-Z]:[\\/]Users[\\/]`;

/** Inline alternation for composing boundary patterns (non-global). */
export const PUBLIC_LOCAL_PATH_INLINE = `${PUBLIC_LOCAL_PATH_ROOTS}|${PUBLIC_LOCAL_PATH_WINDOWS}`;

/** Prefix test for absolute changed-file paths (anchored at start). */
export const PUBLIC_LOCAL_PATH_PREFIX_PATTERN = new RegExp(
  String.raw`^(\/Users\/|\/home\/|\/root\/|\/tmp\/|\/var\/|[A-Z]:\/Users\/)`,
  "i",
);

/** Global scrubber for known local path roots in free-form text. */
export const PUBLIC_LOCAL_PATH_SCRUB_PATTERN = new RegExp(
  String.raw`(?:\/Users|\/home|\/root|\/tmp|\/var)\/[^\s"',;:)]*|[A-Za-z]:\\Users\\[^\s"',;)]*`,
  "g",
);

export const PUBLIC_UNSAFE_PATTERN = new RegExp(String.raw`\b(${PUBLIC_UNSAFE_TERMS})\b|${PUBLIC_LOCAL_PATH_INLINE}`, "i");

/** True when `text` contains a known local filesystem path root. */
export function containsPublicLocalPath(text: string): boolean {
  return new RegExp(PUBLIC_LOCAL_PATH_INLINE, "i").test(text);
}

/** Replace known local filesystem path roots with `replacement`. */
export function redactPublicLocalPaths(text: string, replacement = "<redacted-path>"): string {
  return text.replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, replacement);
}

/** True iff `text` contains nothing that must stay private — i.e. it is safe to surface on a public GitHub surface. */
export function isPublicSafeText(text: string): boolean {
  return !PUBLIC_UNSAFE_PATTERN.test(text);
}
