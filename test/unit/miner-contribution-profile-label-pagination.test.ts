import { describe, expect, it, vi } from "vitest";

import { extractContributionProfile } from "../../packages/loopover-miner/lib/contribution-profile-extract.js";

// Regression for #8010: extractContributionProfile's label fetch previously issued a single
// `?per_page=100` request and dropped every label past page 1. It must now follow GitHub's
// `Link: rel="next"` pagination (mirroring ci-poller.ts's check-run paging) so a repo with
// more than 100 labels has its 101st+ label classified, while a <=100-label repo is unchanged.

const AT = "2026-07-18T00:00:00.000Z";

/** The repo's global `fetch` type is wider than a plain `(url: string)` mock; cast through unknown. */
const asFetch = (fn: unknown): typeof fetch => fn as unknown as typeof fetch;

type Label = { name: string; description?: string | null };

/** A GitHub list-endpoint response whose `Link` header advertises `link` (or none when null). */
function pageResponse(labels: Label[], link: string | null): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === "link" ? link : null),
    },
    json: async () => labels,
  } as unknown as Response;
}

function parsePage(url: string): number {
  const match = /[?&]page=(\d+)/.exec(url);
  return match ? Number(match[1]) : 1;
}

/** 100 inert labels (no eligibility/exclusion vocabulary) filling page 1, forcing a second page. */
const firstPageFiller: Label[] = Array.from({ length: 100 }, (_, i) => ({
  name: `area-${i}`,
  description: "routing area label",
}));

describe("extractContributionProfile label pagination (#8010)", () => {
  it("follows the Link rel=next header and classifies labels that live past page 1", async () => {
    const nextLink =
      '<https://api.github.com/repos/acme/widgets/labels?per_page=100&page=2>; rel="next"';
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels")) {
        // Page 1: 100 inert labels + a `rel="next"` pointer. Page 2: the only meaningful labels.
        if (parsePage(u) === 1) return pageResponse(firstPageFiller, nextLink);
        return pageResponse(
          [
            { name: "good first issue", description: "Great for newcomers" },
            { name: "wontfix", description: "This will not be worked on" },
          ],
          null,
        );
      }
      // CONTRIBUTING.md probes 404.
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });

    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });

    // The page-2 eligibility label reached classification (would be `absent` under the old single-fetch code).
    expect(profile.eligibilityLabels.confidence).toBe("explicit");
    expect(profile.eligibilityLabels.value).toEqual([
      { field: "name", contains: "good first issue" },
    ]);
    // And the page-2 exclusion label too.
    expect(profile.exclusionLabels.confidence).toBe("inferred");
    expect(profile.exclusionLabels.value).toEqual([
      { field: "name", contains: "wontfix" },
    ]);

    // Exactly two label pages were fetched, in order.
    const labelUrls = fetchImpl.mock.calls
      .map((call) => String(call[0]))
      .filter((u) => u.includes("/labels"));
    expect(labelUrls).toHaveLength(2);
    expect(parsePage(String(labelUrls[0]))).toBe(1);
    expect(parsePage(String(labelUrls[1]))).toBe(2);
  });

  it("stops after page 1 when the response carries no rel=next link (<=100 labels unchanged)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels")) {
        // A single page: a Link header exists but advertises no `next` rel, so paging must stop.
        return pageResponse(
          [{ name: "help wanted", description: "Extra attention is needed" }],
          '<https://api.github.com/repos/acme/widgets/labels?per_page=100&page=1>; rel="last"',
        );
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });

    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });

    expect(profile.eligibilityLabels.confidence).toBe("explicit");
    expect(profile.eligibilityLabels.value).toEqual([
      { field: "name", contains: "help wanted" },
    ]);

    const labelUrls = fetchImpl.mock.calls
      .map((call) => String(call[0]))
      .filter((u) => u.includes("/labels"));
    expect(labelUrls).toHaveLength(1);
  });
});
