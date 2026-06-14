// #542: the canonical public/private boundary primitive. Any text destined for a PUBLIC surface — PR/issue
// comments, check annotations, notifications, badge, extension payloads, slop/advisory reasons — must pass
// `isPublicSafeText` first, so a single regex governs redaction and new surfaces cannot drift their own copy.
//
// It rejects gittensor economic/identity signals (rewards, raw/trust score, wallet/hotkey/coldkey/mnemonic,
// farming, payout, ranking, (private) reviewability) and local filesystem paths.
//
// The pattern is intentionally NON-GLOBAL so `.test()` stays stateless (no `lastIndex` carry-over between
// calls) and the exported constant can be reused safely across call sites and modules.
export const PUBLIC_UNSAFE_PATTERN =
  /\b(reward\w*|score\w*|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability)\b|\/Users\/|\/home\/|\/tmp\/|[A-Z]:[\\/]Users[\\/]/i;

/** True iff `text` contains nothing that must stay private — i.e. it is safe to surface on a public GitHub surface. */
export function isPublicSafeText(text: string): boolean {
  return !PUBLIC_UNSAFE_PATTERN.test(text);
}
