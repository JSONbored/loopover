// Live surface-entry content verification (#8908, #8909) — the fetch plumbing that finally CONSULTS the two
// calibration primitives registry-logic.ts has always exported but nothing ever called:
//
//   - computeGrounding        (#8908): does the fetched evidence actually corroborate the declared netuid /
//                                      owner / host, or is the submission an unbacked claim?
//   - probeFunctionalSurface  (#8909): for the FUNCTIONAL kinds (openapi / subnet-api / sse), does the declared
//                                      url actually SERVE the surface its `kind` claims?
//
// Both were fully implemented + unit-tested but had zero callers outside their own test file, so the live
// surface-entry gate (assessSurfaceEntry → runSurfaceReview) merged a submission having never once looked at
// what its URLs serve. This module supplies the missing half: SSRF-guarded fetches, evidence extraction, and the
// gating decision — leaving both primitives untouched.
//
// SHAPE: all I/O is the injected `fetchImpl`, exactly like source-evidence.ts and netuid-verification.ts, so the
// whole module is unit-testable without network. The orchestrator consumes it through ONE injected
// `verifyEntry` hook (SurfaceReviewInput), so the orchestrator itself stays domain-agnostic and any other
// registry can supply its own verifier.
//
// THREE-STATE, NEVER FAIL-OPEN. Each check resolves to pass / fail / inconclusive and those are kept strictly
// distinct: an inconclusive result (a probe that never got a usable response, or a submission with no fetchable
// corroborating evidence) is NEVER reported as a pass. It holds the PR for a human instead. This is the whole
// point of the issues — a check that silently passes when it could not run is worse than no check, because it
// launders "we didn't look" into "we verified".
import {
  type Assessment,
  type CandidateLike,
  type MetaVerdict,
  computeGrounding,
  functionalRequired,
  probeFunctionalSurface,
  registrableDomain,
} from "./registry-logic";
import { isSafeHttpUrl } from "./safe-url";

/**
 * Minimum `computeGrounding().strong` score an entry must reach for its claim to count as independently
 * corroborated. ONE positive signal — the evidence names the declared netuid, OR names the claimed
 * owner, OR the source independently backs the target host — net of computeGrounding's own cross-origin-redirect
 * penalty.
 *
 * Deliberately 1, not 2: metagraphed is a PUBLIC registry whose own identity-token code comments state that
 * corroboration here is "ACCURACY corroboration, NOT ownership gating". Requiring two independent signals would
 * hold a large share of legitimate submissions (a real subnet's docs page routinely fails to literally print its
 * netuid, and a docs host routinely shares no apex with its source repo), and a false HOLD on good work is the
 * expensive mistake for a one-shot gate. One signal still forecloses the case these issues exist to catch: a
 * surface whose fetched evidence corroborates NOTHING about the subnet it claims to belong to.
 */
export const SURFACE_GROUNDING_MIN_STRONG = 1;

/** Max characters read from a probed body. probeFunctionalSurface is explicitly truncation-tolerant (it accepts
 *  an openapi version key with "paths beyond the window"), so a bounded read is sufficient and keeps a hostile
 *  or merely enormous response from being pulled into memory whole. */
export const MAX_PROBE_BODY_CHARS = 64_000;
/** Max characters of extracted text handed to computeGrounding as an evidence snippet. */
const MAX_EVIDENCE_SNIPPET_CHARS = 8_000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_REDIRECTS = 4;

// Same browser-like headers source-evidence.ts uses, and for the same reason: major doc hosts answer a missing
// or bot-looking User-Agent with a 403 even for fully public pages, which would false-fail valid surfaces.
const PROBE_FETCH_HEADERS: Readonly<Record<string, string>> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  accept: "application/json,application/yaml,text/event-stream;q=0.9,text/html;q=0.8,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
};

/** A single check's three-state outcome. `inconclusive` is NOT a pass and NOT a fail — the check could not run. */
export type SurfaceCheckOutcome = "pass" | "fail" | "inconclusive";

export interface SurfaceCheckResult {
  outcome: SurfaceCheckOutcome;
  /** Human-readable reason, rendered into the public PR comment when the check gates. */
  detail: string;
}

/** One fetched URL's result. `ok` is true only for a real 2xx response — every other shape (non-2xx, redirect
 *  loop, SSRF-rejected host, thrown/timed-out fetch) is a NON-ok probe and therefore inconclusive evidence. */
export interface SurfaceProbe {
  ok: boolean;
  httpStatus: number | null;
  contentType: string | null;
  body: string;
  /** The fetch was redirected to a different registrable domain — computeGrounding's bait-and-switch penalty. */
  crossOriginRedirect: boolean;
  /** Why the probe is not ok (an outcome token, never raw provider text). */
  error: string | null;
}

const unreachableProbe = (error: string, httpStatus: number | null = null): SurfaceProbe => ({
  ok: false,
  httpStatus,
  contentType: null,
  body: "",
  crossOriginRedirect: false,
  error,
});

function redirectLocation(response: Response, currentUrl: string): string {
  const location = response.headers.get("location");
  if (!location) return "";
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return "";
  }
}

/**
 * Fetch one public URL and report what it actually served. SSRF-guarded via `isSafeHttpUrl` on EVERY hop (the
 * redirect chain is followed manually for exactly this reason — an https origin that 302s to 127.0.0.1 must not
 * be followed), bounded to MAX_PROBE_REDIRECTS hops and a read of MAX_PROBE_BODY_CHARS.
 *
 * NEVER THROWS: every failure mode collapses into an `ok:false` probe carrying an outcome token, because a
 * thrown fetch here must degrade to "inconclusive" (a human looks) rather than escaping into the review
 * pipeline or, worse, being caught somewhere upstream and read as a pass.
 */
export async function fetchSurfaceProbe(url: string, fetchImpl: typeof fetch = fetch): Promise<SurfaceProbe> {
  const startDomain = registrableDomain(url);
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_PROBE_REDIRECTS; hop += 1) {
    if (!isSafeHttpUrl(currentUrl)) return unreachableProbe("probe_url_not_public");
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: { ...PROBE_FETCH_HEADERS },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch {
      return unreachableProbe("probe_fetch_failed");
    }
    if (response.status >= 300 && response.status < 400) {
      const nextUrl = redirectLocation(response, currentUrl);
      if (!nextUrl) return unreachableProbe("probe_redirect_without_location", response.status);
      if (hop === MAX_PROBE_REDIRECTS) return unreachableProbe("probe_too_many_redirects", response.status);
      currentUrl = nextUrl;
      continue;
    }
    if (!response.ok) return unreachableProbe("probe_http_error", response.status);
    let body: string;
    try {
      body = (await response.text()).slice(0, MAX_PROBE_BODY_CHARS);
    } catch {
      // A 2xx whose body cannot be read (a broken/aborted stream) is NOT a served surface — the response line
      // alone proves nothing about what the URL serves, so this stays inconclusive rather than an empty pass.
      return unreachableProbe("probe_body_unreadable", response.status);
    }
    return {
      ok: true,
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
      body,
      // A redirect that lands on a different registrable domain than the submission declared is the classic
      // bait-and-switch; computeGrounding already knows how to penalize it, it just needs to be TOLD. With no
      // redirect, currentUrl is still the original url, so this compares equal and reports false.
      crossOriginRedirect: registrableDomain(currentUrl) !== startDomain,
      error: null,
    };
  }
  /* v8 ignore next -- unreachable: the loop runs hops 0..MAX inclusive and every path returns (the hop===MAX
     redirect returns too_many_redirects); this only satisfies the type checker. */
  return unreachableProbe("probe_too_many_redirects");
}

/** `<title>` text of an HTML body, or null. */
function extractTitle(body: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(body);
  const raw = match?.[1];
  return raw ? raw.replace(/\s+/g, " ").trim() || null : null;
}

/**
 * A probed body reduced to the plain text computeGrounding matches its netuid/owner/host signals against.
 * Script and style blocks are dropped first (their contents are code, not page claims, and a bundled script
 * mentioning an unrelated "subnet 14" would otherwise forge a grounding signal), then tags are stripped and
 * whitespace collapsed. A non-HTML body (JSON/YAML/SSE) is used as-is — it is already text.
 */
export function probeToEvidence(probe: SurfaceProbe): { title: string; snippet: string; cross_origin_redirect: boolean } {
  const isHtml = /html/i.test(probe.contentType ?? "") || /^\s*<(?:!doctype|html)\b/i.test(probe.body);
  const text = isHtml
    ? probe.body
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : probe.body;
  return {
    title: (isHtml ? extractTitle(probe.body) : null) ?? "",
    snippet: text.slice(0, MAX_EVIDENCE_SNIPPET_CHARS),
    cross_origin_redirect: probe.crossOriginRedirect,
  };
}

/** The entry's declared corroborating source URL (`source_url`, else the first `source_urls[]` entry). */
function entrySourceUrl(entry: CandidateLike): string {
  const single = entry.source_url;
  if (typeof single === "string" && single.trim()) return single.trim();
  const list = entry.source_urls;
  const first = Array.isArray(list) ? list[0] : null;
  return typeof first === "string" ? first.trim() : "";
}

export interface SurfaceEntryVerification {
  grounding: SurfaceCheckResult;
  functional: SurfaceCheckResult;
  /** What this verification forces onto an entry that already passed static validation. */
  disposition: MetaVerdict;
  /** Public, actionable text for a non-merged disposition; null when the entry verified clean. */
  summary: string | null;
  /** Machine reason code for a non-merged disposition; null when the entry verified clean. */
  reason: string | null;
}

/** Reason codes this module can attach. Deliberately NOT added to registry-logic's REVIEWER_CLOSE_REASONS: that
 *  set exists solely so its private `fail()` helper can map a reason to a verdict, and these assessments are
 *  built here with an explicit verdict rather than routed through it. */
export const FUNCTIONAL_NOT_SERVED_REASON = "functional-surface-not-served";
export const FUNCTIONAL_INCONCLUSIVE_REASON = "functional-probe-inconclusive";
export const GROUNDING_INCONCLUSIVE_REASON = "grounding-inconclusive";
export const GROUNDING_UNCONFIRMED_REASON = "grounding-unconfirmed";

/**
 * Run both live checks for ONE surface entry that has already passed static validation.
 *
 * Fetches at most two URLs, concurrently:
 *  - the declared `source_url` — the corroborating evidence #8908's grounding check needs. Its probe is what
 *    makes grounding conclusive at all: with no readable source there is nothing to corroborate AGAINST, which
 *    is inconclusive, never a pass.
 *  - the entry's own `url` — needed by #8909's functional probe, and additionally fed to grounding as target
 *    evidence. Skipped when it is not an https URL, which is the normal, expected shape for a base-layer
 *    `wss://` endpoint: grounding then rests on the source evidence alone (still conclusive — computeGrounding
 *    matches the netuid and the target HOST out of the source body), and no functional kind is a wss kind, so
 *    nothing silently degrades.
 */
export async function verifySurfaceEntry(
  entry: CandidateLike,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<SurfaceEntryVerification> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sourceUrl = entrySourceUrl(entry);
  const targetUrl = typeof entry.url === "string" ? entry.url.trim() : "";
  const targetFetchable = isSafeHttpUrl(targetUrl);
  const [sourceProbe, targetProbe] = await Promise.all([
    isSafeHttpUrl(sourceUrl) ? fetchSurfaceProbe(sourceUrl, fetchImpl) : Promise.resolve(unreachableProbe("probe_url_not_public")),
    targetFetchable ? fetchSurfaceProbe(targetUrl, fetchImpl) : Promise.resolve(null),
  ]);

  const functional = assessFunctional(entry, targetProbe);
  const grounding = assessGrounding(entry, sourceProbe, targetProbe);
  return decide(grounding, functional);
}

/** #8909: does the declared url actually serve the surface its `kind` claims? A null `targetProbe` means the
 *  url was never https-fetchable, so no probe was attempted (see verifySurfaceEntry). */
function assessFunctional(entry: CandidateLike, targetProbe: SurfaceProbe | null): SurfaceCheckResult {
  if (!functionalRequired(entry.kind)) {
    return { outcome: "pass", detail: "n/a — this kind declares no functional surface" };
  }
  // A functional kind whose url isn't even https-fetchable can't be probed. assessSurfaceEntry's own url safety
  // check normally rejects this first, but it is skippable via `sourceUrlValidation:false`, so guard it here too
  // rather than letting an unprobed functional surface fall through as verified.
  if (targetProbe === null) {
    return { outcome: "inconclusive", detail: "the declared url is not a fetchable public HTTPS URL, so the surface could not be probed" };
  }
  if (!targetProbe.ok) {
    const status = targetProbe.httpStatus === null ? targetProbe.error : `HTTP ${targetProbe.httpStatus}`;
    return { outcome: "inconclusive", detail: `the declared url could not be probed (${status})` };
  }
  // A 2xx with a blank body proves nothing about what is served; probeFunctionalSurface would read a json
  // content-type alone as a served API. Treat a degraded/empty response as inconclusive, never a pass.
  if (targetProbe.body.trim() === "") {
    return { outcome: "inconclusive", detail: "the declared url returned an empty body, so what it serves could not be confirmed" };
  }
  const probe = probeFunctionalSurface(entry.kind, targetProbe.contentType, targetProbe.body);
  return probe.served ? { outcome: "pass", detail: probe.detail } : { outcome: "fail", detail: probe.detail };
}

/** #8908: does the fetched evidence actually corroborate the declared netuid / owner / host? */
function assessGrounding(entry: CandidateLike, sourceProbe: SurfaceProbe, targetProbe: SurfaceProbe | null): SurfaceCheckResult {
  if (!sourceProbe.ok) {
    const status = sourceProbe.httpStatus === null ? sourceProbe.error : `HTTP ${sourceProbe.httpStatus}`;
    return { outcome: "inconclusive", detail: `the declared source URL could not be fetched (${status}), so nothing corroborates this entry` };
  }
  const signals = computeGrounding(
    entry,
    targetProbe !== null && targetProbe.ok ? probeToEvidence(targetProbe) : null,
    probeToEvidence(sourceProbe),
  );
  if (signals.strong >= SURFACE_GROUNDING_MIN_STRONG) {
    const named = [
      signals.netuidMentioned ? "netuid" : "",
      signals.ownerMentioned ? "owner" : "",
      signals.hostMatchesClaim ? "host" : "",
    ].filter(Boolean);
    return { outcome: "pass", detail: `corroborated by ${named.join(" + ")}` };
  }
  const penalty = signals.crossOriginRedirect ? " (a cross-domain redirect was followed, which discounts the evidence)" : "";
  return {
    outcome: "fail",
    detail: `the fetched evidence corroborates none of the declared netuid, owner, or host${penalty}`,
  };
}

/**
 * The gating decision — the part these issues actually asked to be designed, not just wired.
 *
 * CLOSE only for a CONFIRMED functional failure (#8909's "holding/closing on served:false"): a 2xx response
 * whose body demonstrably is not the declared surface — an `openapi` url serving an HTML marketing page, an
 * `sse` url that is not an event stream. That is an objective, reproducible fact about the submission, in the
 * same class as the shape/kind violations assessSurfaceEntry already closes on, and it is trivially fixable by
 * resubmitting with the right `kind` or the right url.
 *
 * HOLD (manual review) for everything softer: any inconclusive probe, and a failed GROUNDING check. Grounding
 * is a heuristic corroboration score over fetched page text, not a fact about the response — a legitimate
 * surface can genuinely fail it (a docs page that never prints its netuid, hosted on a domain unrelated to its
 * source repo). Closing on it would one-shot-close good contributions on a heuristic, so it holds for a human
 * instead. Crucially it no longer MERGES: before this module, an entry corroborated by nothing at all sailed
 * through, which is exactly the gap #8908 describes.
 *
 * Precedence is fail-closed-first: a confirmed functional failure outranks everything, then any inconclusive
 * probe, then unconfirmed grounding. Inconclusive and failed grounding carry DISTINCT reason codes and distinct
 * public text even though both hold, so "we could not check" is never rendered as "we checked and disliked it".
 */
function decide(grounding: SurfaceCheckResult, functional: SurfaceCheckResult): SurfaceEntryVerification {
  const base = { grounding, functional };
  if (functional.outcome === "fail") {
    return {
      ...base,
      disposition: "closed",
      reason: FUNCTIONAL_NOT_SERVED_REASON,
      summary: `Surface entry's url does not serve the interface its \`kind\` declares — ${functional.detail}. Resubmit with a url that serves the declared surface, or with the kind that matches what it actually serves.`,
    };
  }
  if (functional.outcome === "inconclusive") {
    return {
      ...base,
      disposition: "manual-review",
      reason: FUNCTIONAL_INCONCLUSIVE_REASON,
      summary: `Could not confirm the declared surface is served — ${functional.detail}. Routing to review rather than accepting an unverified functional surface.`,
    };
  }
  if (grounding.outcome === "inconclusive") {
    return {
      ...base,
      disposition: "manual-review",
      reason: GROUNDING_INCONCLUSIVE_REASON,
      summary: `Could not verify this entry against its declared source — ${grounding.detail}. Routing to review rather than accepting an unverified claim.`,
    };
  }
  if (grounding.outcome === "fail") {
    return {
      ...base,
      disposition: "manual-review",
      reason: GROUNDING_UNCONFIRMED_REASON,
      summary: `The declared source does not corroborate this entry — ${grounding.detail}. Routing to review to confirm the surface really belongs to this subnet.`,
    };
  }
  return { ...base, disposition: "merged", reason: null, summary: null };
}

/**
 * Adapt `verifySurfaceEntry` into the orchestrator's `verifyEntry` hook: return an OVERRIDING Assessment when
 * live verification downgrades the entry (hold or close), or `null` when it confirms it — in which case the
 * entry's existing static "merged" assessment stands unchanged.
 */
export function makeSurfaceEntryVerifier(opts: { fetchImpl?: typeof fetch } = {}): (entry: unknown) => Promise<Assessment | null> {
  return async (entry: unknown): Promise<Assessment | null> => {
    if (!entry || typeof entry !== "object") return null;
    const candidate = entry as CandidateLike;
    const verification = await verifySurfaceEntry(candidate, opts);
    if (verification.disposition === "merged") return null;
    return {
      verdict: verification.disposition,
      // Both are non-null for every non-merged disposition (see `decide`), so the fallback/spread arms below are
      // unreachable; they only satisfy the Assessment field types under exactOptionalPropertyTypes.
      /* v8 ignore next */
      summary: verification.summary ?? "Registry surface verification.",
      candidate,
      /* v8 ignore next */
      ...(verification.reason !== null ? { reason: verification.reason } : {}),
    };
  };
}
