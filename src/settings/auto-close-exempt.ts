// Shared repo-scoped exemption list (#2463) for gittensory's deterministic anti-abuse auto-close/throttle
// mechanisms — currently the review-nag cooldown; intended to be reused by the per-contributor open-item cap
// (#2270) once that lands, rather than each feature growing its own duplicate whitelist. A maintainer-named
// GitHub login here is NEVER throttled or closed by either mechanism, on top of the standing owner/admin/
// automation-bot exemption every such mechanism already honors. Config-driven and layered the same as other
// settings (`.gittensory.yml` > DB), never hard-coded for any repo. Mirrors contributor-blacklist.ts's shape
// (normalize → validated list + warnings), minus the reason/evidence metadata a ban carries that an exemption
// doesn't need.
// A trailing `[bot]` is a real, common GitHub App-actor login shape (e.g. `dependabot[bot]`, `sentry[bot]`) --
// this is exactly the kind of third-party automation identity a maintainer needs to exempt (a repo-specific bot
// integration the hardcoded, install-wide well-known-bot set in agent-actions.ts has no way to know about), so
// the base GitHub-login pattern (1-39 chars, alphanumeric/single-hyphens) is extended with an optional literal
// `[bot]` suffix rather than rejecting every bot-shaped login outright.
const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}(?:\[bot\])?$/;
const MAX_ENTRIES = 500;

/** Normalize a raw exempt-logins value (DB JSON or `.gittensory.yml`) into a validated, de-duplicated list of
 *  GitHub logins. Never throws: malformed entries are dropped with a warning. De-dup is case-insensitive (the
 *  FIRST occurrence's casing is kept). */
export function normalizeAutoCloseExemptLogins(input: unknown): { logins: string[]; warnings: string[] } {
  const warnings: string[] = [];
  if (input === undefined || input === null) return { logins: [], warnings };
  if (!Array.isArray(input)) {
    warnings.push("autoCloseExemptLogins must be a list of GitHub logins; ignoring it.");
    return { logins: [], warnings };
  }
  const logins: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    if (logins.length >= MAX_ENTRIES) {
      warnings.push(`autoCloseExemptLogins is capped at ${MAX_ENTRIES} entries; dropping the rest.`);
      break;
    }
    if (typeof raw !== "string") {
      warnings.push(`autoCloseExemptLogins[${index}] must be a string login; ignoring it.`);
      continue;
    }
    const login = raw.trim();
    if (!GITHUB_LOGIN.test(login)) {
      warnings.push(`autoCloseExemptLogins[${index}] is not a valid GitHub login; ignoring it.`);
      continue;
    }
    const key = login.toLowerCase();
    if (seen.has(key)) continue; // first occurrence wins
    seen.add(key);
    logins.push(login);
  }
  return { logins, warnings };
}

/** Case-insensitive membership check against the resolved exempt-logins list. Absent/empty list ⇒ never exempt
 *  (the safe default — an unconfigured repo exempts no one beyond the standing owner/admin/bot rule). */
export function isAutoCloseExempt(login: string | null | undefined, exemptLogins: readonly string[] | undefined): boolean {
  if (!login) return false;
  const lower = login.toLowerCase();
  return (exemptLogins ?? []).some((entry) => entry.toLowerCase() === lower);
}
