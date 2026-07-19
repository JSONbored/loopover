import { describe, expect, it } from "vitest";
import { AWESOME_CLAUDE_CONTENT_SPEC, type ContentRepoSpec } from "../../src/review/content-lane/content-repo-spec";
import {
  checkSubmittedSourceEvidence,
  extractSubmittedSourceUrls,
  shouldHardCloseSourceEvidence,
  sourceEvidenceCloseDecision,
  sourceEvidenceSummary,
  sourceEvidenceToDecisionEvidence,
  type SourceEvidenceItem,
  type SourceEvidenceReport,
} from "../../src/review/content-lane/source-evidence";

const customSpec = (over: Partial<ContentRepoSpec>): ContentRepoSpec => ({ ...AWESOME_CLAUDE_CONTENT_SPEC, ...over });

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

  it("reads snake_case source fields (e.g. the canonical source_url), matching urlFields (#7250)", () => {
    // Before #7250, sourceUrlFields listed only the camelCase names, so a legitimately-aliased snake_case field
    // was invisible to the source-evidence gate even though duplicates.ts (which reads urlFields) saw it.
    const pairs = extractSubmittedSourceUrls(mdx({ source_url: "https://github.com/acme/y" })).map((u) => `${u.field}:${u.url}`);
    expect(pairs).toContain("source_url:https://github.com/acme/y");
    // Every snake_case alias urlFields carries is now recognized here too.
    for (const field of ["docs_url", "download_url", "github_url", "package_url", "repo_url", "repository_url", "source_url", "website_url"]) {
      expect(AWESOME_CLAUDE_CONTENT_SPEC.sourceUrlFields).toContain(field);
      expect(AWESOME_CLAUDE_CONTENT_SPEC.urlFields.has(field)).toBe(true);
    }
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
    return new Response(spec.status >= 200 && spec.status < 300 ? "ok" : "", { status: spec.status, ...(headers ? { headers } : {}) });
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

  it("does not surface any block-scalar header on a list field as a bogus URL (both indicator orders)", () => {
    // `retrievalSources` is a list field; a block-scalar header is not a URL. The old guard only skipped the bare
    // `|`/`>`, so `|-` leaked as the literal url "|-". YAML allows chomping and the indentation digit in EITHER
    // order, so `|2-`/`>2+` (indent-then-chomp) and bare chomping `|+`/`|-` must all be skipped too.
    const indicators = ["|", ">", "|-", ">-", "|+", ">+", "|2", ">2", "|-2", "|2-", ">2+", ">2-"];
    for (const indicator of indicators) {
      const src = ["---", `retrievalSources: ${indicator}`, "  https://a.example/1", "  https://b.example/2", "---", "", "body"].join("\n");
      const urls = extractSubmittedSourceUrls(src);
      expect(urls.some((u) => u.url === indicator)).toBe(false);
    }
    // A block-scalar header may carry a trailing inline comment (`|- # sources below`) — still a header, not a URL.
    for (const indicator of ["|-", ">", "|2-"]) {
      const src = ["---", `retrievalSources: ${indicator} # sources below`, "  https://a.example/1", "---", "", "body"].join("\n");
      const urls = extractSubmittedSourceUrls(src);
      expect(urls.some((u) => u.url === indicator || u.url.includes("#"))).toBe(false);
    }
    // A real URL carrying a trailing inline comment is still read (the comment is stripped, the fragment kept).
    const commented = extractSubmittedSourceUrls(["---", "retrievalSources: https://a.example/p#frag # note", "---", "", "body"].join("\n"));
    expect(commented.map((u) => u.url)).toContain("https://a.example/p#frag");
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

  it("emits a no-httpStatus row (invalid_url) WITHOUT finalUrl and with the not-reachable behavior", async () => {
    // An invalid_url hard failure is blocking with no httpStatus and no finalUrl:
    // exercises BOTH the `finalUrl !== undefined` false branch (no spread) and the
    // `httpStatus ? ... : behavior` false branch (line 542 "is not a valid reachable source URL").
    const src = mdx({ githubUrl: "ht!tp://broken url" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({}));
    const evidence = sourceEvidenceToDecisionEvidence(report);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.httpStatus).toBeUndefined();
    expect(evidence[0]?.finalUrl).toBeUndefined();
    expect(evidence[0]?.outcome).toBe("invalid_url");
    expect(evidence[0]?.behavior).toBe("githubUrl is not a valid reachable source URL");
  });

  it("returns an empty array when no blocking hard-failures exist", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/ok" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/ok": 200 }));
    expect(sourceEvidenceToDecisionEvidence(report)).toEqual([]);
  });
});

// ── Frontmatter scalar / YAML-edge branches (stripYamlComment / unquote* / parser) ───────────────

describe("frontmatter scalar parsing branches", () => {
  it("strips a trailing ' # comment' from an UNQUOTED scalar value (unquoteYamlScalar comment branch)", () => {
    // unquoteYamlScalar: not quoted → hits the `.replace(/\s+#.*$/, "")` comment-stripping branch.
    const src = ["---", "githubUrl: https://github.com/acme/x # the canonical repo", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain("githubUrl:https://github.com/acme/x");
  });

  it("keeps a bare unquoted inline-list element verbatim (unquoteYamlValue non-quoted return)", () => {
    // A bracketed list with a bare (unquoted) element exercises unquoteYamlValue's
    // final `return trimmed.trim()` branch (neither double- nor single-quoted).
    const src = ["---", "retrievalSources: [https://bare.example/1]", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain("retrievalSources:https://bare.example/1");
  });

  it("unquotes a SINGLE-quoted inline-list element (unquoteYamlValue single-quote branch)", () => {
    const src = ["---", "retrievalSources: ['https://sq.example/1']", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain("retrievalSources:https://sq.example/1");
  });

  it("strips a ' # comment' off a bracketed inline-list element (unquoteYamlValue→stripYamlComment)", () => {
    // unquoteYamlValue calls stripYamlComment first; a comment after a bare element is removed.
    const src = ["---", "retrievalSources: [https://c.example/1 # note]", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain("retrievalSources:https://c.example/1");
  });

  it("skips a frontmatter key whose inline value is empty and is not a block scalar", () => {
    // parseSimpleFrontmatter: `inline === ""` and not a `|`/`>` block → field is never set (else-if false).
    const src = ["---", "githubUrl:", "docsUrl: https://docs.example/x", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    const pairs = urls.map((u) => `${u.field}:${u.url}`);
    expect(pairs).toContain("docsUrl:https://docs.example/x");
    expect(pairs.some((p) => p.startsWith("githubUrl:"))).toBe(false);
  });

  it("ignores a non key:value frontmatter line (parseSimpleFrontmatter head no-match continue)", () => {
    // A stray line with no `key:` shape is skipped; the real scalar field is still read.
    const src = ["---", "this line has no colon key shape", "githubUrl: https://github.com/acme/x", "---", "", "body"].join(
      "\n",
    );
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain("githubUrl:https://github.com/acme/x");
  });

  it("reads a multi-line | literal block scalar joined by newlines (only the first line is the URL)", () => {
    // The `|` literal join uses "\n"; scalarSourceUrlValues then takes the whole (multi-line) value as one
    // entry. We assert the field is parsed as a block (non-empty) and the first line is present.
    const src = ["---", "documentationUrl: |", "  https://docs.example/a", "  trailing-note", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.some((u) => u.field === "documentationUrl" && u.url.startsWith("https://docs.example/a"))).toBe(true);
  });
});

// ── listSourceUrlValues branches (active-field reset, inline |/> guard, empty dash) ──────────────

describe("listSourceUrlValues branches", () => {
  it("resets the active list field when a non-list top-level key appears (dash items after it are ignored)", () => {
    // retrievalSources opens a list; then a non-list top-level key (title:) resets activeField to "",
    // so a following `- ` item is NOT captured (the `if (!activeField) continue` guard).
    const src = [
      "---",
      "retrievalSources:",
      "  - https://kept.example/1",
      "title: Something",
      "  - https://dropped.example/2",
      "---",
      "",
      "body",
    ].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    const pairs = urls.map((u) => `${u.field}:${u.url}`);
    expect(pairs).toContain("retrievalSources:https://kept.example/1");
    expect(pairs.some((p) => p.includes("dropped.example"))).toBe(false);
  });

  it("does NOT scalar-parse a list field declared as a block scalar header (value === '|')", () => {
    // listSourceUrlValues guards `value !== "|" && value !== ">"`; with `retrievalSources: |` the inline
    // value is skipped, and the indented block lines are read as dash-less → no URLs from the header line.
    const src = ["---", "retrievalSources: |", "  https://block.example/1", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    // The `|` header is not treated as an inline URL; the indented non-dash line is not a `- ` item.
    expect(urls.some((u) => u.field === "retrievalSources")).toBe(false);
  });

  it("drops an EMPTY dash item under an active list field (the `if (url)` guard)", () => {
    const src = ["---", "retrievalSources:", "  - ", "  - https://real.example/1", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    const pairs = urls.map((u) => `${u.field}:${u.url}`);
    expect(pairs).toContain("retrievalSources:https://real.example/1");
    expect(pairs).toHaveLength(1);
  });

  it("reads an inline scalar URL declared directly on a list key line (sourceUrls: <url>)", () => {
    // A list field with a plain inline value (not |/> and not bracketed) → scalarSourceUrlValues single path.
    const src = ["---", "sourceUrls: https://inline.example/1", "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain("sourceUrls:https://inline.example/1");
  });
});

// ── extractSubmittedSourceUrls: absolute distribution kept; empty value path ─────────────────────

describe("extractSubmittedSourceUrls — distribution + empty branches", () => {
  it("KEEPS an absolute distribution (packageUrl) URL (isAbsoluteHttpUrl true branch)", () => {
    const urls = extractSubmittedSourceUrls(mdx({ packageUrl: "https://npmjs.com/package/foo" }));
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain("packageUrl:https://npmjs.com/package/foo");
  });

  it("drops a distribution field whose value is an UNPARSEABLE (non-absolute) URL (isAbsoluteHttpUrl catch)", () => {
    // `:::not a url:::` throws in `new URL(...)` inside isAbsoluteHttpUrl → false → distribution drop.
    const urls = extractSubmittedSourceUrls(mdx({ downloadUrl: ":::not a url:::" }));
    expect(urls.some((u) => u.field === "downloadUrl")).toBe(false);
  });

  it("drops a distribution field with a non-http (mailto:) absolute value (isAbsoluteHttpUrl protocol false)", () => {
    // mailto: parses as a URL but its protocol is not http/https → isAbsoluteHttpUrl false → dropped.
    const urls = extractSubmittedSourceUrls(mdx({ downloadUrl: "mailto:foo@example.com" }));
    expect(urls.some((u) => u.field === "downloadUrl")).toBe(false);
  });

  it("returns [] for an empty scalar source field (scalarSourceUrlValues empty-trimmed branch)", () => {
    // githubUrl present but empty → scalarSourceUrlValues("") returns [].
    const src = ["---", "githubUrl: ''", "---", "", "body"].join("\n");
    expect(extractSubmittedSourceUrls(src)).toEqual([]);
  });
});

// ── sourceRole malformed-URL catch ───────────────────────────────────────────────────────────────

describe("sourceRole malformed-URL classification", () => {
  it("classifies a malformed canonical-field URL as canonical (sourceRole catch → canonical)", async () => {
    // sourceRole: `new URL("ht!tp://x")` throws → catch → falls through to "canonical".
    const src = mdx({ githubUrl: "ht!tp://x" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({}));
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.role).toBe("canonical");
  });
});

// ── sourceStatusFromHttpStatus: 425 / >=500 / sub-200 fall-through ───────────────────────────────

/** A fetch returning a DUCK-TYPED response so we can use statuses the Response ctor rejects (e.g. 1xx). */
function rawStatusFetch(status: number): typeof fetch {
  return (async () => ({
    status,
    headers: { get: () => null },
  })) as unknown as typeof fetch;
}

describe("sourceStatusFromHttpStatus — remaining bands", () => {
  it("maps 425 (Too Early) to retryable (explicit list member)", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/early" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/early": 425 }));
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("retryable");
    expect(item?.outcome).toBe("source_inconclusive");
  });

  it("maps a 5xx (503) to retryable via the `status >= 500` branch", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/5xx" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/5xx": 503 }));
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("retryable");
  });

  it("maps an out-of-band 2xx-3xx boundary 1xx (199) to retryable via the final fall-through return", async () => {
    // 199 is not >=200, not in the retryable list, not 404/410, not 400-499, not >=500 → final `return "retryable"`.
    // A real Response rejects 199, so we inject a duck-typed response.
    const src = mdx({ githubUrl: "https://github.com/acme/onexx" });
    const report = await checkSubmittedSourceEvidence(src, rawStatusFetch(199));
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("retryable");
    expect(item?.outcome).toBe("source_inconclusive");
  });
});

// ── checkOneSourceUrl: HEAD-pass early return + non-blocking invalid (source_host_not_checked) ───

describe("checkOneSourceUrl branches", () => {
  it("returns immediately from a passing HEAD (no GET) — HEAD `passed` early return", async () => {
    // HEAD returns 200 → checkOneSourceUrl returns head without ever issuing a GET.
    let getCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = ((init?.method as string) || "GET").toUpperCase();
      if (method === "GET") getCalls += 1;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const src = mdx({ githubUrl: "https://github.com/acme/headok" });
    const report = await checkSubmittedSourceEvidence(src, fetchImpl);
    expect(report.status).toBe("passed");
    expect(getCalls).toBe(0);
  });

  it("non-invalid validation failure → status 'passed' (invalidProtocol false branch)", async () => {
    // source_host_not_checked (https loopback) is a non-invalid validation failure: invalidProtocol=false
    // → status 'passed'. Distinct from invalid_url (which is hard_failure).
    const src = mdx({ githubUrl: "https://127.0.0.1/repo" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({}));
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("passed");
    expect(item?.outcome).toBe("source_host_not_checked");
  });

  it("surfaces a non-Error throw as the fallback fetch_error message (lastError not instanceof Error)", async () => {
    // Both GET attempts throw a NON-Error value → `lastError instanceof Error` is false → fallback string.
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = ((init?.method as string) || "GET").toUpperCase();
      if (method === "GET") throw "string failure"; // non-Error throw
      throw "head failure"; // HEAD also throws → falls through to GET
    }) as unknown as typeof fetch;
    const src = mdx({ githubUrl: "https://github.com/acme/weird" });
    const report = await checkSubmittedSourceEvidence(src, fetchImpl);
    const item = report.urls.find((u) => u.field === "githubUrl");
    expect(item?.status).toBe("retryable");
    expect(item?.outcome).toBe("fetch_error");
    expect(item?.error).toBe("Source URL fetch failed before a response was returned.");
  });
});

// ── hasVerifiableCanonicalSource: >=2 reachable vs primary-field downgrade trigger ───────────────

describe("downgrade rules (hasVerifiableCanonicalSource / isDowngradableInconclusiveSource)", () => {
  it("does NOT downgrade when there is no verifiable canonical source (early return, warnings stay blocking)", async () => {
    // A lone flaky non-primary canonical (docsUrl 503) with NO reachable canonical anchor stays blocking.
    const src = mdx({ docsUrl: "https://docs.example/flaky" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://docs.example/flaky": 503 }));
    const item = report.urls.find((u) => u.field === "docsUrl");
    expect(item?.blocking).toBe(true);
    expect(report.status).toBe("retryable");
  });

  it("downgrades via the >=2-reachable-canonical anchor (two non-primary canonicals both reachable)", async () => {
    // websiteUrl + docsUrl are canonical but NOT primary; two reachable → hasVerifiableCanonicalSource true
    // via `reachableCanonical.length >= 2`. A third flaky non-primary (documentationUrl) downgrades.
    const src = mdx({
      websiteUrl: "https://site.example/a",
      docsUrl: "https://docs.example/b",
      documentationUrl: "https://docs.example/flaky",
    });
    const report = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({
        "https://site.example/a": 200,
        "https://docs.example/b": 200,
        "https://docs.example/flaky": 403,
      }),
    );
    const flaky = report.urls.find((u) => u.field === "documentationUrl");
    expect(flaky?.blocking).toBe(false);
    expect(report.warnings.some((w) => w.field === "documentationUrl")).toBe(true);
  });

  it("downgrades a distribution source_host_not_checked hard_failure to non-blocking when a canonical verifies", async () => {
    // isDowngradableInconclusiveSource second branch: hard_failure + distribution role + source_host_not_checked.
    // A distribution field (packageUrl) whose URL is valid but REDIRECTS to a loopback host fails
    // validateFetchableSourceUrl INSIDE the fetch loop → hard_failure with outcome source_host_not_checked.
    // A reachable primary canonical (githubUrl) makes hasVerifiableCanonicalSource true → it downgrades.
    const src = mdx({
      githubUrl: "https://github.com/acme/live",
      packageUrl: "https://dist.example/pkg",
    });
    const report = await checkSubmittedSourceEvidence(
      src,
      specFetch({
        "https://github.com/acme/live": { status: 200 },
        "https://dist.example/pkg": { status: 301, location: "https://127.0.0.1/internal" },
      }),
    );
    const pkg = report.urls.find((u) => u.field === "packageUrl");
    expect(pkg?.role).toBe("distribution");
    expect(pkg?.status).toBe("hard_failure");
    expect(pkg?.outcome).toBe("source_host_not_checked");
    expect(pkg?.blocking).toBe(false);
    expect(report.status).toBe("passed");
  });

  it("does NOT downgrade a PRIMARY-field retryable even when a canonical anchor verifies", async () => {
    // isDowngradableInconclusiveSource: retryable BUT field is primary (sourceUrl) → not downgradable.
    // githubUrl reachable (primary anchor) → hasVerifiableCanonicalSource true, but the flaky sourceUrl stays blocking.
    const src = mdx({
      githubUrl: "https://github.com/acme/anchor",
      sourceUrl: "https://flaky.example/primary",
    });
    const report = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({ "https://github.com/acme/anchor": 200, "https://flaky.example/primary": 503 }),
    );
    const primary = report.urls.find((u) => u.field === "sourceUrl");
    expect(primary?.blocking).toBe(true);
    expect(report.status).toBe("retryable");
  });
});

// ── summary / decision string branches ───────────────────────────────────────────────────────────

describe("sourceEvidenceSummary — outcome (no httpStatus) branch", () => {
  it("renders the OUTCOME (not 'HTTP n') when an item has no httpStatus", async () => {
    // invalid_url has no httpStatus → summary shows the outcome string, and item is blocking (no suffix).
    const src = mdx({ githubUrl: "ht!tp://broken" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({}));
    const summary = sourceEvidenceSummary(report);
    expect(summary).toContain("githubUrl ht!tp://broken -> invalid_url");
    expect(summary).not.toContain("(non-blocking source-inconclusive warning)");
  });
});

describe("sourceEvidenceCloseDecision — summary string branches", () => {
  it("CLOSE summary includes the final-URL annotation when finalUrl differs from url", async () => {
    // Two authoritative sources both hard-fail via a redirect to a 404 → close; the finalUrl differs from url,
    // exercising the `item.finalUrl && item.finalUrl !== item.url` true branch + the `httpStatus ?` true branch.
    const src = mdx({
      githubUrl: "https://github.com/acme/g1",
      repoUrl: "https://github.com/acme/g2",
    });
    const report = await checkSubmittedSourceEvidence(
      src,
      specFetch({
        "https://github.com/acme/g1": { status: 301, location: "https://github.com/acme/g1-moved" },
        "https://github.com/acme/g1-moved": { status: 404 },
        "https://github.com/acme/g2": { status: 301, location: "https://github.com/acme/g2-moved" },
        "https://github.com/acme/g2-moved": { status: 404 },
      }),
    );
    const decision = sourceEvidenceCloseDecision(report);
    expect(decision?.verdict).toBe("close");
    expect(decision?.summary).toContain("returned HTTP 404");
    expect(decision?.summary).toContain("(final URL: https://github.com/acme/g1-moved)");
    expect(decision?.summary).toContain("Close this PR and resubmit");
  });

  it("MANUAL summary uses the outcome (no httpStatus) and omits final-URL when it equals url", async () => {
    // A single invalid_url authoritative failure → manual (not close). No httpStatus → outcome branch;
    // finalUrl undefined → the `finalUrl && finalUrl !== url` false branch (no annotation).
    const src = mdx({ githubUrl: "ht!tp://broken url" });
    const report = await checkSubmittedSourceEvidence(src, fakeFetch({}));
    const decision = sourceEvidenceCloseDecision(report);
    expect(decision?.verdict).toBe("manual");
    expect(decision?.summary).toContain("invalid_url");
    expect(decision?.summary).not.toContain("final URL:");
    expect(decision?.summary).toContain("Review the source manually");
  });
});

// ── shouldHardCloseSourceEvidence — mixed authoritative (one passes) ──────────────────────────────

describe("shouldHardCloseSourceEvidence — partial authoritative failure", () => {
  it("returns false when SOME (not all) authoritative sources hard-failed", async () => {
    // One authoritative passes, one hard-fails → hardFailures.length !== authoritative.length → false.
    const src = mdx({
      githubUrl: "https://github.com/acme/ok",
      repoUrl: "https://github.com/acme/dead",
    });
    const report = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({ "https://github.com/acme/ok": 200, "https://github.com/acme/dead": 404 }),
    );
    expect(shouldHardCloseSourceEvidence(report)).toBe(false);
    // And it routes to MANUAL (single blocking hard-failure present).
    expect(sourceEvidenceCloseDecision(report)?.verdict).toBe("manual");
  });
});

// ── Remaining partial-branch coverage ─────────────────────────────────────────────────────────────

describe("frontmatter parsing — remaining quote / empty-source branches", () => {
  it("unquotes a DOUBLE-quoted scalar frontmatter value (unquoteYamlScalar startsWith('\"') true → endsWith('\"'))", () => {
    // The other scalar test uses single quotes; this exercises the double-quote arm of unquoteYamlScalar
    // (`trimmed.startsWith('"') && trimmed.endsWith('"')`).
    const src = ['---', 'githubUrl: "https://github.com/acme/dq"', "---", "", "body"].join("\n");
    const urls = extractSubmittedSourceUrls(src);
    expect(urls.map((u) => `${u.field}:${u.url}`)).toContain("githubUrl:https://github.com/acme/dq");
  });

  it("returns [] for an EMPTY source string (String(source || '') fallback in both parsers)", () => {
    // An empty string is falsy → both parseSimpleFrontmatter and frontmatterBlock hit the `|| ""` fallback.
    expect(extractSubmittedSourceUrls("")).toEqual([]);
  });
});

describe("decision string rendering — empty field/url + manual finalUrl + close outcome branches", () => {
  // Hand-built reports let us drive the rendering fallbacks (`item.field || "source"`,
  // `item.url || item.matchedUrl`) that real frontmatter never leaves empty.
  const blockingHardFailure = (over: Partial<SourceEvidenceItem>): SourceEvidenceItem => ({
    field: "",
    url: "",
    status: "hard_failure",
    role: "canonical",
    blocking: true,
    outcome: "invalid_url",
    ...over,
  });
  const reportOf = (urls: SourceEvidenceItem[]): SourceEvidenceReport => ({
    status: "failed",
    hash: "deadbeef",
    urls,
    warnings: [],
  });

  it("MANUAL summary falls back to `source` / matchedUrl when field+url are empty (|| fallbacks)", () => {
    // Single blocking authoritative hard-failure → manual. Empty field/url exercise the
    // `item.field || "source"` and `item.url || item.matchedUrl` true-of-arm[1] fallbacks (L585).
    const report = reportOf([blockingHardFailure({ field: "", url: "" })]);
    expect(shouldHardCloseSourceEvidence(report)).toBe(false);
    const decision = sourceEvidenceCloseDecision(report);
    expect(decision?.verdict).toBe("manual");
    // toDecisionEvidence sets matchedUrl = item.url (also ""), so the fallback renders an empty matchedUrl;
    // the `source` label fallback for the empty field is what we assert.
    expect(decision?.summary).toContain("`source`");
  });

  it("MANUAL summary renders the final-URL annotation when finalUrl differs from url (L587 true arm)", () => {
    // A single authoritative hard-failure with a differing finalUrl → manual decision whose Source Review
    // line includes `(final URL: ...)` — the `item.finalUrl && item.finalUrl !== item.url ? ... : ""` true arm.
    const report = reportOf([
      blockingHardFailure({
        field: "githubUrl",
        url: "https://github.com/acme/moved-from",
        finalUrl: "https://github.com/acme/moved-to",
        httpStatus: 404,
        outcome: "http_hard_failure",
      }),
    ]);
    expect(shouldHardCloseSourceEvidence(report)).toBe(false);
    const decision = sourceEvidenceCloseDecision(report);
    expect(decision?.verdict).toBe("manual");
    expect(decision?.summary).toContain("(final URL: https://github.com/acme/moved-to)");
    expect(decision?.summary).toContain("returned HTTP 404");
  });

  it("CLOSE summary uses the OUTCOME (no httpStatus) and `source` fallback for two empty-field invalid_url authoritatives", () => {
    // Two blocking authoritative invalid_url hard-failures (no httpStatus) → hard-close. Renders the
    // `httpStatus ? ... : item.outcome` arm[1] (L622) and the `item.field || "source"` fallback (L621).
    const report = reportOf([
      blockingHardFailure({ field: "", url: "", outcome: "invalid_url" }),
      blockingHardFailure({ field: "", url: "", outcome: "invalid_url" }),
    ]);
    expect(shouldHardCloseSourceEvidence(report)).toBe(true);
    const decision = sourceEvidenceCloseDecision(report);
    expect(decision?.verdict).toBe("close");
    expect(decision?.close).toBe(true);
    // No httpStatus → outcome string is rendered, not "HTTP n".
    expect(decision?.summary).toContain("invalid_url");
    expect(decision?.summary).not.toContain("returned HTTP");
    // Empty field → `source` label fallback.
    expect(decision?.summary).toContain("`source`");
  });
});

describe("per-repo ContentRepoSpec override (a self-hosted curated list re-parameterizes source evidence)", () => {
  it("extractSubmittedSourceUrls reads scalar URLs from the custom source-field set", () => {
    const src = mdx({ myLink: "https://example.com/a", githubUrl: "https://github.com/o/r" });
    // Default: githubUrl is a source field, myLink is not.
    expect(extractSubmittedSourceUrls(src).map((u) => `${u.field}:${u.url}`)).toEqual([
      "githubUrl:https://github.com/o/r",
    ]);
    // Custom: only myLink is read; githubUrl is ignored.
    const spec = customSpec({ sourceUrlFields: ["myLink"] });
    expect(extractSubmittedSourceUrls(src, spec).map((u) => `${u.field}:${u.url}`)).toEqual([
      "myLink:https://example.com/a",
    ]);
  });

  it("extractSubmittedSourceUrls reads array URLs from the custom list-field set", () => {
    const src = ["---", "mySources:", "  - https://list.example/1", "---", "", "body"].join("\n");
    // Default: mySources is not a recognized list field → nothing read.
    expect(extractSubmittedSourceUrls(src)).toEqual([]);
    // Custom: mySources is a list field → its items are read.
    const spec = customSpec({ sourceUrlListFields: new Set(["mySources"]) });
    expect(extractSubmittedSourceUrls(src, spec).map((u) => `${u.field}:${u.url}`)).toEqual([
      "mySources:https://list.example/1",
    ]);
  });

  it("a custom distribution-field set drops a site-relative artifact for the custom field (extract filter)", () => {
    // The default treats githubUrl as canonical, so a site-relative value is kept; the custom spec
    // marks githubUrl as a distribution field, so the same site-relative value is dropped.
    const src = mdx({ githubUrl: "/local/artifact" });
    expect(extractSubmittedSourceUrls(src).map((u) => u.field)).toEqual(["githubUrl"]);
    const spec = customSpec({ distributionSourceFields: new Set(["githubUrl"]) });
    expect(extractSubmittedSourceUrls(src, spec)).toEqual([]);
  });

  it("a custom distribution-FIELD set flips the sourceRole of a checked URL", async () => {
    const src = mdx({ githubUrl: "https://github.com/acme/x" });
    // Default: githubUrl is canonical.
    const base = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/x": 200 }));
    expect(base.urls.find((u) => u.field === "githubUrl")?.role).toBe("canonical");
    // Custom: githubUrl is a distribution field → role becomes distribution.
    const spec = customSpec({ distributionSourceFields: new Set(["githubUrl"]) });
    const over = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://github.com/acme/x": 200 }), spec);
    expect(over.urls.find((u) => u.field === "githubUrl")?.role).toBe("distribution");
  });

  it("a custom distribution-HOST set flips the sourceRole of a canonical-field URL", async () => {
    const src = mdx({ githubUrl: "https://custom-registry.example/pkg" });
    // Default: custom-registry.example is not a distribution host → canonical.
    const base = await checkSubmittedSourceEvidence(src, fakeFetch({ "https://custom-registry.example/pkg": 200 }));
    expect(base.urls.find((u) => u.field === "githubUrl")?.role).toBe("canonical");
    // Custom: custom-registry.example is a distribution host → distribution.
    const spec = customSpec({ distributionSourceHosts: new Set(["custom-registry.example"]) });
    const over = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({ "https://custom-registry.example/pkg": 200 }),
      spec,
    );
    expect(over.urls.find((u) => u.field === "githubUrl")?.role).toBe("distribution");
  });

  it("a custom primary-canonical-field set changes shouldHardCloseSourceEvidence", async () => {
    // Two dead websiteUrl/docsUrl sources: by default neither is a PRIMARY canonical field, but both
    // are canonical-ROLE, so they ARE authoritative → all-failed + >1 → hard-close is true under default.
    const src = mdx({
      websiteUrl: "https://site.example/dead1",
      docsUrl: "https://docs.example/dead2",
    });
    const report = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({ "https://site.example/dead1": 404, "https://docs.example/dead2": 404 }),
    );
    // Default close decision: both are canonical-role authoritative → hard-close.
    expect(shouldHardCloseSourceEvidence(report)).toBe(true);
    expect(sourceEvidenceCloseDecision(report)?.verdict).toBe("close");

    // Custom spec makes websiteUrl/docsUrl a DISTRIBUTION field set so their role is distribution and
    // primaryCanonicalSourceFields stays the awesome default (neither matches) → no authoritative items.
    const spec = customSpec({ distributionSourceFields: new Set(["websiteUrl", "docsUrl"]) });
    const overReport = await checkSubmittedSourceEvidence(
      src,
      fakeFetch({ "https://site.example/dead1": 404, "https://docs.example/dead2": 404 }),
      spec,
    );
    expect(shouldHardCloseSourceEvidence(overReport, spec)).toBe(false);
    // sourceEvidenceCloseDecision routes to MANUAL (still has blocking hard-failure evidence) under the spec.
    expect(sourceEvidenceCloseDecision(overReport, spec)?.verdict).toBe("manual");
  });

  it("a custom primary-canonical-field set keeps a non-default field's retryable BLOCKING (downgrade rule)", async () => {
    // websiteUrl is canonical but NOT a default primary field, so a flaky websiteUrl downgrades when a
    // reachable primary (githubUrl) anchors. Promoting websiteUrl to primary keeps it blocking.
    const src = mdx({
      githubUrl: "https://github.com/acme/anchor",
      websiteUrl: "https://flaky.example/site",
    });
    const status = { "https://github.com/acme/anchor": 200, "https://flaky.example/site": 503 };
    const base = await checkSubmittedSourceEvidence(src, fakeFetch(status));
    // Default: websiteUrl is non-primary retryable → downgraded to a non-blocking warning, report passes.
    expect(base.urls.find((u) => u.field === "websiteUrl")?.blocking).toBe(false);
    expect(base.status).toBe("passed");

    const spec = customSpec({ primaryCanonicalSourceFields: new Set(["githubUrl", "websiteUrl"]) });
    const over = await checkSubmittedSourceEvidence(src, fakeFetch(status), spec);
    // Custom: websiteUrl is now primary → its retryable is NOT downgradable → stays blocking, report retryable.
    expect(over.urls.find((u) => u.field === "websiteUrl")?.blocking).toBe(true);
    expect(over.status).toBe("retryable");
  });
});
