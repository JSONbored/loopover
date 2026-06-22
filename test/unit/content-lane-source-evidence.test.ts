import { describe, expect, it } from "vitest";
import {
  checkSubmittedSourceEvidence,
  extractSubmittedSourceUrls,
  shouldHardCloseSourceEvidence,
  sourceEvidenceCloseDecision,
  sourceEvidenceSummary,
  sourceEvidenceToDecisionEvidence,
} from "../../src/review/content-lane/source-evidence";

const mdx = (frontmatter: Record<string, string>): string => {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\nBody.\n`;
};

/** A fetch stub that maps a URL → an HTTP status (no redirects). */
function fakeFetch(statusByUrl: Record<string, number>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const status = statusByUrl[url] ?? 599;
    return new Response(status >= 200 && status < 300 ? "ok" : "", { status });
  }) as unknown as typeof fetch;
}

describe("extractSubmittedSourceUrls", () => {
  it("reads scalar source fields + retrievalSources/sourceUrls lists, deduped", () => {
    const src = [
      "---",
      "githubUrl: https://github.com/acme/x",
      "sourceUrl: https://github.com/acme/x", // distinct field, same url → both kept (keyed by field+url)
      "retrievalSources:",
      "  - https://docs.acme.example/a",
      "  - https://docs.acme.example/a", // exact dup dropped
      "---",
      "",
      "body",
    ].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    const pairs = urls.map((u) => `${u.field}:${u.url}`);
    expect(pairs).toContain("githubUrl:https://github.com/acme/x");
    expect(pairs).toContain("retrievalSources:https://docs.acme.example/a");
    expect(pairs.filter((p) => p === "retrievalSources:https://docs.acme.example/a")).toHaveLength(1);
  });

  it("drops a site-relative distribution (downloadUrl) artifact path", () => {
    const urls = extractSubmittedSourceUrls(mdx({ downloadUrl: "/downloads/skills/foo.zip" }));
    expect(urls).toHaveLength(0);
  });
});

describe("checkSubmittedSourceEvidence", () => {
  it("passes when the canonical source is reachable", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/x" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/x": 200 }));
    expect(report.status).toBe("passed");
    expect(report.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks a 404 canonical source as a hard failure", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/missing" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/missing": 404 }));
    expect(report.status).toBe("failed");
  });

  it("is retryable (not hard) on a 403/429/5xx canonical source", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/x" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/x": 403 }));
    expect(report.status).toBe("retryable");
  });

  it("produces a stable hash for the same evidence set", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/x" });
    const f = fakeFetch({ "https://github.com/acme/x": 200 });
    const a = await checkSubmittedSourceEvidence(src, f);
    const b = await checkSubmittedSourceEvidence(src, f);
    expect(a.hash).toBe(b.hash);
  });
});

describe("shouldHardCloseSourceEvidence + sourceEvidenceCloseDecision", () => {
  it("hard-closes only when ALL authoritative sources failed AND there is more than one", async () => {
    const src = mdx({
      githubUrl: "https://github.com/acme/dead1",
      repoUrl: "https://github.com/acme/dead2",
    });
    const report = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({ "https://github.com/acme/dead1": 404, "https://github.com/acme/dead2": 404 }),
    );
    expect(shouldHardCloseSourceEvidence(report)).toBe(true);
    const decision = sourceEvidenceCloseDecision(report);
    expect(decision?.verdict).toBe("close");
    expect(decision?.close).toBe(true);
  });

  it("routes to MANUAL (not close) when only a single authoritative source failed", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/dead" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/dead": 404 }));
    expect(shouldHardCloseSourceEvidence(report)).toBe(false);
    const decision = sourceEvidenceCloseDecision(report);
    expect(decision?.verdict).toBe("manual");
    expect(decision?.close).toBe(false);
  });

  it("returns null when there is no failing evidence to act on", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/x" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/x": 200 }));
    expect(sourceEvidenceCloseDecision(report)).toBeNull();
  });
});

// ── HTTP fetch paths (redirects / HEAD-then-GET / status mapping) ─────────────────────────────────

type FetchSpec =
  | { status: number; location?: string } // a returned Response
  | { throwOn: Array<"HEAD" | "GET"> }; // throw for these methods, else 200

/**
 * A method- and redirect-aware fetch stub. `specByUrl[url]` describes how each URL responds.
 * A `location` makes a 3xx Response carry a `location` header (drives the manual-redirect loop).
 * `throwOn` makes the stub throw for the listed methods (network/HEAD-rejection paths).
 */
function specFetch(specByUrl: Record<string, FetchSpec>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = ((init?.method as string) || "GET").toUpperCase() as "HEAD" | "GET";
    const spec = specByUrl[url];
    if (!spec) return new Response("", { status: 599 });
    if ("throwOn" in spec) {
      if (spec.throwOn.includes(method)) throw new TypeError(`network fail on ${method} ${url}`);
      return new Response("ok", { status: 200 });
    }
    const headers = spec.location ? { location: spec.location } : undefined;
    return new Response(spec.status >= 200 && spec.status < 300 ? "ok" : "", { status: spec.status, headers });
  }) as unknown as typeof fetch;
}

describe("checkSubmittedSourceEvidence — redirect handling", () => {
  it("follows a 301→302 redirect chain to a final 404 (hard failure)", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/a" });
    const report = await checkSubmittedSourceEvidence(
      src,
      specFetch({
        "https://github.com/acme/a": { status: 301, location: "https://github.com/acme/b" },
        "https://github.com/acme/b": { status: 302, location: "https://github.com/acme/c" },
        "https://github.com/acme/c": { status: 404 },
      }),
    );
    expect(report.status).toBe("failed");
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("hard_failure");
    expect(item?.httpStatus).toBe(404);
    expect(item?.finalUrl).toBe("https://github.com/acme/c");
  });

  it("treats a redirect WITHOUT a location header as redirect_without_location (retryable)", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/noloc" });
    const report = await checkSubmittedSourceEvidence(
      src,
      specFetch({ "https://github.com/acme/noloc": { status: 301 } }),
    );
    expect(report.status).toBe("retryable");
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.outcome).toBe("redirect_without_location");
    expect(item?.httpStatus).toBe(301);
    expect(item?.finalUrl).toBe("https://github.com/acme/noloc");
  });

  it("bails out with too_many_redirects past MAX_SOURCE_EVIDENCE_REDIRECTS (4)", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/r0" });
    // 5 hops, each redirecting to the next, exceeds the 4-redirect budget.
    const report = await checkSubmittedSourceEvidence(
      src,
      specFetch({
        "https://github.com/acme/r0": { status: 301, location: "https://github.com/acme/r1" },
        "https://github.com/acme/r1": { status: 301, location: "https://github.com/acme/r2" },
        "https://github.com/acme/r2": { status: 301, location: "https://github.com/acme/r3" },
        "https://github.com/acme/r3": { status: 301, location: "https://github.com/acme/r4" },
        "https://github.com/acme/r4": { status: 301, location: "https://github.com/acme/r5" },
        "https://github.com/acme/r5": { status: 200 },
      }),
    );
    expect(report.status).toBe("retryable");
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.outcome).toBe("too_many_redirects");
    expect(item?.httpStatus).toBe(301);
  });
});

describe("checkSubmittedSourceEvidence — HEAD-then-GET fallback + retry", () => {
  it("falls back to GET when HEAD throws, then passes on the GET", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/headfail" });
    const report = await checkSubmittedSourceEvidence(
      src,
      specFetch({ "https://github.com/acme/headfail": { throwOn: ["HEAD"] } }),
    );
    expect(report.status).toBe("passed");
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("passed");
    expect(item?.outcome).toBe("reachable");
  });

  it("returns fetch_error (retryable) when BOTH GET attempts throw", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/down" });
    const report = await checkSubmittedSourceEvidence(
      src,
      specFetch({ "https://github.com/acme/down": { throwOn: ["HEAD", "GET"] } }),
    );
    expect(report.status).toBe("retryable");
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("retryable");
    expect(item?.outcome).toBe("fetch_error");
    expect(item?.error).toMatch(/network fail on GET/);
  });
});

describe("sourceStatusFromHttpStatus mapping (via the gate)", () => {
  it("maps 401/403/429/500 to retryable", async () => {
    for (const status of [401, 403, 429, 500]) {
      const src = mdx({ githubUrl: "https://github.com/acme/s" });
      const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/s": status }));
      expect(report.status, `status ${status}`).toBe("retryable");
      const item = report.urls.find((u) => u.field === "githubUrl");
      expect(item?.status, `status ${status}`).toBe("retryable");
      expect(item?.outcome, `status ${status}`).toBe("source_inconclusive");
    }
  });

  it("maps 404/410 and a generic 4xx (400) to hard_failure", async () => {
    for (const status of [404, 410, 400]) {
      const src = mdx({ githubUrl: "https://github.com/acme/h" });
      const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/h": status }));
      const item = report.urls.find((u) => u.field === "githubUrl");
      expect(item?.status, `status ${status}`).toBe("hard_failure");
      expect(item?.outcome, `status ${status}`).toBe("http_hard_failure");
    }
  });
});

describe("checkSubmittedSourceEvidence — invalid / non-fetchable source URLs", () => {
  it("classifies an unparseable URL as an invalid_url hard failure", async () => {
    // Not dropped by extract (githubUrl is not a distribution field), so it reaches checkOneSourceUrl.
    const src = mdx({ githubUrl: "ht!tp://not a url" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({}));
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("hard_failure");
    expect(item?.outcome).toBe("invalid_url");
  });

  it("treats a non-https (http) URL as a non-blocking 'passed' (source_host_not_checked)", async () => {
    // validateFetchableSourceUrl: http passes the protocol check but fails isSafeHttpUrl (needs https),
    // so the outcome is source_host_not_checked → checkOneSourceUrl maps non-invalid to status 'passed'.
    const src = mdx({ githubUrl: "http://github.com/acme/x" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({}));
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("passed");
    expect(item?.outcome).toBe("source_host_not_checked");
    expect(report.status).toBe("passed");
  });

  it("treats an https loopback host as source_host_not_checked (SSRF guard), status passed", async () => {
    const src = mdx({ githubUrl: "https://127.0.0.1/repo" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({}));
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("passed");
    expect(item?.outcome).toBe("source_host_not_checked");
  });
});

describe("extractSubmittedSourceUrls — frontmatter parsing edge cases", () => {
  it("reads a block-scalar (| literal) source field as a single URL", () => {
    const src = ["---", "documentationUrl: |", "  https://docs.acme.example/guide", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain(
      "documentationUrl:https://docs.acme.example/guide",
    );
  });

  it("reads a folded block scalar (> folded) joining lines with a space", () => {
    const src = ["---", "documentationUrl: >", "  https://docs.acme.example/guide", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    // The folded form joins block lines with a space; a single line stays intact.
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain(
      "documentationUrl:https://docs.acme.example/guide",
    );
  });

  it("reads an INLINE bracketed list on a retrievalSources key line", () => {
    const src = [
      "---",
      "retrievalSources: [https://a.example/1, https://b.example/2]",
      "---",
      "",
      "body",
    ].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    const pairs = urls.map((u) => `${u.field}:${u.url}`);
    expect(pairs).toContain("retrievalSources:https://a.example/1");
    expect(pairs).toContain("retrievalSources:https://b.example/2");
  });

  it("unquotes a double-quoted inline-list value", () => {
    // Exercises unquoteYamlValue's quote-stripping branch via a quoted bracketed-list element.
    const src = ['---', 'retrievalSources: ["https://q.example/1"]', "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain("retrievalSources:https://q.example/1");
  });

  it("unquotes a single-quoted scalar frontmatter value", () => {
    // Exercises unquoteYamlScalar's quote-stripping branch.
    const src = ["---", "githubUrl: 'https://github.com/acme/quoted'", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain("githubUrl:https://github.com/acme/quoted");
  });

  it("returns no URLs when there is no frontmatter block at all", () => {
    // Exercises parseSimpleFrontmatter's no-match early return.
    expect(extractSubmittedSourceUrls("Just body text, no frontmatter.\n")).toEqual([]);
  });

  it("ignores a non-list line under an active list field (the dash-only matcher)", () => {
    // retrievalSources opens a block, then a stray non-`- ` line is skipped (listSourceUrlValues 231),
    // while the real `- ` items are still read.
    const src = [
      "---",
      "retrievalSources:",
      "  notADashItem: ignored",
      "  - https://kept.example/1",
      "---",
      "",
      "body",
    ].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    const pairs = urls.map((u) => `${u.field}:${u.url}`);
    expect(pairs).toContain("retrievalSources:https://kept.example/1");
    expect(pairs.some((p) => p.includes("notADashItem"))).toBe(false);
  });
});

describe("sourceRole classification (via the report)", () => {
  it("classifies a distribution FIELD (packageUrl) as a distribution source", async () => {
    const src = mdx({ packageUrl: "https://example.com/pkg/foo" });
    const report = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({ "https://example.com/pkg/foo": 200 }),
    );
    const item = report.urls.find((u) => u.field === "packageUrl");
    expect(item?.role).toBe("distribution");
  });

  it("classifies a canonical FIELD on a distribution HOST (pypi.org) as distribution", async () => {
    const src = mdx({ sourceUrl: "https://pypi.org/project/foo" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://pypi.org/project/foo": 200 }));
    const item = report.urls.find((u) => u.field === "sourceUrl");
    expect(item?.role).toBe("distribution");
  });
});

describe("checkSubmittedSourceEvidence — more HTTP edge cases", () => {
  it("treats a redirect with an UNPARSEABLE location header as redirect_without_location", async () => {
    // redirectLocation: `new URL("http://", base)` throws (scheme with no host) → "" → no next URL.
    const src = mdx({ githubUrl: "https://github.com/acme/badloc" });
    const report = await checkSubmittedSourceEvidence(
      src,
      specFetch({ "https://github.com/acme/badloc": { status: 302, location: "http://" } }),
    );
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.outcome).toBe("redirect_without_location");
    expect(item?.httpStatus).toBe(302);
  });

  it("hard-fails when a redirect points at a non-https (invalid) host mid-chain", async () => {
    // The redirect target fails validateFetchableSourceUrl inside the loop (invalid_url) → hard_failure.
    const src = mdx({ githubUrl: "https://github.com/acme/start" });
    const report = await checkSubmittedSourceEvidence(
      src,
      specFetch({
        "https://github.com/acme/start": { status: 301, location: "ftp://example.com/x" },
        "ftp://example.com/x": { status: 200 },
      }),
    );
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("hard_failure");
    expect(item?.outcome).toBe("invalid_url");
  });

  it("marks source URLs beyond the 10-URL cap as too_many_source_urls hard failures", async () => {
    // 12 distinct retrievalSources entries: the first 10 are fetched, the rest are capped.
    const list = Array.from({ length: 12 }, (_, i) => `  - https://capped.example/${i}`);
    const src = ["---", "retrievalSources:", ...list, "---", "", "body"].join("\n");
    const status: Record<string, number> = {};
    for (let i = 0; i < 12; i += 1) status[`https://capped.example/${i}`] = 200;
    const report = await checkSubmittedSourceEvidence(src, fakeFetch(status));
    const capped = report.urls.filter((u) => u.outcome === "too_many_source_urls");
    expect(capped).toHaveLength(2);
    expect(capped[0]?.status).toBe("hard_failure");
  });
});

describe("shouldHardCloseSourceEvidence — non-failing / non-authoritative reports", () => {
  it("returns false when there are NO authoritative sources (distribution-only)", async () => {
    const src = mdx({ packageUrl: "https://example.com/pkg/foo" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://example.com/pkg/foo": 404 }));
    // packageUrl is a distribution role, not authoritative → no authoritative items.
    expect(shouldHardCloseSourceEvidence(report)).toBe(false);
  });

  it("returns false when authoritative sources exist but none hard-failed", async () => {
    const src = mdx({
      githubUrl: "https://github.com/acme/ok1",
      repoUrl: "https://github.com/acme/ok2",
    });
    const report = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({ "https://github.com/acme/ok1": 200, "https://github.com/acme/ok2": 200 }),
    );
    expect(shouldHardCloseSourceEvidence(report)).toBe(false);
  });
});

describe("sourceEvidenceSummary", () => {
  it("returns the empty-report sentinel when no URLs were declared", () => {
    const report = { status: "passed" as const, hash: "x", urls: [], warnings: [] };
    expect(sourceEvidenceSummary(report)).toBe("No source URLs were declared.");
  });

  it("renders HTTP statuses and flags non-blocking source-inconclusive warnings", async () => {
    // A reachable primary canonical (githubUrl) lets a flaky non-primary (docsUrl) downgrade to a warning.
    const src = mdx({
      githubUrl: "https://github.com/acme/live",
      docsUrl: "https://docs.acme.example/flaky",
    });
    const report = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({ "https://github.com/acme/live": 200, "https://docs.acme.example/flaky": 503 }),
    );
    const summary = sourceEvidenceSummary(report);
    expect(summary).toContain("githubUrl https://github.com/acme/live -> HTTP 200");
    expect(summary).toContain("HTTP 503");
    expect(summary).toContain("(non-blocking source-inconclusive warning)");
    // The flaky non-primary became a non-blocking warning, so the report itself passes.
    expect(report.warnings.some((w) => w.field === "docsUrl")).toBe(true);
  });
});

describe("sourceEvidenceToDecisionEvidence", () => {
  it("emits one decision-evidence row per blocking hard-failure with httpStatus + finalUrl", async () => {
    const src = mdx({
      githubUrl: "https://github.com/acme/dead1",
      repoUrl: "https://github.com/acme/dead2",
    });
    const report = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({ "https://github.com/acme/dead1": 404, "https://github.com/acme/dead2": 404 }),
    );
    const evidence = sourceEvidenceToDecisionEvidence(report);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.ruleId).toBe("source_url_reachability");
    expect(evidence[0]?.httpStatus).toBe("404");
    expect(evidence[0]?.behavior).toMatch(/returned HTTP 404/);
    expect(evidence[0]?.fix).toMatch(/reachable authoritative source/);
  });
});
