// ContributionProfile extraction (#6796). Reads a repo's real, published signals — label taxonomy + contribution
// docs — and produces a populated ContributionProfile per the #6795 schema. GENERIC by design: it recognizes
// conventional OSS eligibility/exclusion vocabulary and matches over label name AND description, with NO
// loopover-specific keyword hardcoding (the #6794 inventory found loopover's own `gittensor:*` labels are the
// exception, not the shape to generalize from). Never throws: any fetch/parse failure degrades a signal to
// `absent`/`unknown` rather than erroring, so an unreachable or docs-less repo yields a low-confidence profile.
import type {
  ContributionLabelMatcher,
  ContributionProfile,
  ContributionPrBodyRequirements,
  ContributionSignalConfidence,
  ContributionSignalProvenance,
  ContributionSignalRule,
} from "./contribution-profile.js";
import {
  CONTRIBUTION_PROFILE_SCHEMA_VERSION,
  emptyContributionProfile,
  weakestConfidence,
} from "./contribution-profile.js";
import { fetchWithRetry, type FetchWithRetryOptions } from "./http-retry.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 10_000;
/** A CONTRIBUTING.md smaller than this is treated as a signpost (a link to an external guide), not the rules
 *  themselves — #6794 found react's is 208 B and laravel' 525 B, both just pointers. */
const CONTRIBUTING_SIGNPOST_MAX_BYTES = 600;

/** Canonical eligibility vocabulary — recognized OSS "contributor-workable" conventions. Matched case-insensitively
 *  as a substring over a label's name AND description. Not loopover-specific. */
const ELIGIBILITY_TERMS = Object.freeze([
  "good first issue",
  "good-first-issue",
  "help wanted",
  "help-wanted",
  "up for grabs",
  "beginner",
  "easy",
  "starter",
]);

/** Conventional exclusion/off-limits vocabulary. These are UNstated conventions (#6794 found no repo names
 *  exclusion in a label NAME explicitly), so a match yields `inferred`, never `explicit`. */
const EXCLUSION_TERMS = Object.freeze([
  "blocked",
  "on hold",
  "on-hold",
  "do not merge",
  "wontfix",
  "invalid",
  "needs triage",
  "work in progress",
  "wip",
  "maintainer only",
  "internal",
]);

/** Closing-keyword / linked-issue language in a CONTRIBUTING.md. */
const LINKED_ISSUE_TERMS = Object.freeze([
  "closes #",
  "fixes #",
  "resolves #",
  "linked issue",
  "reference an issue",
  "link to an issue",
]);

type GithubLabel = { name?: unknown; description?: unknown };

type ExtractContributionProfileOptions = {
  fetchImpl?: typeof fetch;
  githubToken?: string;
  apiBaseUrl?: string;
  /** ISO timestamp for the profile's generatedAt; defaults to now. Injected so tests stay deterministic. */
  generatedAt?: string;
  /** Sleep seam for the transient-5xx/rate-limit retry (via fetchWithRetry). Injected so tests use no real timers. */
  sleepFn?: (ms: number) => Promise<unknown>;
};

function parseRepoFullName(repoFullName: unknown): { owner: string; repo: string } | null {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner?.trim() || !repo?.trim() || extra !== undefined) return null;
  return { owner: owner.trim(), repo: repo.trim() };
}

function githubHeaders(githubToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "loopover-miner",
    "x-github-api-version": GITHUB_API_VERSION,
  };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  return headers;
}

/** Bounded, never-throwing JSON GET. Rides out a transient GitHub 5xx or rate-limit response (429 / secondary-403)
 *  via `fetchWithRetry` — the same discipline opportunity-fanout.js's sibling `githubGetJson` already uses — before
 *  falling back to its fail-open contract: returns null on a non-retryable/exhausted HTTP, transport, or parse
 *  failure. `timeoutMs` gives each attempt its own fresh `AbortSignal.timeout` (preserving the per-request bound),
 *  and `sleepFn` is the injectable no-real-timers seam every other `fetchWithRetry` call site exposes. */
async function getJsonResponse(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  sleepFn: ((ms: number) => Promise<unknown>) | undefined,
): Promise<{ payload: unknown; response: Response } | null> {
  let response: Response;
  try {
    // Cast: the JS always passes `sleepFn` (possibly undefined); EOPT rejects an explicit undefined optional.
    response = await fetchWithRetry(
      fetchImpl as (url: unknown, init?: unknown) => Promise<Response>,
      url,
      { method: "GET", headers },
      { sleepFn, timeoutMs: REQUEST_TIMEOUT_MS } as FetchWithRetryOptions,
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  return { payload, response };
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  sleepFn: ((ms: number) => Promise<unknown>) | undefined,
): Promise<unknown> {
  const result = await getJsonResponse(url, headers, fetchImpl, sleepFn);
  return result?.payload ?? null;
}

/** Same Link-header check as `ci-poller.ts`'s check-run pagination (#8010). */
function hasNextLink(response: Response): boolean {
  const link =
    typeof response.headers?.get === "function" ? response.headers.get("link") : null;
  return /<[^>]+>;\s*rel="next"/.test(link ?? "");
}

/** Cap runaway pagination the way opportunity-fanout caps `maxPages` — 50×100 covers pathological repos
 *  without inventing a different paging scheme than ci-poller's `page=` loop. */
const MAX_LABEL_PAGES = 50;

/** Fetch every label on the repo, following GitHub `Link: rel="next"` the same way `ci-poller.ts` pages
 *  check-runs (#8010). Fail-open: a failed/malformed page returns whatever was collected so far. */
async function fetchRepoLabels(
  base: string,
  target: { owner: string; repo: string },
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  sleepFn: ((ms: number) => Promise<unknown>) | undefined,
): Promise<GithubLabel[]> {
  const labels: GithubLabel[] = [];
  for (let page = 1; page <= MAX_LABEL_PAGES; page += 1) {
    const result = await getJsonResponse(
      `${base}/repos/${target.owner}/${target.repo}/labels?per_page=100&page=${page}`,
      headers,
      fetchImpl,
      sleepFn,
    );
    if (result === null) return labels;
    if (!Array.isArray(result.payload)) return labels;
    const pageLabels = result.payload as GithubLabel[];
    labels.push(...pageLabels);
    if (!hasNextLink(result.response)) return labels;
    if (pageLabels.length === 0) return labels;
  }
  /* v8 ignore next -- defensive page cap; a real repo never has 5000+ labels. */
  return labels;
}

/**
 * Match one label against a term list, preferring the NAME but falling back to the DESCRIPTION (the rust
 * `E-easy` finding: a label can carry its eligibility meaning only in the description). Returns the matcher +
 * a provenance detail, or null when neither field matches.
 */
function matchLabel(
  label: GithubLabel,
  terms: readonly string[],
): { matcher: ContributionLabelMatcher; detail: string } | null {
  const rawName = typeof label?.name === "string" ? label.name : "";
  const name = rawName.toLowerCase();
  const description =
    typeof label?.description === "string"
      ? label.description.toLowerCase()
      : "";
  const detail = rawName || "(unnamed label)";
  const nameTerm = terms.find((term) => name.includes(term));
  if (nameTerm !== undefined)
    return { matcher: { field: "name", contains: nameTerm }, detail };
  const descriptionTerm = terms.find((term) => description.includes(term));
  if (descriptionTerm !== undefined)
    return {
      matcher: { field: "description", contains: descriptionTerm },
      detail,
    };
  return null;
}

/** Classify labels into a SignalRule of the given confidence. Recognized labels build an OR-list of matchers;
 *  no match ⇒ `absent`. Eligibility passes `explicit` (a recognized convention IS an explicit statement);
 *  exclusion passes `inferred` (conventional but unstated). */
function classifyLabels(
  labels: GithubLabel[],
  terms: readonly string[],
  matchedConfidence: ContributionSignalConfidence,
): ContributionSignalRule<ContributionLabelMatcher[]> {
  const matchers: ContributionLabelMatcher[] = [];
  const provenance: ContributionSignalProvenance[] = [];
  for (const label of labels) {
    const hit = matchLabel(label, terms);
    if (hit === null) continue;
    matchers.push(hit.matcher);
    provenance.push({ source: "labels", detail: hit.detail });
  }
  if (matchers.length === 0)
    return { value: null, confidence: "absent", provenance: [] };
  return { value: matchers, confidence: matchedConfidence, provenance };
}

/** Decode a GitHub contents API response body to text. Returns null when absent or not base64. Buffer.from over
 *  a string never throws, so no error path is needed here. */
function decodeContents(payload: unknown): string | null {
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { content?: unknown }).content !== "string" ||
    (payload as { encoding?: unknown }).encoding !== "base64"
  )
    return null;
  return Buffer.from((payload as { content: string }).content, "base64").toString("utf8");
}

/** Fetch CONTRIBUTING.md, probing the repo root then `.github/` (#6794: 6/10 at root, 2/10 under `.github/`). */
async function fetchContributing(
  base: string,
  target: { owner: string; repo: string },
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  sleepFn: ((ms: number) => Promise<unknown>) | undefined,
): Promise<string | null> {
  for (const path of ["CONTRIBUTING.md", ".github/CONTRIBUTING.md"]) {
    const payload = await getJson(
      `${base}/repos/${target.owner}/${target.repo}/contents/${path}`,
      headers,
      fetchImpl,
      sleepFn,
    );
    const text = decodeContents(payload);
    if (text !== null) return text;
  }
  return null;
}

/** #8316: mirror of `fetchContributing` for AI-agent-facing contributor docs. Probes `AGENTS.md` then `CLAUDE.md`
 *  at the repo ROOT only (unlike CONTRIBUTING.md, neither follows the `.github/` convention in real repos),
 *  reusing the same `getJson`/`decodeContents` helpers, returning the first hit or `null`. #6794's own signal
 *  inventory found some repos state their contribution rules only in an agent doc — the `agent_docs` source the
 *  schema (`contribution-profile.ts`) already defines but nothing populated until now. */
async function fetchAgentDocs(
  base: string,
  target: { owner: string; repo: string },
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  sleepFn: ((ms: number) => Promise<unknown>) | undefined,
): Promise<string | null> {
  for (const path of ["AGENTS.md", "CLAUDE.md"]) {
    const payload = await getJson(
      `${base}/repos/${target.owner}/${target.repo}/contents/${path}`,
      headers,
      fetchImpl,
      sleepFn,
    );
    const text = decodeContents(payload);
    if (text !== null) return text;
  }
  return null;
}

/** #8316: an agent-doc-derived prBody rule flowed through the same `extractPrBody` logic CONTRIBUTING.md uses,
 *  which hardcodes the `contributing_md` provenance source — re-tag it to the schema's `agent_docs` source so a
 *  repo that states its PR-body rule only in AGENTS.md/CLAUDE.md is attributed correctly. An `absent`/`unknown`
 *  result carries empty provenance, so it maps to itself unchanged. */
function tagAgentDocsSource(
  rule: ContributionSignalRule<ContributionPrBodyRequirements>,
): ContributionSignalRule<ContributionPrBodyRequirements> {
  if (rule.provenance.length === 0) return rule;
  return {
    ...rule,
    provenance: rule.provenance.map((entry) => ({ ...entry, source: "agent_docs" })),
  };
}

/** Extract the PR-body linked-issue requirement from CONTRIBUTING.md. A very small file is a signpost, not the
 *  rules, so it yields `absent` rather than a false negative dressed as a real one. */
function extractPrBody(
  contributing: string | null,
): ContributionSignalRule<ContributionPrBodyRequirements> {
  if (contributing === null)
    return { value: null, confidence: "absent", provenance: [] };
  if (contributing.length < CONTRIBUTING_SIGNPOST_MAX_BYTES)
    return { value: null, confidence: "unknown", provenance: [] };
  const lower = contributing.toLowerCase();
  const requiresLinkedIssue = LINKED_ISSUE_TERMS.some((term) =>
    lower.includes(term),
  );
  // A real, sufficiently-sized CONTRIBUTING.md is an explicit source either way: present-with-keyword is an
  // explicit requirement, present-without is an explicit "no such rule".
  return {
    value: { requiresLinkedIssue },
    confidence: "explicit",
    provenance: [{ source: "contributing_md", detail: "CONTRIBUTING.md" }],
  };
}

/**
 * Extract a best-effort ContributionProfile for a repo from what it actually publishes.
 */
export async function extractContributionProfile(
  repoFullName: string,
  options: ExtractContributionProfileOptions = {},
): Promise<ContributionProfile> {
  const generatedAt =
    typeof options.generatedAt === "string"
      ? options.generatedAt
      : new Date().toISOString();
  const target = parseRepoFullName(repoFullName);
  // A malformed name can't be fetched — return the safe, fully-absent default rather than throwing.
  if (target === null)
    return emptyContributionProfile(
      typeof repoFullName === "string" ? repoFullName : "",
      generatedAt,
    );

  /* v8 ignore next -- the global-fetch default is the production path; every test injects fetchImpl. */
  const fetchImpl = options.fetchImpl ?? fetch;
  const base =
    typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
      ? options.apiBaseUrl.replace(/\/+$/, "")
      : DEFAULT_API_BASE_URL;
  const headers = githubHeaders(
    options.githubToken ?? process.env.GITHUB_TOKEN,
  );

  const sleepFn = options.sleepFn;
  const labels = await fetchRepoLabels(base, target, headers, fetchImpl, sleepFn);
  const contributing = await fetchContributing(
    base,
    target,
    headers,
    fetchImpl,
    sleepFn,
  );

  const eligibilityLabels = classifyLabels(
    labels,
    ELIGIBILITY_TERMS,
    "explicit",
  );
  const exclusionLabels = classifyLabels(labels, EXCLUSION_TERMS, "inferred");
  // #8316: CONTRIBUTING.md stays authoritative. Only when it yields no rule at all (`absent`, i.e. no
  // CONTRIBUTING.md exists) do we fall back to an AI-agent doc (AGENTS.md/CLAUDE.md) through the SAME
  // extractPrBody logic, tagging its provenance `agent_docs`. A signpost-sized CONTRIBUTING.md (`unknown`) is
  // deliberately NOT overridden — zero regression for any repo that already has a real CONTRIBUTING.md.
  let prBody = extractPrBody(contributing);
  if (prBody.confidence === "absent") {
    const agentDocs = await fetchAgentDocs(base, target, headers, fetchImpl, sleepFn);
    prBody = tagAgentDocsSource(extractPrBody(agentDocs));
  }

  return {
    repoFullName: `${target.owner}/${target.repo}`,
    schemaVersion: CONTRIBUTION_PROFILE_SCHEMA_VERSION,
    generatedAt,
    eligibilityLabels,
    exclusionLabels,
    prBody,
    completeness: weakestConfidence([
      eligibilityLabels.confidence,
      exclusionLabels.confidence,
      prBody.confidence,
    ]),
  };
}
