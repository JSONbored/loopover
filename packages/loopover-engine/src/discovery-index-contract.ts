// Discovery-index API contract (#4300). The typed request/response shape a miner uses to query the OPTIONAL hosted
// discovery-index service (the server side is #4250, maintainer-only, explicitly blocked on this contract). The
// plane exists to mitigate the rate-limit incident (#1936): one shared GitHub-metadata crawler across the fleet
// instead of every miner independently hammering the same repos' search/listing endpoints.
//
// This module is schema/shape ONLY — no server, no deployed endpoint, no client HTTP. It stays inside the Phase 1
// boundary (packages/loopover-miner/docs/cross-repo-discovery-phase1.md): metadata-only, GET/list/search-only,
// and NO raw scores / rewards / wallet / hotkey data / source contents crossing the public boundary. The response
// candidate shape deliberately maps onto opportunity-ranker.js's `normalizeCandidate` fields so a miner can swap a
// local fan-out for a hosted query without the ranker changing. Tolerant-parser convention, mirroring
// miner-goal-spec.ts / fleet-run-manifest.ts: every field optional, malformed input degrades to a documented
// default with a warning rather than throwing.

export const DISCOVERY_INDEX_CONTRACT_VERSION = 1;

const MAX_QUERY_ITEMS = 200;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;

/** Query scope for a discovery-index request: which repos/orgs/search-terms to fan out over, plus pagination. */
export type DiscoveryIndexQuery = {
  /** Canonical `owner/repo` targets. */
  repos: readonly string[];
  /** Bare `owner` (org/user) targets — every open issue across the owner's repos. */
  orgs: readonly string[];
  /** Free-text GitHub issue-search terms. */
  searchTerms: readonly string[];
  /** Page size, clamped to [1, 200]. Default 50. */
  limit: number;
  /** Opaque forward pagination cursor from a previous response's `nextCursor`, or null for the first page. */
  cursor: string | null;
};

export type DiscoveryIndexRequest = {
  contractVersion: number;
  query: DiscoveryIndexQuery;
};

export type DiscoveryIndexAiPolicySource = "AI-USAGE.md" | "CONTRIBUTING.md" | "none";

/** One metadata-only candidate issue. Field-for-field compatible with opportunity-ranker.js `normalizeCandidate`
 *  output, so `rankCandidateIssues` consumes hosted results exactly like a local fan-out. Public-safe by contract:
 *  no scores/rewards/wallet/hotkey/source fields ever appear here (see {@link DISCOVERY_INDEX_FORBIDDEN_FIELDS}). */
export type DiscoveryIndexCandidate = {
  owner: string;
  repo: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  labels: readonly string[];
  /** Repo login(s) the issue is assigned to on GitHub (#7442). OPTIONAL: an older, backward-compatible hosted
   *  server build that doesn't populate it leaves the field absent, which lets a client distinguish "assignees
   *  were never served" from "served, and empty" -- the former falls back to [] at the merge site rather than
   *  silently no-opping contribution-profile-filter's repo-owner exclusion (#7040). Normalized like `labels`. */
  assignees?: readonly string[];
  commentsCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  htmlUrl: string | null;
  aiPolicyAllowed: boolean;
  aiPolicySource: DiscoveryIndexAiPolicySource;
};

export type DiscoveryIndexResponse = {
  contractVersion: number;
  candidates: readonly DiscoveryIndexCandidate[];
  /** Forward cursor for the next page, or null when the result set is exhausted. */
  nextCursor: string | null;
};

export type ParsedDiscoveryIndexRequest = {
  request: DiscoveryIndexRequest;
  warnings: string[];
};

export type ParsedDiscoveryIndexResponse = {
  response: DiscoveryIndexResponse;
  warnings: string[];
};

/** Field-name fragments that must NEVER cross the public discovery boundary (Phase 1 acceptance:
 *  cross-repo-discovery-phase1.md:13-14,54). A candidate carrying any of these is rejected, not silently trimmed,
 *  so a misbehaving server can't smuggle raw economic/identity/source data past the contract. */
export const DISCOVERY_INDEX_FORBIDDEN_FIELDS: readonly string[] = Object.freeze([
  "score",
  "reward",
  "wallet",
  "hotkey",
  "coldkey",
  "mnemonic",
  "payout",
  "ranking",
  "rawtrust",
  "trustscore",
  "sourcecontent",
  "diff",
  "patch",
]);

/** Owner/repo names of forbidden-field violations present on a raw candidate object (own enumerable keys whose
 *  lower-cased name contains a forbidden fragment). Empty array = public-safe. */
export function discoveryIndexBoundaryViolations(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const violations: string[] = [];
  for (const key of Object.keys(raw)) {
    const lower = key.toLowerCase();
    if (DISCOVERY_INDEX_FORBIDDEN_FIELDS.some((fragment) => lower.includes(fragment))) violations.push(key);
  }
  return violations;
}

function normalizeStringList(value: unknown, transform: (entry: string) => string | null): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (result.length >= MAX_QUERY_ITEMS) break;
    const normalized = transform(entry);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** `owner/repo` with exactly one slash and non-empty halves; anything else → null (mirrors normalizeCandidate). */
function normalizeRepoFullName(value: string): string | null {
  const [owner, repo, extra] = value.trim().split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return `${owner}/${repo}`;
}

function normalizeOwner(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("/")) return null;
  return trimmed;
}

function normalizeSearchTerm(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function clampLimit(value: unknown, warnings: string[]): number {
  if (value === undefined || value === null) return DEFAULT_PAGE_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`DiscoveryIndexRequest "limit" must be a number; falling back to ${DEFAULT_PAGE_LIMIT}.`);
    return DEFAULT_PAGE_LIMIT;
  }
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  if (floored > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return floored;
}

function normalizeAiPolicySource(value: unknown): DiscoveryIndexAiPolicySource {
  return value === "AI-USAGE.md" || value === "CONTRIBUTING.md" ? value : "none";
}

/**
 * Tolerantly normalize a raw discovery-index request into a canonical {@link DiscoveryIndexRequest}. Never throws:
 * unknown fields are ignored, malformed scope entries are skipped, and the page limit is clamped, accumulating
 * warnings. A non-object raw yields an empty query.
 */
export function normalizeDiscoveryIndexRequest(raw: unknown): ParsedDiscoveryIndexRequest {
  const warnings: string[] = [];
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!record) {
    warnings.push("DiscoveryIndexRequest must be a mapping; falling back to an empty query.");
  }
  const source = record ?? {};
  const query: DiscoveryIndexQuery = {
    repos: normalizeStringList(source.repos, normalizeRepoFullName),
    orgs: normalizeStringList(source.orgs, normalizeOwner),
    searchTerms: normalizeStringList(source.searchTerms, normalizeSearchTerm),
    limit: clampLimit(source.limit, warnings),
    cursor: typeof source.cursor === "string" && source.cursor.trim() ? source.cursor : null,
  };
  return { request: { contractVersion: DISCOVERY_INDEX_CONTRACT_VERSION, query }, warnings };
}

/**
 * Normalize one raw candidate into a public-safe {@link DiscoveryIndexCandidate}, mirroring opportunity-ranker.js
 * `normalizeCandidate`. Returns null when required fields are missing/invalid OR when the raw object carries any
 * forbidden boundary field (a public-safety rejection, not a silent trim).
 */
export function normalizeDiscoveryIndexCandidate(raw: unknown): DiscoveryIndexCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (discoveryIndexBoundaryViolations(raw).length > 0) return null;
  const candidate = raw as Record<string, unknown>;
  const repoFullName = typeof candidate.repoFullName === "string" ? candidate.repoFullName : "";
  const canonical = normalizeRepoFullName(repoFullName);
  const issueNumber = candidate.issueNumber;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  if (canonical === null) return null;
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0 || !title) return null;
  // `canonical` is guaranteed `owner/repo` with exactly one slash, so slice yields two non-empty strings.
  const slashIndex = canonical.indexOf("/");
  const owner = canonical.slice(0, slashIndex);
  const repo = canonical.slice(slashIndex + 1);
  const labels = Array.isArray(candidate.labels)
    ? candidate.labels.filter((label): label is string => typeof label === "string" && label.trim() !== "").map((label) => label.trim())
    : [];
  // #7442: carry real assignees through when the server provides them (same string normalization as `labels`); an
  // older build omits the field, leaving `assignees` off the result (undefined) so the merge site falls back to []
  // -- fail-safe, never silently skipping the repo-owner exclusion filter.
  const assignees = Array.isArray(candidate.assignees)
    ? candidate.assignees.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim())
    : undefined;
  return {
    owner,
    repo,
    repoFullName: canonical,
    issueNumber,
    title,
    labels,
    ...(assignees !== undefined ? { assignees } : {}),
    commentsCount: typeof candidate.commentsCount === "number" && Number.isFinite(candidate.commentsCount) ? candidate.commentsCount : 0,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : null,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : null,
    htmlUrl: typeof candidate.htmlUrl === "string" ? candidate.htmlUrl : null,
    aiPolicyAllowed: candidate.aiPolicyAllowed !== false,
    aiPolicySource: normalizeAiPolicySource(candidate.aiPolicySource),
  };
}

/**
 * Tolerantly normalize a raw discovery-index response: keep only valid, public-safe candidates (invalid or
 * boundary-violating entries are dropped with a warning), and carry a forward cursor. Never throws.
 */
export function normalizeDiscoveryIndexResponse(raw: unknown): ParsedDiscoveryIndexResponse {
  const warnings: string[] = [];
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!record) {
    warnings.push("DiscoveryIndexResponse must be a mapping; falling back to an empty candidate list.");
  }
  const rawCandidates = record && Array.isArray(record.candidates) ? record.candidates : [];
  // #6774: the request side clamps page size to MAX_PAGE_LIMIT, but this response comes from the OPTIONAL,
  // only-partially-trusted hosted index (see this module's header). A misbehaving or compromised host could
  // otherwise return an arbitrarily large `candidates` array and force unbounded client-side normalization. Cap
  // it, dropping the overflow with a warning; the retained page and `nextCursor` still round-trip so pagination
  // continues from the truncated page.
  const boundedCandidates = rawCandidates.length > MAX_PAGE_LIMIT ? rawCandidates.slice(0, MAX_PAGE_LIMIT) : rawCandidates;
  if (boundedCandidates.length < rawCandidates.length) {
    warnings.push(`DiscoveryIndexResponse returned ${rawCandidates.length} candidates; capping to ${MAX_PAGE_LIMIT} and dropping the rest.`);
  }
  const candidates: DiscoveryIndexCandidate[] = [];
  for (const entry of boundedCandidates) {
    const normalized = normalizeDiscoveryIndexCandidate(entry);
    if (normalized === null) {
      warnings.push("DiscoveryIndexResponse dropped an invalid or boundary-violating candidate.");
      continue;
    }
    candidates.push(normalized);
  }
  const nextCursor = record && typeof record.nextCursor === "string" && record.nextCursor.trim() ? (record.nextCursor as string) : null;
  return { response: { contractVersion: DISCOVERY_INDEX_CONTRACT_VERSION, candidates, nextCursor }, warnings };
}
