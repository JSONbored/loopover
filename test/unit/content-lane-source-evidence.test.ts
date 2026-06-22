import { describe, expect, it } from "vitest";
import {
  checkSubmittedSourceEvidence,
  extractSubmittedSourceUrls,
  shouldHardCloseSourceEvidence,
  sourceEvidenceCloseDecision,
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
