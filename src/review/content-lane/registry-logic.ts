// Metagraphed registry decision logic (content-lane primitive).
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence). Byte-faithful to reviewbot's
// src/agents/metagraphed/review-logic.ts (itself a faithful port of the live metagraphed
// submission-gate). PURE + testable; all I/O (GitHub, registry/taostats API, AI) lives in the
// caller. The SSRF guard is the shared content-lane safe-url; `Verdict` + `isInternalAutomation
// Branch` are inlined so the module has no engine imports.
//
// This is metagraphed's domain-specific core: candidate/provider shape+safety gates, the netuid
// GROUNDING signals (the deterministic "is the declared netuid independently corroborated" matcher
// used with the taostats/registry identity in the live merge gate), registry dedup keys, freshness,
// functional-surface probing, and PR scope classification.
import { isSafeEndpointUrl, isSafeHttpUrl } from "./safe-url";

/** The gate's final verdict vocabulary (reviewbot core/types.ts). */
export type Verdict = "merge" | "close" | "manual" | "comment" | "ignore";

// Noise-bot branch prefixes (renovate/dependabot/github-actions/reviewbot) — inlined from reviewbot
// core/github.ts isAutomationBranch. codex/ is deliberately NOT here (it is real, human-initiated work).
const AUTOMATION_BRANCH_PREFIXES = ["renovate/", "dependabot/", "github-actions/", "reviewbot/"];
/** True if a head ref looks like a noise-bot branch. */
export function isInternalAutomationBranch(ref: string | undefined): boolean {
  const branch = String(ref ?? "")
    .trim()
    .toLowerCase();
  return AUTOMATION_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix));
}

/** Generated registry artifacts a valid PR must regenerate — allowed companions of a registry submission. */
export const ARTIFACT_PATTERN = /^public\/metagraph\/[a-z0-9/_-]+\.json$/i;
export const DEFAULT_PUBLIC_API_BASE = "https://api.metagraph.sh/api/v1";

export const ISSUE_SUBMISSION_LABELS = new Set([
  "interface-submission",
  "endpoint-submission",
  "provider-submission",
  "status-report",
]);

const REVIEWER_CLOSE_REASONS = new Set([
  "malformed-json",
  "unsafe-url",
  "unsupported-shape",
  "secret-or-credential",
  "observed-state-claim",
]);
// Observed-state fields a submission must NEVER assert — health/uptime/latency/status are PROBE-derived
// only. A candidate carrying any of these is asserting runtime state it can't vouch for → close.
const OBSERVED_STATE_KEYS = new Set([
  "health",
  "healthy",
  "uptime",
  "downtime",
  "latency",
  "response_time",
  "incident",
  "status",
  "availability",
  "sla",
  "is_up",
  "online",
  "degraded",
  "last_checked",
]);
/** Base-layer chain endpoints (wss/ws JSON-RPC). One-shot: probed + dual-AI-verified like any other candidate. */
export const REVIEWER_BASE_LAYER_KINDS = new Set(["archive", "subtensor-rpc", "subtensor-wss"]);
export function isBaseLayerKind(kind: unknown): boolean {
  return REVIEWER_BASE_LAYER_KINDS.has(String(kind));
}
const REVIEWER_SAFE_KINDS = new Set([
  "website",
  "source-repo",
  "subnet-api",
  "openapi",
  "sse",
  "sdk",
  "example",
  "dashboard",
  "repo-registry",
  "docs",
  "data-artifact",
]);
export const AI_REVIEW_VERDICTS = new Set(["merged", "closed", "manual-review"]);

/** Live verdict vocabulary → core verdict. */
export type MetaVerdict = "merged" | "closed" | "manual-review";
export function toCoreVerdict(v: MetaVerdict): Verdict {
  return v === "merged" ? "merge" : v === "closed" ? "close" : "manual";
}

export type CandidateLike = Record<string, unknown> & {
  netuid?: unknown;
  kind?: unknown;
  url?: unknown;
  source_url?: unknown;
  source_urls?: unknown;
  public_safe?: unknown;
  auth_required?: unknown;
};

export interface Assessment {
  verdict: MetaVerdict;
  summary?: string;
  candidate: CandidateLike | null;
  reason?: string;
}

/** Exact port of containsSecretLikeText — runs on JSON.stringify(candidate). */
export function containsSecretLikeText(value: string): boolean {
  return /\bgh[pousr]_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|BEGIN [A-Z ]*PRIVATE KEY|seed phrase|mnemonic|wallet path|hotkey|coldkey/i.test(
    String(value || ""),
  );
}

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "ref_src",
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "igshid",
]);

/** Canonicalize a public URL for dedup keying. Strips hash/trailing slash, `www.`, default ports,
 *  `index.html`, and tracking params, and sorts the query — so trivial variants key the SAME. */
export function normalizePublicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./i, "");
    const defaultPort = url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
    /* v8 ignore next -- the WHATWG URL constructor already drops default ports for special schemes (http/https/ws/wss), so url.port is "" here and this guard never fires; kept as defense-in-depth. */
    if (url.port === defaultPort) url.port = "";
    url.pathname = url.pathname.replace(/\/index\.html?$/i, "/");
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    const sorted = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    for (const [k, v] of sorted) url.searchParams.append(k, v);
    return url.toString().toLowerCase();
  } catch {
    return null;
  }
}

export interface GroundingSignals {
  /** The declared netuid appears next to a netuid/subnet/sn keyword in the fetched evidence. */
  netuidMentioned: boolean;
  /** The claimed owner (github owner of the source/url, if any) appears in the fetched evidence. */
  ownerMentioned: boolean;
  /** The target and source resolve to the same registrable host, or the source body references the
   *  target host — i.e. the source genuinely backs the target. */
  hostMatchesClaim: boolean;
  /** A fetch was redirected cross-origin (bait-and-switch signal). */
  crossOriginRedirect: boolean;
  /** Count of positive grounding signals (netuid/owner/host), net of a cross-origin penalty. */
  strong: number;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The deterministic "is the declared netuid independently named" matcher. A netuid/subnet/sn keyword
 *  followed by up to 3 separator chars then the EXACT number, digit-bounded so "subnet 70" does not
 *  satisfy netuid 7. The separator class includes space/#/:/=/-/_/| so real-world forms all match. */
export function netuidGroundingRegex(netuid: string | number): RegExp {
  return new RegExp(`\\b(?:netuid|subnet|sn)[\\s#:=_\\-|]{0,3}${escapeRe(String(netuid))}(?!\\d)`, "i");
}

function normHost(value: unknown): string | null {
  try {
    return new URL(String(value)).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

// Multi-tenant hosting suffixes where each subdomain is a DIFFERENT party — treat as effective public
// suffixes and keep the tenant label so two unrelated tenants don't falsely satisfy hostMatchesClaim.
const MULTI_TENANT_SUFFIXES = [
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "onrender.com",
  "herokuapp.com",
  "web.app",
  "firebaseapp.com",
  "readthedocs.io",
  "gitbook.io",
];

/** Heuristic registrable domain (eTLD+1 ≈ last two labels, with known multi-tenant suffixes kept one
 *  label deeper). */
export function registrableDomain(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  let host = value;
  try {
    host = new URL(value).hostname; // a full URL → its host; a bare host string → keep as-is
  } catch {
    /* treat value as a bare hostname */
  }
  host = host.replace(/^www\./i, "").toLowerCase();
  if (!host) return null;
  if (!host.includes(".")) return host;
  const suffix = MULTI_TENANT_SUFFIXES.find((s) => host === s || host.endsWith(`.${s}`));
  if (suffix) {
    if (host === suffix) return host;
    const tenant = host
      .slice(0, host.length - suffix.length - 1)
      .split(".")
      .pop();
    return tenant ? `${tenant}.${suffix}` : suffix;
  }
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

/** Owner/repo tokens from known code/model hosts (github/gitlab/bitbucket/huggingface). Only ≥4-char tokens. */
function ownerTokens(value: unknown): string[] {
  try {
    const u = new URL(String(value));
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    const seg = u.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    const out: string[] = [];
    if (host === "github.com" || host === "gitlab.com" || host === "bitbucket.org") {
      if (seg[0]) out.push(seg[0]);
      if (seg[1]) out.push(seg[1].replace(/\.git$/i, ""));
    } else if (host === "huggingface.co") {
      const rest = ["datasets", "models", "spaces"].includes(seg[0] ?? "") ? seg.slice(1) : seg;
      if (rest[0]) out.push(rest[0]);
      if (rest[1]) out.push(rest[1]);
    }
    return out.filter((t) => t.length >= 4);
  } catch {
    return [];
  }
}

type EvidenceLike = { title?: unknown; snippet?: unknown; cross_origin_redirect?: unknown } | null | undefined;

const evidenceText = (e: EvidenceLike): string =>
  [e?.title, e?.snippet]
    .map((v) => (typeof v === "string" ? v : ""))
    .join("\n")
    .toLowerCase();

/** Deterministic grounding of a candidate against its fetched evidence — does the evidence actually
 *  corroborate the declared netuid / owner / host, and was there a cross-DOMAIN redirect? Pure +
 *  testable; the caller supplies the fetched evidence and uses `strong` to gate a merge. Host
 *  corroboration must be INDEPENDENT (same registrable domain as the separate source, or referenced by
 *  the SOURCE body); owner grounding spans github/gitlab/bitbucket/huggingface; netuid match is
 *  digit-bounded so "subnet 70" does not satisfy netuid 7. */
export function computeGrounding(
  candidate: CandidateLike | null | undefined,
  target: EvidenceLike,
  source: EvidenceLike,
): GroundingSignals {
  const targetText = evidenceText(target);
  const sourceText = evidenceText(source);
  const allText = `${targetText}\n${sourceText}`;

  const netuid = String(candidate?.netuid ?? "").trim();
  const netuidMentioned = !!netuid && netuidGroundingRegex(netuid).test(allText);

  const sourceUrl =
    (candidate?.source_url as string) || (candidate?.source_urls as string[] | undefined)?.[0] || "";
  // A source that is the SAME resource as the url cannot independently corroborate the claim — owner +
  // host grounding only count when the source is an INDEPENDENT resource (protocol-insensitive sameness).
  const stripScheme = (value: unknown): string | null => {
    const normalized = normalizePublicUrl(value);
    return normalized == null ? null : normalized.replace(/^[a-z]+:/i, "");
  };
  const targetKey = stripScheme(candidate?.url);
  const sourceKey = stripScheme(sourceUrl);
  const independentSource = !!sourceUrl && (targetKey == null || sourceKey == null || targetKey !== sourceKey);
  const tokens = [...new Set([...ownerTokens(sourceUrl), ...ownerTokens(candidate?.url)])];
  const ownerMentioned = independentSource && tokens.some((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "i").test(allText));

  const targetHost = normHost(candidate?.url);
  const sourceHost = normHost(sourceUrl);
  const targetApex = registrableDomain(targetHost);
  const hostMatchesClaim =
    independentSource &&
    ((targetApex != null && targetApex === registrableDomain(sourceHost)) ||
      (!!targetHost && sourceText.includes(targetHost)));

  const crossOriginRedirect = target?.cross_origin_redirect === true || source?.cross_origin_redirect === true;

  const positives = [netuidMentioned, ownerMentioned, hostMatchesClaim].filter(Boolean).length;
  const strong = Math.max(0, positives - (crossOriginRedirect ? 1 : 0));
  return { netuidMentioned, ownerMentioned, hostMatchesClaim, crossOriginRedirect, strong };
}

// ── Registry identity tokens (ACCURACY corroboration, NOT ownership gating) ───────────────────
// metagraphed is a PUBLIC registry — anyone may submit/update a surface. These tokens let a reviewer
// confirm a surface RELATES to the declared subnet (accuracy); they are NOT an owner/submitter check.

const normIdent = (value: unknown): string =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Aggregators / social / code hosts whose domain label is NOT a subnet's own identity. */
const NON_IDENTITY_DOMAIN_LABELS = new Set([
  "taomarketcap",
  "taostats",
  "subnetradar",
  "backprop",
  "taopedia",
  "wandb",
  "weightsandbiases",
  "huggingface",
  "github",
  "gitlab",
  "bitbucket",
  "discord",
  "twitter",
  "medium",
  "notion",
  "gitbook",
  "readthedocs",
  "youtube",
  "linktr",
  "linktree",
  "telegram",
  "substack",
  "vercel",
  "netlify",
]);

/** Registrable-domain "main label" of a URL/host (byzantiumai.net → byzantiumai), normalized. */
function domainLabel(value: unknown): string | null {
  const apex = registrableDomain(value);
  if (!apex) return null;
  const label = apex.split(".")[0];
  return label ? normIdent(label) : null;
}

const usableIdentityToken = (token: string): boolean => token.length >= 4 && !NON_IDENTITY_DOMAIN_LABELS.has(token);

/** Identity tokens for a subnet derived from its AUTHORITATIVE public-registry record — its NAME and
 *  the registrable labels + repo orgs of its OFFICIAL website/docs/source-repo/links. Excludes
 *  slug/native_slug (forgeable) and dashboard_url (third-party aggregators), and drops known
 *  aggregator/social labels. */
export function deriveRegistryIdentityTokens(record: Record<string, unknown> | null | undefined): string[] {
  if (!record || typeof record !== "object") return [];
  const out = new Set<string>();
  for (const key of ["name", "native_name"]) {
    const t = normIdent((record as Record<string, unknown>)[key]);
    if (usableIdentityToken(t)) out.add(t);
  }
  for (const key of ["website_url", "docs_url", "source_repo", "homepage"]) {
    const url = (record as Record<string, unknown>)[key];
    const label = domainLabel(url);
    if (label && usableIdentityToken(label)) out.add(label);
    for (const tok of ownerTokens(url)) {
      const t = normIdent(tok);
      if (usableIdentityToken(t)) out.add(t);
    }
  }
  const links = (record as { links?: unknown }).links;
  if (Array.isArray(links)) {
    for (const l of links) {
      const url = typeof l === "string" ? l : (l as { url?: unknown })?.url;
      const label = domainLabel(url);
      if (label && usableIdentityToken(label)) out.add(label);
    }
  }
  return [...out];
}

/** Does the candidate's OWN surface URL correspond to the subnet's registered identity tokens? Confirms
 *  the surface PLAUSIBLY BELONGS TO this subnet. Matches on the candidate's url alone (not a borrowable
 *  source_url). Returns false when there are no identity tokens to match. */
export function surfaceMatchesRegistryIdentity(candidateUrl: unknown, identityTokens: string[]): boolean {
  if (!identityTokens.length) return false;
  const want = new Set(identityTokens);
  const label = domainLabel(candidateUrl);
  if (label && usableIdentityToken(label) && want.has(label)) return true;
  for (const tok of ownerTokens(candidateUrl)) {
    const t = normIdent(tok);
    if (usableIdentityToken(t) && want.has(t)) return true;
  }
  return false;
}

/** True when an HTTP body is a NON-EMPTY structured-data response (valid JSON object/array/scalar, or a
 *  non-blank xml/yaml/csv/event-stream body). Such a body is SUBSTANTIVE even when short — must NOT be
 *  treated as a "degraded" near-empty fetch (the length-based heuristic is meaningful only for HTML/text). */
export function isNonEmptyStructuredBody(contentType: unknown, body: unknown): boolean {
  const ct = typeof contentType === "string" ? contentType : "";
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) return false;
  if (/application\/(?:json|[\w.+-]*\+json)/i.test(ct)) {
    try {
      const v = JSON.parse(text);
      if (v == null) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "object") return Object.keys(v).length > 0;
      return true; // a JSON scalar (number/string/bool) is still a real served value
    } catch {
      return false;
    }
  }
  return /application\/(?:xml|x-yaml|yaml)|text\/(?:xml|x-yaml|yaml|csv|event-stream)/i.test(ct);
}

// ── Repository freshness (hardening) ──────────────────────────────────────────────────────────
/** A source repo untouched for longer than this (days), or archived, is not "live truth" → manual. */
export const STALE_REPO_DAYS = 365;
export interface FreshnessSignals {
  known: boolean;
  archived: boolean;
  pushedAt: string | null;
  ageDays: number | null;
  stale: boolean;
  reason: string | null;
}
/** Assess a github repo's freshness from its metadata. Pure (now injected for testability). A null
 *  meta (couldn't read) → known:false, stale:false — an unreadable signal must not block on its own. */
export function assessFreshness(
  meta: { archived?: boolean; pushedAt?: string | null } | null | undefined,
  nowMs: number,
): FreshnessSignals {
  if (!meta) return { known: false, archived: false, pushedAt: null, ageDays: null, stale: false, reason: null };
  const archived = meta.archived === true;
  const pushedAt = meta.pushedAt ?? null;
  const pushedMs = pushedAt ? Date.parse(pushedAt) : NaN;
  const ageDays = Number.isFinite(pushedMs) ? Math.floor((nowMs - pushedMs) / 86_400_000) : null;
  const tooOld = ageDays != null && ageDays > STALE_REPO_DAYS;
  const stale = archived || tooOld;
  const reason = archived ? "archived" : tooOld ? `no commits in ${ageDays} days` : null;
  return { known: true, archived, pushedAt, ageDays, stale, reason };
}

function fail(reason: string, summary: string, candidate: CandidateLike | null = null): Assessment {
  return {
    /* v8 ignore next -- every fail() call site passes a REVIEWER_CLOSE_REASONS member, so the "manual-review" alternative is unreachable; kept so a future non-close reason degrades to manual rather than closing. */
    verdict: REVIEWER_CLOSE_REASONS.has(reason) ? "closed" : "manual-review",
    summary,
    candidate,
    reason,
  };
}

/**
 * Surface validators: a contribution appends ONE entry to `surfaces[]` of a `registry/subnets/<slug>.json`, whose
 * `netuid` lives at the file ROOT (not on each entry). These two deterministic validators (per-entry +
 * whole-document) make gittensory the sole adjudicator; no AI (surfaces are structured data). They take the
 * appended entry / parsed document as arguments; the orchestrator resolves "exactly one appended entry" from a
 * head-vs-base diff.
 */
export function assessSurfaceEntry(
  entry: unknown,
  netuid: number,
  opts: { secretsScan?: boolean; sourceUrlValidation?: boolean } = {},
): Assessment {
  const { secretsScan = true, sourceUrlValidation = true } = opts;
  if (!entry || typeof entry !== "object") {
    return fail("unsupported-shape", "Surface entry must be a JSON object.");
  }
  const surface = entry as CandidateLike;
  if (secretsScan && containsSecretLikeText(JSON.stringify(surface))) {
    return fail("secret-or-credential", "Surface entry appears to include secret, wallet, PAT, or private-key material.", surface);
  }
  const observedKey = Object.keys(surface as Record<string, unknown>).find((k) => OBSERVED_STATE_KEYS.has(k.toLowerCase()));
  if (observedKey) {
    return fail(
      "observed-state-claim",
      `Surface entry asserts observed runtime state (\`${observedKey}\`). Health / uptime / latency / status are probe-derived only and can never be part of a submission — remove the field and resubmit.`,
      surface,
    );
  }
  // netuid is carried by the subnet-document root in the surface model; an entry may omit it, but if it carries one
  // it must not contradict the root (the document validator already proved the root netuid is an integer).
  if (surface.netuid !== undefined && surface.netuid !== null && Number(surface.netuid) !== netuid) {
    return fail("unsupported-shape", "Surface entry netuid must match the subnet document root.", surface);
  }
  const baseLayer = isBaseLayerKind(surface.kind);
  if (!REVIEWER_SAFE_KINDS.has(String(surface.kind)) && !baseLayer) {
    return fail("unsupported-shape", "Surface entry kind is not supported by the reviewer.", surface);
  }
  if (sourceUrlValidation) {
    const urlSafe = baseLayer ? isSafeEndpointUrl(String(surface.url ?? "")) : isSafeHttpUrl(String(surface.url ?? ""));
    if (!urlSafe) {
      return fail(
        "unsafe-url",
        baseLayer ? "Surface entry URL must be a public HTTPS or WSS endpoint." : "Surface entry URL must be a public HTTPS URL.",
        surface,
      );
    }
    const sourceUrl = (surface.source_url as string) || (surface.source_urls as string[] | undefined)?.[0];
    if (!isSafeHttpUrl(String(sourceUrl ?? ""))) {
      return fail("unsafe-url", "Surface entry source URL must be a public HTTPS URL.", surface);
    }
  }
  if (surface.public_safe !== true) {
    return {
      verdict: "closed",
      summary: "Surface entry is not marked public_safe=true — declined. Resubmit with public_safe=true if the endpoint is genuinely public.",
      candidate: surface,
    };
  }
  if (surface.auth_required === true) {
    return {
      verdict: "manual-review",
      summary:
        "Authenticated interface — routing to review to confirm the declared auth scheme is documented publicly (verifiable without any secret) before it can be accepted.",
      candidate: surface,
    };
  }
  return { verdict: "merged", candidate: surface };
}

export function assessSubnetDocument(
  document: unknown,
  opts: { secretsScan?: boolean; sourceUrlValidation?: boolean; appendedEntry: unknown },
): Assessment {
  const { secretsScan = true, sourceUrlValidation = true, appendedEntry } = opts;
  if (!document || typeof document !== "object") {
    return fail("malformed-json", "Subnet document must be a JSON object.");
  }
  const doc = document as { netuid?: unknown; surfaces?: unknown };
  if (!Number.isInteger(Number(doc.netuid))) {
    return fail("unsupported-shape", "Subnet document netuid must be an integer.");
  }
  const netuid = Number(doc.netuid); // normalize once; thread the canonical integer to entry + (future) grounding
  if (!Array.isArray(doc.surfaces)) {
    return fail("unsupported-shape", "Subnet document must carry a surfaces[] array.");
  }
  // A per-entry call: the orchestrator resolves every appended entry by diffing head vs base surfaces[], enforces
  // the spec's maxAppendedEntries cap (and the ≥1-entry requirement) BEFORE calling this per entry, then calls it
  // once per appended entry. So appendedEntry is null/undefined here only when a specific array element itself is
  // missing/malformed (a data-shape problem) — it is no longer a "wrong count" sentinel.
  if (appendedEntry === null || appendedEntry === undefined) {
    return fail("unsupported-shape", "Surface entry to assess is missing — the appended entry could not be resolved.");
  }
  // Whole-document secret scan catches material in the envelope (outside the entry); the entry is re-scanned below.
  if (secretsScan && containsSecretLikeText(JSON.stringify(doc))) {
    return fail("secret-or-credential", "Subnet document appears to include secret, wallet, PAT, or private-key material.");
  }
  return assessSurfaceEntry(appendedEntry, netuid, { secretsScan, sourceUrlValidation });
}

export type ProviderLike = Record<string, unknown> & {
  id?: unknown;
  name?: unknown;
  website_url?: unknown;
  kind?: unknown;
  authority?: unknown;
  notes?: unknown;
};

export interface ProviderAssessment {
  ok: boolean;
  provider: ProviderLike | null;
  reason?: string;
  summary?: string;
}

/** Deterministic provider-profile shape/safety gate (one-shot: malformed → close, else → AI fact-check). */
export function assessProviderDocument(
  document: unknown,
  opts: { secretsScan?: boolean; sourceUrlValidation?: boolean } = {},
): ProviderAssessment {
  const { secretsScan = true, sourceUrlValidation = true } = opts;
  const doc = document as { provider?: unknown } | null;
  if (!doc || typeof doc !== "object") {
    return { ok: false, provider: null, reason: "malformed-json", summary: "Provider profile JSON could not be read." };
  }
  // Scan the WHOLE file (envelope + submission block) for secrets.
  if (secretsScan && containsSecretLikeText(JSON.stringify(doc))) {
    return {
      ok: false,
      provider: null,
      reason: "secret-or-credential",
      summary: "Provider profile appears to include secret, wallet, PAT, or private-key material.",
    };
  }
  // The canonical submission wraps the fields under a `provider` key; a flat top-level object is accepted too.
  const p = (doc.provider && typeof doc.provider === "object" ? doc.provider : doc) as ProviderLike;
  const id = typeof p.id === "string" ? p.id.trim() : "";
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!id || !name) {
    return { ok: false, provider: p, reason: "unsupported-shape", summary: "Provider profile must include a non-empty id and name." };
  }
  if (sourceUrlValidation && !isSafeHttpUrl(String(p.website_url ?? ""))) {
    return { ok: false, provider: p, reason: "unsafe-url", summary: "Provider website_url must be a public HTTPS URL." };
  }
  return { ok: true, provider: p };
}

// ── Kind-aware functional probing ──────────────────────────────────────────────────────────────
// Kinds whose URL must actually SERVE the declared surface (a spec / JSON API / event stream).
const FUNCTIONAL_KINDS = new Set(["openapi", "subnet-api", "sse"]);
export function functionalRequired(kind: unknown): boolean {
  return FUNCTIONAL_KINDS.has(String(kind));
}

/** Bittensor/subtensor-family chain names accepted for base-layer endpoints. */
const ALLOWED_CHAIN_SUBSTRINGS = ["bittensor", "subtensor", "finney", "nakamoto"];
export function isAllowedChain(chain: unknown): boolean {
  const c = String(chain ?? "").toLowerCase();
  return !!c && ALLOWED_CHAIN_SUBSTRINGS.some((n) => c.includes(n));
}

/**
 * Best-effort, truncation-tolerant check that a fetched body actually serves the surface its `kind`
 * claims. openapi → an openapi/swagger schema with paths; subnet-api → a JSON API surface; sse →
 * a `text/event-stream` content type. Returns `served:true` (n/a) for kinds that don't require a
 * functional surface.
 */
export function probeFunctionalSurface(
  kind: unknown,
  contentType: string | null | undefined,
  body: string,
): { served: boolean; detail: string } {
  const k = String(kind);
  const ct = contentType ?? "";
  if (k === "openapi") {
    const looksSpec = /"(?:openapi|swagger)"\s*:/i.test(body) || /^\s*(?:openapi|swagger)\s*:/im.test(body);
    const hasPaths = /"paths"\s*:/i.test(body) || /^\s*paths\s*:/im.test(body);
    return looksSpec
      ? { served: true, detail: hasPaths ? "openapi schema served" : "openapi version key served (paths beyond window)" }
      : { served: false, detail: "no openapi/swagger version key served" };
  }
  if (k === "subnet-api") {
    const isJson = /\bjson\b/i.test(ct) || /^\s*[{[]/.test(body);
    return isJson ? { served: true, detail: "json api surface" } : { served: false, detail: `not a json api surface (content-type:${ct || "none"})` };
  }
  if (k === "sse") {
    const served = /text\/event-stream/i.test(ct);
    return { served, detail: served ? "text/event-stream" : `not an event stream (content-type:${ct || "none"})` };
  }
  return { served: true, detail: "n/a" };
}

// ── Surface model (generic registry content-lane) ─────────────────────────────────────────────────
//
// A community contribution appends entries to an array field of ONE registry "entry file" (e.g.
// registry/subnets/<slug>.json::surfaces[]), optionally with one flat companion provider file. To stay MODULAR —
// many maintainers will install gittensory over wildly different registries — the engine is parameterized by a
// RegistryLaneSpec rather than hard-coding metagraphed's paths; metagraphed is just the FIRST spec, and a spec can
// later be loaded from per-repo .gittensory.yml config so a new registry needs config, not a code change.

/** Describes where a registry keeps its community-editable entry files + allowed companions. */
export interface RegistryLaneSpec {
  /** The file a contribution edits to add entries, e.g. /^registry\/subnets\/<slug>\.json$/. */
  entryFilePattern: RegExp;
  /** Optional flat companion debut-provider file, e.g. /^registry\/providers\/<slug>\.json$/ (flat only). */
  providerFilePattern?: RegExp;
  /** Optional generated artifacts a valid PR must regenerate — allowed companions. */
  artifactPattern?: RegExp;
  /** The array field on an entry file a contribution appends to (the surface model: "surfaces"). */
  collectionField: string;
  /** Max surfaces[] entries a single PR may append in one run. Omitted ⇒ today's strict single-entry-only
   *  default — safe-by-default backward compat for every spec that doesn't explicitly opt in (including future,
   *  unknown per-repo registries). Set explicitly to raise the cap; `Infinity` removes it entirely (e.g.
   *  metagraphed's documented "several surfaces for one subnet in one diff is one merge" anti-farming policy). */
  maxAppendedEntries?: number;
  /** Entry field names whose COMBINED values identify "the same entry" for duplicate detection (e.g. `["url"]`).
   *  Omitted ⇒ duplicate detection is OFF (safe-by-default backward compat — a spec that doesn't opt in gets no
   *  new close reason). When set, an appended entry whose identity matches an entry already present in the base
   *  document's `collectionField` array, OR an earlier entry appended in the SAME PR, closes the whole PR. A field
   *  whose value looks like a URL is compared via `normalizePublicUrl` (so trivial formatting differences don't
   *  count as different); every other field is compared as a trimmed, case-insensitive string (or a structural
   *  JSON comparison for a non-string value). Generic — the engine only duck-types the configured field names off
   *  each entry, it never assumes any domain-specific shape (kind/netuid/etc. are metagraphed's own vocabulary). */
  duplicateKeyFields?: readonly string[];
  /** Validates ONE appended surfaces[] entry against the whole document (root shape + the specific entry) and
   *  returns its Assessment — the registry's own domain-specific semantic check (shape/safety/business rules).
   *  The orchestrator calls this once per appended entry and aggregates the results; it never validates anything
   *  itself, so a different registry supplies its own function here without touching the orchestrator. Omitted
   *  ⇒ the orchestrator returns "manual" for entry submissions to this registry (structural gating — scope,
   *  entry-count cap, duplicate detection — still applies; there's just no domain-specific check configured yet). */
  assessAppendedEntry?: (document: unknown, opts: { secretsScan?: boolean; sourceUrlValidation?: boolean; appendedEntry: unknown }) => Assessment;
  /** Validates a flat provider-submission document and returns its ProviderAssessment — the registry's own
   *  domain-specific check, analogous to `assessAppendedEntry` but for the provider-file scope. Omitted ⇒ the
   *  orchestrator returns "manual" for provider submissions to this registry. */
  assessProviderEntry?: (document: unknown, opts?: { secretsScan?: boolean; sourceUrlValidation?: boolean }) => ProviderAssessment;
}

export type RegistryPrScope = "entry-submission" | "provider-submission" | "mixed-files" | "not-direct-submission";

export interface RegistryScopeResult {
  scope: RegistryPrScope;
  directFile: string | null;
  isProvider: boolean;
  /** For an "entry-submission" scope only: a companion file that is a genuine DEBUT provider submission riding
   *  along with the entry in the same PR (spec.providerFilePattern), set only when exactly one such companion is
   *  present. An entry file always wins the scope classification over a provider file present in the same PR (so
   *  "provider-submission scope with a companion entry file" cannot occur — the entry file becomes directFile and
   *  the provider file becomes this field instead). Null when there is no provider companion, when there is more
   *  than one (ambiguous — ordinary companion-file review still applies), or when the scope isn't entry-submission. */
  providerCompanionFile: string | null;
}

/**
 * Generic surface-model scope classifier: in scope when the PR edits exactly ONE entry file (or, entry-free,
 * one flat provider file); the spec's provider + artifact files are allowed companions. A registry-looking
 * submission with too many entry/provider files is malformed and stays in the lane as mixed-files; an unrelated
 * PR with no direct registry files remains not-direct-submission.
 */
export function classifyRegistryPrScope(spec: RegistryLaneSpec, changedFiles: string[]): RegistryScopeResult {
  const files = (changedFiles ?? []).map((f) => String(f || "").trim()).filter(Boolean);
  const entryFiles = files.filter((f) => spec.entryFilePattern.test(f));
  const providerFiles = spec.providerFilePattern ? files.filter((f) => spec.providerFilePattern!.test(f)) : [];
  if (entryFiles.length > 1 || (entryFiles.length === 0 && providerFiles.length > 1)) {
    return { scope: "mixed-files", directFile: null, isProvider: false, providerCompanionFile: null };
  }
  const isEntryPr = entryFiles.length === 1;
  const isProviderPr = entryFiles.length === 0 && providerFiles.length === 1;
  if (!isEntryPr && !isProviderPr) {
    return { scope: "not-direct-submission", directFile: null, isProvider: false, providerCompanionFile: null };
  }
  const isAllowed = (f: string): boolean =>
    spec.entryFilePattern.test(f) || (spec.providerFilePattern?.test(f) ?? false) || (spec.artifactPattern?.test(f) ?? false);
  if (files.some((f) => !isAllowed(f))) {
    return { scope: "mixed-files", directFile: null, isProvider: false, providerCompanionFile: null };
  }
  // isEntryPr/isProviderPr each guarantee exactly one match (guarded by the early return), so [0] is always
  // defined; the `?? null` fallbacks below only satisfy noUncheckedIndexedAccess and can never fire.
  if (isProviderPr) {
    /* v8 ignore next */
    return { scope: "provider-submission", directFile: providerFiles[0] ?? null, isProvider: true, providerCompanionFile: null };
  }
  // isEntryPr: a debut-provider companion is exactly one OTHER providerFilePattern match riding along with the
  // entry file — more than one is an unrecognized shape (ambiguous which is "the" debut provider) and falls back
  // to the ordinary companion-file-changes review path in the orchestrator, same as before this field existed.
  const hasSingleProviderCompanion = providerFiles.length === 1;
  return {
    scope: "entry-submission",
    /* v8 ignore next */
    directFile: entryFiles[0] ?? null,
    isProvider: false,
    /* v8 ignore next -- hasSingleProviderCompanion guarantees providerFiles[0] is defined; the ?? null only satisfies noUncheckedIndexedAccess. */
    providerCompanionFile: hasSingleProviderCompanion ? (providerFiles[0] ?? null) : null,
  };
}

export function isRegistrySubmissionScope(scope: RegistryPrScope): boolean {
  return scope === "entry-submission" || scope === "provider-submission";
}

/** Normalizes a single field value for duplicate-identity comparison. A URL-shaped string is canonicalized via
 *  normalizePublicUrl (so http/https/case/trailing-slash/tracking-param differences don't count as different);
 *  any other string is trimmed + lowercased; a non-string value falls back to a structural JSON comparison.
 *  Returns null for a null/undefined value (an absent field contributes nothing to the identity). */
function normalizeIdentityValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return normalizePublicUrl(value) ?? value.trim().toLowerCase();
  return JSON.stringify(value);
}

/** The duplicate-identity key for `entry` under `fields` (e.g. `["url"]` or `["url", "kind"]`): the normalized
 *  values of those fields, combined via JSON.stringify. A plain joined string (e.g. space-separated) would be
 *  AMBIGUOUS — two entries whose field values straddle the join boundary differently could collide onto the same
 *  string (`["alpha beta", "docs"]` vs `["alpha", "beta docs"]` both joining to "alpha beta docs") and falsely
 *  read as duplicates; JSON.stringify's quoting/structure makes field boundaries unambiguous regardless of
 *  content. Returns null when EVERY configured field is absent on this entry — there's nothing to key on, so it
 *  can never match or be matched. */
function duplicateIdentityKey(entry: unknown, fields: readonly string[]): string | null {
  const record = entry as Record<string, unknown> | null;
  const parts = fields.map((field) => normalizeIdentityValue(record?.[field]));
  return parts.every((part) => part === null) ? null : JSON.stringify(parts);
}

/**
 * The first entry in `appendedEntries` whose duplicate-identity key (under `spec.duplicateKeyFields`) collides
 * with an EARLIER appended entry (a same-PR duplicate) or with any entry already in `existingEntries` (a
 * resubmission of an entry already in the registry) — wrapped in a 1-tuple so a legitimate falsy/null entry value
 * is never confused with "no duplicate found" (plain `null`). Returns null when the spec has no
 * `duplicateKeyFields` (the default — duplicate detection is opt-in per spec) or no collision exists. Generic:
 * works for ANY RegistryLaneSpec by duck-typing the configured field names, not just metagraphed's.
 */
export function findDuplicateAppendedEntry(
  spec: RegistryLaneSpec,
  appendedEntries: readonly unknown[],
  existingEntries: readonly unknown[],
): [unknown] | null {
  const fields = spec.duplicateKeyFields;
  if (!fields || fields.length === 0) return null;
  const seen = new Set<string>();
  for (const entry of existingEntries) {
    const key = duplicateIdentityKey(entry, fields);
    if (key !== null) seen.add(key);
  }
  for (const entry of appendedEntries) {
    const key = duplicateIdentityKey(entry, fields);
    if (key === null) continue;
    if (seen.has(key)) return [entry];
    seen.add(key);
  }
  return null;
}

// metagraphed's spec — the first RegistryLaneSpec. surfaces[] live in registry/subnets/<slug>.json; providers
// are FLAT registry/providers/<slug>.json (the community/ subdir was retired). A PR touching the old
// registry/candidates/community/* path matches none of these → mixed-files / not-direct (correctly not adopted
// as a valid submission; metagraphed CI hard-fails it).
export const SUBNET_ENTRY_PATTERN = /^registry\/subnets\/[a-z0-9][a-z0-9-]*\.json$/;
export const FLAT_PROVIDER_PATTERN = /^registry\/providers\/[a-z0-9][a-z0-9-]*\.json$/;
export const METAGRAPHED_LANE_SPEC: RegistryLaneSpec = {
  entryFilePattern: SUBNET_ENTRY_PATTERN,
  providerFilePattern: FLAT_PROVIDER_PATTERN,
  artifactPattern: ARTIFACT_PATTERN,
  collectionField: "surfaces",
  // metagraphed's contributor docs deliberately allow appending SEVERAL surfaces[] entries for one subnet in one
  // PR (the 2026-06 anti-farming fix: splitting one subnet's surfaces into many near-identical PRs is what the
  // single-entry cap used to force) — no cap here, per entry validated independently by the orchestrator.
  maxAppendedEntries: Infinity,
  // Removing the single-entry cap also removed its incidental side effect of rejecting a same-PR duplicate
  // surfaces[] entry (added.length!==1 used to close it). Opt back into duplicate detection explicitly, keyed on
  // `url` alone (a subnet's surfaces are distinct interfaces; the same url appearing twice — in one PR or against
  // an entry already registered — is a resubmission, not a new surface).
  duplicateKeyFields: ["url"],
  // metagraphed's own domain-specific semantic validators (netuid/kind/public_safe/auth_required shape+safety
  // checks) — supplied here, not hardcoded into the orchestrator, so a different registry can supply its own.
  assessAppendedEntry: assessSubnetDocument,
  assessProviderEntry: assessProviderDocument,
};
