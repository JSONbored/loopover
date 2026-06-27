// Contributor blacklist (#1425, anti-abuse). Pure resolution + matching for the banned-login list the converged
// engine acts on. Config-driven and layered the same as other settings (`.gittensory.yml` > DB) and unioned with
// the shared/global list at the point of use — NEVER hard-coded for any repo. Logins are public data; entries
// may carry private maintainer metadata, so public surfaces must not echo it. Mirrors the shape of
// command-authorization.ts (normalize → typed policy + warnings).
import type { ContributorBlacklistEntry } from "../types";

// GitHub logins: 1–39 chars, alphanumeric or single hyphens (not leading/trailing). Anything else is dropped so a
// malformed entry can never widen the match or break the close path.
const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const MAX_ENTRIES = 1000;
const MAX_REASON_CHARS = 200;
const MAX_EVIDENCE = 10;
const MAX_EVIDENCE_CHARS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalize a raw blacklist value (DB JSON or `.gittensory.yml`) into validated, de-duplicated entries. Never
 *  throws: malformed entries are dropped with a warning. De-dup is by case-insensitive login (the FIRST wins, so
 *  its richer metadata is kept). */
export function normalizeContributorBlacklist(input: unknown): { entries: ContributorBlacklistEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  if (input === undefined || input === null) return { entries: [], warnings };
  if (!Array.isArray(input)) {
    warnings.push("contributorBlacklist must be a list of entries; ignoring it.");
    return { entries: [], warnings };
  }
  const entries: ContributorBlacklistEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    if (entries.length >= MAX_ENTRIES) {
      warnings.push(`contributorBlacklist is capped at ${MAX_ENTRIES} entries; dropping the rest.`);
      break;
    }
    // Accept either a bare login string or a `{ login, ... }` object.
    const record = typeof raw === "string" ? { login: raw } : raw;
    if (!isRecord(record) || typeof record.login !== "string") {
      warnings.push(`contributorBlacklist[${index}] needs a string login; ignoring it.`);
      continue;
    }
    const login = record.login.trim();
    if (!GITHUB_LOGIN.test(login)) {
      warnings.push(`contributorBlacklist[${index}].login is not a valid GitHub login; ignoring it.`);
      continue;
    }
    const key = login.toLowerCase();
    if (seen.has(key)) continue; // first occurrence wins
    seen.add(key);
    const entry: ContributorBlacklistEntry = { login };
    if (typeof record.reason === "string" && record.reason.trim().length > 0) entry.reason = record.reason.trim().slice(0, MAX_REASON_CHARS);
    if (Array.isArray(record.evidence)) {
      const evidence = record.evidence.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0).map((ref) => ref.trim().slice(0, MAX_EVIDENCE_CHARS)).slice(0, MAX_EVIDENCE);
      if (evidence.length > 0) entry.evidence = evidence;
    }
    if (typeof record.addedAt === "string" && record.addedAt.trim().length > 0) entry.addedAt = record.addedAt.trim();
    entries.push(entry);
  }
  return { entries, warnings };
}

/** The blacklist entry matching `login` (case-insensitive), or null. Tolerates an absent list (treated as empty)
 *  so callers can pass the optional `settings.contributorBlacklist` directly. */
export function findBlacklistEntry(login: string | null | undefined, entries: ContributorBlacklistEntry[] | undefined): ContributorBlacklistEntry | null {
  if (!login) return null;
  const key = login.toLowerCase();
  return (entries ?? []).find((entry) => entry.login.toLowerCase() === key) ?? null;
}

/** True iff `login` is on the resolved blacklist. */
export function isAuthorBlacklisted(login: string | null | undefined, entries: ContributorBlacklistEntry[] | undefined): boolean {
  return findBlacklistEntry(login, entries) !== null;
}

/** Union multiple blacklist sources (e.g. the shared/global list + the per-repo list) by case-insensitive login.
 *  A login on ANY source is blocked; the FIRST source's entry wins on a duplicate so earlier (more authoritative)
 *  metadata is preserved. Already-normalized inputs in, de-duplicated entries out. */
export function mergeContributorBlacklists(...lists: ContributorBlacklistEntry[][]): ContributorBlacklistEntry[] {
  const merged: ContributorBlacklistEntry[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const entry of list) {
      const key = entry.login.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}
