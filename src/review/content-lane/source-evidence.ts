// Deterministic source-evidence content gate (content-lane primitive).
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence). Byte-faithful to reviewbot's
// src/agents/awesome-claude/source-evidence.ts. The SSRF guard is the shared content-lane
// `isSafeHttpUrl` (safe-url.ts); the browser fetch headers and the SHA-256 hash are inlined here.
//
// Security-sensitive: behavior is preserved exactly — TRUSTED/DISTRIBUTION host allowlists, the
// frontmatter source-field set, HEAD-then-GET with manual redirect, canonical-vs-distribution
// classification, the inconclusive-downgrade-when-a-verifiable-canonical-exists rule, the evidence
// hash, and the close decision (hard-close only when ALL authoritative sources failed AND there is
// more than one authoritative source).
//
// PURE + testable: callers pass the raw MDX/markdown source string and may inject a fetchImpl
// (defaults to global fetch). All I/O is the injected fetch.
import { isSafeHttpUrl } from "./safe-url";

// Browser-like request headers — major doc hosts return 403 to a missing/bot User-Agent even for
// public pages, false-failing valid source URLs. Presenting as a browser fetches the real page.
const BROWSER_FETCH_HEADERS: Readonly<Record<string, string>> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5",
  "accept-language": "en-US,en;q=0.9",
};

/** SHA-256 hex of a string (Web Crypto). Inlined from reviewbot core/crypto.ts sha256Hex. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Source-evidence gate ──────────────────────────────────────────────────────────────────────

export type SubmittedSourceUrl = {
  field: string;
  url: string;
};

export type SourceEvidenceRole = "canonical" | "distribution";

export type SourceEvidenceItem = SubmittedSourceUrl & {
  status: "passed" | "hard_failure" | "retryable";
  role: SourceEvidenceRole;
  blocking: boolean;
  outcome: string;
  httpStatus?: number;
  finalUrl?: string;
  error?: string;
};

export type SourceEvidenceReport = {
  status: "passed" | "failed" | "retryable";
  hash: string;
  urls: SourceEvidenceItem[];
  warnings: SourceEvidenceItem[];
};

export type SourceEvidenceDecisionEvidence = {
  ruleId: "source_url_reachability";
  field: string;
  url: string;
  matchedUrl: string;
  finalUrl?: string;
  outcome: string;
  status: string;
  httpStatus?: string;
  behavior: string;
  fix: string;
};

export type SourceEvidenceDecision = {
  verdict: "close" | "manual";
  reasonCode: "source_hard_failure";
  evidence: SourceEvidenceDecisionEvidence[];
  sourceEvidenceHash: string;
  confidence: 1;
  summary: string;
  labels: string[];
  close: boolean;
};

const SOURCE_EVIDENCE_LABELS = {
  manual: "submission-manual-review",
  close: "submission-closed-by-gate",
} as const;

const SOURCE_URL_FIELDS = [
  "documentationUrl",
  "docsUrl",
  "downloadUrl",
  "githubUrl",
  "packageUrl",
  "repoUrl",
  "repositoryUrl",
  "sourceUrl",
  "websiteUrl",
] as const;

// Array-valued source fields. `retrievalSources` is the documented grounding field; read it (and
// `sourceUrls`) as real source evidence.
const SOURCE_URL_LIST_FIELDS = new Set(["sourceUrls", "retrievalSources"]);
const SOURCE_EVIDENCE_TIMEOUT_MS = 5_000; // HEAD fast-path probe (failure falls through to the GET).
const SOURCE_EVIDENCE_GET_TIMEOUT_MS = 12_000;
const SOURCE_EVIDENCE_GET_ATTEMPTS = 2;
const MAX_SOURCE_EVIDENCE_URLS = 10;
const MAX_SOURCE_EVIDENCE_REDIRECTS = 4;
const DISTRIBUTION_SOURCE_FIELDS = new Set(["downloadUrl", "packageUrl"]);

export const DISTRIBUTION_SOURCE_HOSTS = new Set([
  "crates.io",
  "files.pythonhosted.org",
  "hub.docker.com",
  "marketplace.visualstudio.com",
  "mvnrepository.com",
  "npmjs.com",
  "packagist.org",
  "pkg.go.dev",
  "plugins.gradle.org",
  "pypi.org",
  "registry.npmjs.org",
  "repo1.maven.org",
  "rubygems.org",
  "www.npmjs.com",
]);

export const TRUSTED_SOURCE_HOSTS = new Set([
  "bitbucket.org",
  "crates.io",
  "deno.land",
  "docs.anthropic.com",
  "docs.github.com",
  "gist.github.com",
  "github.com",
  "gitlab.com",
  "jsr.io",
  "codeload.github.com",
  "marketplace.visualstudio.com",
  "npmjs.com",
  "pkg.go.dev",
  "pypi.org",
  "raw.githubusercontent.com",
  "www.npmjs.com",
]);

const TRUSTED_SOURCE_HOST_SUFFIXES: readonly string[] = [];
const PRIMARY_CANONICAL_SOURCE_FIELDS = new Set(["githubUrl", "repoUrl", "repositoryUrl", "sourceUrl"]);

function stripYamlComment(value: string): string {
  return value.replace(/\s+#.*$/, "").trim();
}

function unquoteYamlValue(value: string): string {
  const trimmed = stripYamlComment(value);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.trim();
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

// Local frontmatter parser (scalar source-field reader; block-scalar aware so a URL written as a
// block scalar is still SEEN by the source-reachability gate).
function parseSimpleFrontmatter(source: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(source || ""));
  const fields: Record<string, string> = {};
  if (!match) return fields;
  const lines = (match[1] ?? "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const head = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(lines[i] ?? "");
    if (!head) {
      i += 1;
      continue;
    }
    const key = head[1] as string;
    const inline = (head[2] ?? "").trim();
    i += 1;
    if (/^[|>][+-]?\d*$/.test(inline)) {
      const block: string[] = [];
      while (i < lines.length && ((lines[i] ?? "").trim() === "" || /^\s/.test(lines[i] ?? ""))) {
        block.push((lines[i] ?? "").replace(/^\s+/, ""));
        i += 1;
      }
      fields[key] = block.join(inline.startsWith(">") ? " " : "\n").trim();
    } else if (inline !== "") {
      fields[key] = unquoteYamlScalar(inline);
    }
  }
  return fields;
}

function frontmatterBlock(source: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(source || ""));
  return match?.[1] || "";
}

function scalarSourceUrlValues(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(unquoteYamlValue).filter(Boolean);
  }
  return [unquoteYamlValue(trimmed)].filter(Boolean);
}

function listSourceUrlValues(source: string): SubmittedSourceUrl[] {
  const values: SubmittedSourceUrl[] = [];
  let activeField = "";
  for (const line of frontmatterBlock(source).split(/\r?\n/)) {
    const topLevel = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (topLevel) {
      const key = topLevel[1] as string;
      const value = topLevel[2] as string;
      activeField = SOURCE_URL_LIST_FIELDS.has(key) ? key : "";
      if (activeField && value && value !== "|" && value !== ">") {
        for (const url of scalarSourceUrlValues(value)) {
          values.push({ field: activeField, url });
        }
      }
      continue;
    }
    if (!activeField) continue;
    const item = /^\s*-\s*(.*?)\s*$/.exec(line);
    if (!item) continue;
    const url = unquoteYamlValue(item[1] || "");
    if (url) values.push({ field: activeField, url });
  }
  return values;
}

function isAbsoluteHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function extractSubmittedSourceUrls(source: string): SubmittedSourceUrl[] {
  const fields = parseSimpleFrontmatter(source);
  const urls: SubmittedSourceUrl[] = [];
  for (const field of SOURCE_URL_FIELDS) {
    for (const url of scalarSourceUrlValues(fields[field] || "")) {
      urls.push({ field, url });
    }
  }
  urls.push(...listSourceUrlValues(source));

  const seen = new Set<string>();
  return urls.filter((item) => {
    // A DISTRIBUTION field (downloadUrl/packageUrl) with a SITE-RELATIVE value is the build's own
    // generated artifact (e.g. `/downloads/skills/<slug>.zip`) — not external provenance and not
    // fetchable as written, so drop it. External distribution URLs are absolute and remain verified.
    if (DISTRIBUTION_SOURCE_FIELDS.has(item.field) && !isAbsoluteHttpUrl(item.url)) return false;
    const key = `${item.field}\n${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceRole(item: SubmittedSourceUrl): SourceEvidenceRole {
  if (DISTRIBUTION_SOURCE_FIELDS.has(item.field)) return "distribution";
  try {
    const host = new URL(item.url).hostname.toLowerCase();
    if (DISTRIBUTION_SOURCE_HOSTS.has(host)) return "distribution";
  } catch {
    // Malformed URLs are classified separately as hard failures.
  }
  return "canonical";
}

function withSourceDefaults(
  item: SubmittedSourceUrl,
  values: Omit<SourceEvidenceItem, keyof SubmittedSourceUrl | "role" | "blocking">,
): SourceEvidenceItem {
  return {
    ...item,
    ...values,
    role: sourceRole(item),
    blocking: true,
  };
}

function sourceStatusFromHttpStatus(status: number): "passed" | "hard_failure" | "retryable" {
  if (status >= 200 && status < 400) return "passed";
  if ([401, 403, 408, 425, 429].includes(status) || status >= 500) return "retryable";
  if (status === 404 || status === 410) return "hard_failure";
  if (status >= 400 && status < 500) return "hard_failure";
  return "retryable";
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

// Retained for parity with the reviewbot source (the allowlist is the gate's documented posture);
// the live gate fetches any safe public host, not just an allowlist — see validateFetchableSourceUrl.
/* v8 ignore start -- Dead parity retainer: never called (the live gate is allowlist-free); kept byte-faithful to reviewbot's documented allowlist posture. */
function _sourceHostIsTrusted(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    TRUSTED_SOURCE_HOSTS.has(normalized) ||
    DISTRIBUTION_SOURCE_HOSTS.has(normalized) ||
    TRUSTED_SOURCE_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}
/* v8 ignore stop */
void _sourceHostIsTrusted;

type FetchableValidation = { ok: true; parsed: URL } | { ok: false; outcome: string; error: string };

function validateFetchableSourceUrl(url: string): FetchableValidation {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    return {
      ok: false,
      outcome: "invalid_url",
      error: error instanceof Error ? error.message : "Invalid source URL.",
    };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, outcome: "invalid_url", error: "Source URL must use http or https." };
  }
  // The gate is the SSRF guard, NOT a host allowlist: fetch and verify ANY safe public host.
  // isSafeHttpUrl requires https and rejects loopback/link-local/private hosts (re-checked per hop).
  if (!isSafeHttpUrl(parsed.toString())) {
    return {
      ok: false,
      outcome: "source_host_not_checked",
      error: "Source URL must be https with a public (non-loopback, non-private) host to be verified.",
    };
  }
  return { ok: true, parsed };
}

function redirectLocation(response: Response, currentUrl: string): string {
  const location = response.headers.get("location");
  if (!location) return "";
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return "";
  }
}

async function fetchSourceUrl(
  item: SubmittedSourceUrl,
  method: "HEAD" | "GET",
  fetchImpl: typeof fetch,
  timeoutMs: number = SOURCE_EVIDENCE_TIMEOUT_MS,
): Promise<SourceEvidenceItem> {
  let currentUrl = item.url;
  for (let redirects = 0; redirects <= MAX_SOURCE_EVIDENCE_REDIRECTS; redirects += 1) {
    const validation = validateFetchableSourceUrl(currentUrl);
    if (!validation.ok) {
      return withSourceDefaults(item, {
        status: "hard_failure",
        outcome: validation.outcome,
        error: validation.error,
      });
    }

    const response = await fetchImpl(currentUrl, {
      method,
      redirect: "manual",
      headers: { ...BROWSER_FETCH_HEADERS },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status >= 300 && response.status < 400) {
      const nextUrl = redirectLocation(response, currentUrl);
      if (!nextUrl) {
        return withSourceDefaults(item, {
          status: "retryable",
          outcome: "redirect_without_location",
          httpStatus: response.status,
          finalUrl: currentUrl,
        });
      }
      if (redirects === MAX_SOURCE_EVIDENCE_REDIRECTS) {
        return withSourceDefaults(item, {
          status: "retryable",
          outcome: "too_many_redirects",
          httpStatus: response.status,
          finalUrl: currentUrl,
        });
      }
      currentUrl = nextUrl;
      continue;
    }

    const status = sourceStatusFromHttpStatus(response.status);
    return withSourceDefaults(item, {
      status,
      outcome: status === "passed" ? "reachable" : status === "hard_failure" ? "http_hard_failure" : "source_inconclusive",
      httpStatus: response.status,
      finalUrl: currentUrl,
    });
  }

  /* v8 ignore next -- Unreachable: the loop runs redirects 0..MAX inclusive and always returns (the redirects===MAX hop returns too_many_redirects); this trailing return only satisfies the type checker. */
  return withSourceDefaults(item, { status: "retryable", outcome: "too_many_redirects" });
}

async function checkOneSourceUrl(item: SubmittedSourceUrl, fetchImpl: typeof fetch): Promise<SourceEvidenceItem> {
  const validation = validateFetchableSourceUrl(item.url);
  if (!validation.ok) {
    const invalidProtocol = validation.outcome === "invalid_url";
    return withSourceDefaults(item, {
      status: invalidProtocol ? "hard_failure" : "passed",
      outcome: validation.outcome,
      error: validation.error,
    });
  }

  try {
    const head = await fetchSourceUrl(item, "HEAD", fetchImpl, SOURCE_EVIDENCE_TIMEOUT_MS);
    if (head.status === "passed") return head;
  } catch {
    // Some source hosts reject HEAD or transiently fail it. Confirm with GET.
  }

  // Authoritative GET: a generous timeout + ONE retry on a transient (timeout/network) THROW. A
  // RETURNED result (incl. an HTTP error status) is authoritative and returned immediately.
  let lastError: unknown;
  for (let attempt = 1; attempt <= SOURCE_EVIDENCE_GET_ATTEMPTS; attempt += 1) {
    try {
      return await fetchSourceUrl(item, "GET", fetchImpl, SOURCE_EVIDENCE_GET_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
    }
  }
  return withSourceDefaults(item, {
    status: "retryable",
    outcome: "fetch_error",
    error: lastError instanceof Error ? lastError.message : "Source URL fetch failed before a response was returned.",
  });
}

function sourceEvidenceHashInput(urls: SourceEvidenceItem[]): string {
  return JSON.stringify(
    urls.map((item) => ({
      field: item.field,
      url: item.url,
      finalUrl: item.finalUrl || "",
      status: item.status,
      outcome: item.outcome,
      httpStatus: item.httpStatus || null,
      role: item.role,
      blocking: item.blocking,
    })),
  );
}

function hasVerifiableCanonicalSource(urls: SourceEvidenceItem[]): boolean {
  const reachableCanonical = urls.filter(
    (item) => item.role === "canonical" && item.status === "passed" && item.outcome === "reachable",
  );
  return (
    reachableCanonical.length >= 2 ||
    reachableCanonical.some((item) => PRIMARY_CANONICAL_SOURCE_FIELDS.has(item.field))
  );
}

function isDowngradableInconclusiveSource(item: SourceEvidenceItem): boolean {
  if (item.status === "retryable" && !PRIMARY_CANONICAL_SOURCE_FIELDS.has(item.field)) {
    return true;
  }
  return item.status === "hard_failure" && item.role === "distribution" && item.outcome === "source_host_not_checked";
}

function downgradeInconclusiveSourceWarnings(urls: SourceEvidenceItem[]): SourceEvidenceItem[] {
  if (!hasVerifiableCanonicalSource(urls)) return urls;
  return urls.map((item) => (isDowngradableInconclusiveSource(item) ? { ...item, blocking: false } : item));
}

export async function checkSubmittedSourceEvidence(
  source: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceEvidenceReport> {
  const extracted = extractSubmittedSourceUrls(source);
  // Check the URLs in PARALLEL — each is independent. Promise.all preserves order, so the evidence
  // hash is unchanged.
  const checkedUrls: SourceEvidenceItem[] = await Promise.all(
    extracted.slice(0, MAX_SOURCE_EVIDENCE_URLS).map((item) => checkOneSourceUrl(item, fetchImpl)),
  );
  for (const item of extracted.slice(MAX_SOURCE_EVIDENCE_URLS)) {
    checkedUrls.push(
      withSourceDefaults(item, {
        status: "hard_failure",
        outcome: "too_many_source_urls",
        error: `Only ${MAX_SOURCE_EVIDENCE_URLS} source URLs can be checked automatically.`,
      }),
    );
  }
  const urls = downgradeInconclusiveSourceWarnings(checkedUrls);
  const blockingUrls = urls.filter((item) => item.blocking);
  const status = blockingUrls.some((item) => item.status === "hard_failure")
    ? "failed"
    : blockingUrls.some((item) => item.status === "retryable")
      ? "retryable"
      : "passed";
  return {
    status,
    urls,
    warnings: urls.filter((item) => !item.blocking && item.status !== "passed"),
    hash: await sha256Hex(sourceEvidenceHashInput(urls)),
  };
}

export function sourceEvidenceSummary(report: SourceEvidenceReport): string {
  if (!report.urls.length) return "No source URLs were declared.";
  return report.urls
    .map((item) => {
      const status = item.httpStatus ? `HTTP ${item.httpStatus}` : item.outcome;
      const suffix = item.blocking ? "" : " (non-blocking source-inconclusive warning)";
      return `${item.field} ${item.url} -> ${status}${suffix}`;
    })
    .join("; ");
}

export function sourceEvidenceToDecisionEvidence(report: SourceEvidenceReport): SourceEvidenceDecisionEvidence[] {
  return report.urls
    .filter((item) => item.blocking && item.status === "hard_failure")
    .map((item) => ({
      ruleId: "source_url_reachability",
      field: item.field,
      url: item.url,
      matchedUrl: item.url,
      ...(item.finalUrl !== undefined ? { finalUrl: item.finalUrl } : {}),
      outcome: item.outcome,
      status: item.status,
      ...(item.httpStatus ? { httpStatus: String(item.httpStatus) } : {}),
      behavior: item.httpStatus
        ? `${item.field} returned HTTP ${item.httpStatus}`
        : `${item.field} is not a valid reachable source URL`,
      fix: "Replace the source URL with a reachable authoritative source and resubmit a new one-file content PR.",
    }));
}

function authoritativeSourceItems(report: SourceEvidenceReport): SourceEvidenceItem[] {
  return report.urls.filter(
    (item) => item.blocking && (item.role === "canonical" || PRIMARY_CANONICAL_SOURCE_FIELDS.has(item.field)),
  );
}

export function shouldHardCloseSourceEvidence(report: SourceEvidenceReport): boolean {
  const authoritative = authoritativeSourceItems(report);
  if (!authoritative.length) return false;
  const hardFailures = authoritative.filter((item) => item.status === "hard_failure");
  if (!hardFailures.length) return false;
  const allAuthoritativeFailed = hardFailures.length === authoritative.length;
  return allAuthoritativeFailed && authoritative.length > 1;
}

function sourceEvidenceManualDecision(
  report: SourceEvidenceReport,
  evidence: SourceEvidenceDecisionEvidence[],
): SourceEvidenceDecision {
  return {
    verdict: "manual",
    reasonCode: "source_hard_failure",
    evidence,
    sourceEvidenceHash: report.hash,
    confidence: 1,
    summary: [
      "Summary:",
      "- Deterministic source evidence found one or more dead or invalid source URLs, but not enough to hard-close automatically.",
      "- A maintainer should decide whether to request a source fix, merge with stronger source evidence, or close if the source issue is real.",
      "",
      "Source Review:",
      ...evidence.map((item) =>
        [
          `- \`${item.field || "source"}\` ${item.url || item.matchedUrl}`,
          item.httpStatus ? `returned HTTP ${item.httpStatus}` : item.outcome,
          item.finalUrl && item.finalUrl !== item.url ? `(final URL: ${item.finalUrl})` : "",
        ]
          .filter(Boolean)
          .join(" "),
      ),
      "",
      "Recommended Action:",
      "- Review the source manually. Request a source update if the submitted entry is otherwise useful.",
    ].join("\n"),
    labels: [SOURCE_EVIDENCE_LABELS.manual],
    close: false,
  };
}

export function sourceEvidenceCloseDecision(report: SourceEvidenceReport): SourceEvidenceDecision | null {
  const evidence = sourceEvidenceToDecisionEvidence(report);
  if (!evidence.length) return null;
  if (!shouldHardCloseSourceEvidence(report)) {
    return sourceEvidenceManualDecision(report, evidence);
  }
  return {
    verdict: "close",
    reasonCode: "source_hard_failure",
    evidence,
    sourceEvidenceHash: report.hash,
    confidence: 1,
    summary: [
      "Summary:",
      "- Deterministic source evidence found one or more dead or invalid source URLs.",
      "- Dead source links block one-shot content submissions because the entry cannot be verified.",
      "",
      "Source Review:",
      ...evidence.map((item) =>
        [
          `- \`${item.field || "source"}\` ${item.url || item.matchedUrl}`,
          item.httpStatus ? `returned HTTP ${item.httpStatus}` : item.outcome,
          item.finalUrl && item.finalUrl !== item.url ? `(final URL: ${item.finalUrl})` : "",
        ]
          .filter(Boolean)
          .join(" "),
      ),
      "",
      "Recommended Action:",
      "- Close this PR and resubmit with reachable, authoritative source URLs.",
    ].join("\n"),
    labels: [SOURCE_EVIDENCE_LABELS.close],
    close: true,
  };
}
