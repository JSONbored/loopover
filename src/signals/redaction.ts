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

// `PUBLIC_LOCAL_PATH_INLINE` is the canonical local-filesystem-root vocabulary (alternation source only —
// no flags, no anchors), the path analogue of `PUBLIC_UNSAFE_TERMS`. Public surfaces that detect or scrub
// absolute local paths compose from this one source instead of re-typing the root list, so a surface cannot
// drift and miss a root (e.g. `/root/` for container/CI homes, `/var/` for service paths) the canonical
// boundary blocks. It accepts both the back- and forward-slash Windows form (`C:\Users\`, `C:/Users/`). The
// drive letter is matched case-insensitively at the source (`[A-Za-z]`, not `[A-Z]`) so a consumer that omits
// the `i` flag (e.g. the case-sensitive `/g` scrubber in miner-dashboard-recommendations.ts) still redacts a
// lower-case drive like `c:\Users\...`; the unix roots stay literal so case-sensitivity there is the caller's.
export const PUBLIC_LOCAL_PATH_INLINE = String.raw`/Users/|/home/|/root/|/var/|/opt/|/tmp/|[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]Program Files[\\/]`;

// Global scrubber for `.replace()` surfaces that swap an absolute local path for a placeholder: matches a
// root from `PUBLIC_LOCAL_PATH_INLINE` plus the rest of the path segment (stopping at whitespace or a common
// delimiter). Sharing one `/g` constant across modules is safe because `String.prototype.replace` resets
// `lastIndex` after each call (unlike `.test()`, which is why the boundary patterns below stay non-global).
export const PUBLIC_LOCAL_PATH_SCRUB_PATTERN = new RegExp(String.raw`(?:${PUBLIC_LOCAL_PATH_INLINE})[^\s"',;)]*`, "gi");

// Anchored, non-global guard for surfaces that test whether a single path STARTS at a local root (e.g. the
// local-branch repo-path renderer). Non-global so `.test()` stays stateless across calls.
export const PUBLIC_LOCAL_PATH_PREFIX_PATTERN = new RegExp(String.raw`^(?:${PUBLIC_LOCAL_PATH_INLINE})`, "i");

export const PUBLIC_UNSAFE_PATTERN = new RegExp(String.raw`\b(${PUBLIC_UNSAFE_TERMS})\b|${PUBLIC_LOCAL_PATH_INLINE}`, "i");

/** True iff `text` contains nothing that must stay private — i.e. it is safe to surface on a public GitHub surface. */
export function isPublicSafeText(text: string): boolean {
  return !PUBLIC_UNSAFE_PATTERN.test(text);
}
