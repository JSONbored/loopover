import { describe, expect, it, vi } from "vitest";

import { extractContributionProfile } from "../../packages/loopover-miner/lib/contribution-profile-extract.js";

const AT = "2026-07-18T00:00:00.000Z";

type Label = { name: string; description?: string | null };

/** The repo's global `fetch` type (Cloudflare Workers) has a wider input type than a plain `(url: string)`
 *  mock; cast through unknown so a url-string stub satisfies the `fetchImpl?: typeof fetch` option. */
const asFetch = (fn: unknown): typeof fetch => fn as unknown as typeof fetch;

/** Build a fetch stub whose /labels response is `labels` and whose CONTRIBUTING.md is `contributing` (or 404). */
function stubFetch(
  opts: {
    labels?: Label[] | number;
    contributing?: string | null;
    contributingGithubDir?: string | null;
    agentsMd?: string | null;
    claudeMd?: string | null;
  } = {},
) {
  const emptyHeaders = { get: (_name: string) => null };
  // #8316: a base64 contents response (present) or 404 (absent), matching the CONTRIBUTING.md branches above.
  const contentsResponse = (text: string | null | undefined) =>
    (text == null
      ? { ok: false, status: 404, headers: emptyHeaders, json: async () => ({}) }
      : {
          ok: true,
          status: 200,
          headers: emptyHeaders,
          json: async () => ({
            encoding: "base64",
            content: Buffer.from(String(text)).toString("base64"),
          }),
        }) as unknown as Response;
  return asFetch(
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels")) {
        if (typeof opts.labels === "number")
          return {
            ok: false,
            status: opts.labels,
            headers: emptyHeaders,
            json: async () => ({}),
          } as unknown as Response;
        return {
          ok: true,
          status: 200,
          headers: emptyHeaders,
          json: async () => opts.labels ?? [],
        } as unknown as Response;
      }
      if (u.includes("/contents/CONTRIBUTING.md")) {
        if (opts.contributing == null)
          return {
            ok: false,
            status: 404,
            headers: emptyHeaders,
            json: async () => ({}),
          } as unknown as Response;
        return {
          ok: true,
          status: 200,
          headers: emptyHeaders,
          json: async () => ({
            encoding: "base64",
            content: Buffer.from(String(opts.contributing)).toString("base64"),
          }),
        } as unknown as Response;
      }
      if (u.includes("/contents/.github/CONTRIBUTING.md")) {
        if (opts.contributingGithubDir == null)
          return {
            ok: false,
            status: 404,
            headers: emptyHeaders,
            json: async () => ({}),
          } as unknown as Response;
        return {
          ok: true,
          status: 200,
          headers: emptyHeaders,
          json: async () => ({
            encoding: "base64",
            content: Buffer.from(String(opts.contributingGithubDir)).toString(
              "base64",
            ),
          }),
        } as unknown as Response;
      }
      if (u.includes("/contents/AGENTS.md")) return contentsResponse(opts.agentsMd);
      if (u.includes("/contents/CLAUDE.md")) return contentsResponse(opts.claudeMd);
      return {
        ok: false,
        status: 404,
        headers: emptyHeaders,
        json: async () => ({}),
      } as unknown as Response;
    }),
  );
}

const bigContributing = (body: string) =>
  `${body}\n${"filler line to exceed the signpost threshold.\n".repeat(30)}`;

describe("extractContributionProfile (#6796)", () => {
  it("extracts loopover's own convention (help wanted label) as an explicit eligibility rule", async () => {
    const fetchImpl = stubFetch({
      labels: [
        { name: "help wanted", description: "Extra attention is needed" },
        { name: "gittensor", description: "Gittensor contributor context" },
      ],
    });
    const profile = await extractContributionProfile("JSONbored/loopover", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.eligibilityLabels.confidence).toBe("explicit");
    expect(profile.eligibilityLabels.value).toEqual([
      { field: "name", contains: "help wanted" },
    ]);
    expect(profile.eligibilityLabels.provenance).toEqual([
      { source: "labels", detail: "help wanted" },
    ]);
    expect(profile.repoFullName).toBe("JSONbored/loopover");
    expect(profile.schemaVersion).toBe(1);
  });

  it("extracts a DIFFERENT but explicit convention where the meaning is in the description, not the name", async () => {
    // A label whose NAME carries no recognized eligibility term, but whose DESCRIPTION does (the #6794 finding
    // that rust encodes eligibility in descriptions) — a name-only extractor would miss this entirely.
    const fetchImpl = stubFetch({
      labels: [
        {
          name: "mentored",
          description: "A good first issue with a mentor assigned.",
        },
      ],
    });
    const profile = await extractContributionProfile("rust-lang/rust", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.eligibilityLabels.confidence).toBe("explicit");
    expect(profile.eligibilityLabels.value).toEqual([
      { field: "description", contains: "good first issue" },
    ]);
  });

  it("produces a low-confidence, fully-absent profile for a repo with no discoverable signals — not a false guess", async () => {
    const fetchImpl = stubFetch({
      labels: [{ name: "bug", description: "Something is broken" }],
      contributing: null,
    });
    const profile = await extractContributionProfile("sindresorhus/slugify", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.eligibilityLabels).toEqual({
      value: null,
      confidence: "absent",
      provenance: [],
    });
    expect(profile.exclusionLabels).toEqual({
      value: null,
      confidence: "absent",
      provenance: [],
    });
    expect(profile.prBody).toEqual({
      value: null,
      confidence: "absent",
      provenance: [],
    });
    expect(profile.completeness).toBe("absent");
  });

  it("classifies conventional exclusion labels as inferred (weaker than eligibility)", async () => {
    const fetchImpl = stubFetch({
      labels: [
        { name: "blocked", description: "Waiting on something else" },
        { name: "wontfix", description: null },
      ],
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.exclusionLabels.confidence).toBe("inferred");
    expect(profile.exclusionLabels.value).toEqual([
      { field: "name", contains: "blocked" },
      { field: "name", contains: "wontfix" },
    ]);
  });

  it("reads the linked-issue requirement from a real-sized CONTRIBUTING.md and marks it explicit", async () => {
    const fetchImpl = stubFetch({
      labels: [],
      contributing: bigContributing(
        "Every PR must reference an issue with Closes #123.",
      ),
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.prBody).toEqual({
      value: { requiresLinkedIssue: true },
      confidence: "explicit",
      provenance: [{ source: "contributing_md", detail: "CONTRIBUTING.md" }],
    });
  });

  it("marks prBody explicit-false when a real CONTRIBUTING.md states no linked-issue rule", async () => {
    const fetchImpl = stubFetch({
      labels: [],
      contributing: bigContributing(
        "Please run the tests before opening a PR.",
      ),
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.prBody).toEqual({
      value: { requiresLinkedIssue: false },
      confidence: "explicit",
      provenance: [{ source: "contributing_md", detail: "CONTRIBUTING.md" }],
    });
  });

  it("treats a tiny CONTRIBUTING.md as a signpost, not the rules (unknown, not a false negative)", async () => {
    // react's is 208 B / kubernetes' 525 B -- just a link to an external guide AMS cannot read.
    const fetchImpl = stubFetch({
      labels: [],
      contributing: "See our guide: https://example.org/contributing",
    });
    const profile = await extractContributionProfile("facebook/react", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.prBody).toEqual({
      value: null,
      confidence: "unknown",
      provenance: [],
    });
  });

  it("falls back to .github/CONTRIBUTING.md when the root file is absent", async () => {
    const fetchImpl = stubFetch({
      labels: [],
      contributing: null,
      contributingGithubDir: bigContributing("Reference an issue in your PR."),
    });
    const profile = await extractContributionProfile("denoland/deno", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.prBody.value).toEqual({ requiresLinkedIssue: true });
  });

  it("degrades to absent labels when the labels fetch fails (HTTP error), without throwing", async () => {
    const fetchImpl = stubFetch({ labels: 500, contributing: null });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
      sleepFn: async () => {},
    });
    expect(profile.eligibilityLabels.confidence).toBe("absent");
    expect(profile.completeness).toBe("absent");
  });

  it("pages through Link rel=next and collects labels past the first 100 (#8010)", async () => {
    const emptyHeaders = { get: (_name: string) => null };
    let labelsCalls = 0;
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      name: `bulk-${i}`,
      description: null as string | null,
    }));
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels")) {
        labelsCalls += 1;
        if (labelsCalls === 1) {
          expect(u).toContain("page=1");
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "link"
                  ? '<https://api.github.com/repos/acme/widgets/labels?page=2>; rel="next"'
                  : null,
            },
            json: async () => page1,
          } as unknown as Response;
        }
        expect(u).toContain("page=2");
        return {
          ok: true,
          status: 200,
          headers: emptyHeaders,
          json: async () => [
            { name: "good first issue", description: "Starter work" },
            { name: "bulk-extra", description: null },
          ],
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        headers: emptyHeaders,
        json: async () => ({}),
      } as unknown as Response;
    });

    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });

    expect(labelsCalls).toBe(2);
    expect(profile.eligibilityLabels.confidence).toBe("explicit");
    expect(profile.eligibilityLabels.value).toEqual([
      { field: "name", contains: "good first issue" },
    ]);
    expect(profile.eligibilityLabels.provenance).toEqual([
      { source: "labels", detail: "good first issue" },
    ]);
  });

  it("keeps page-1 labels when a later page fails (fail-open pagination, #8010)", async () => {
    const emptyHeaders = { get: (_name: string) => null };
    let labelsCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels")) {
        labelsCalls += 1;
        if (labelsCalls === 1) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "link"
                  ? '<https://api.github.com/repos/acme/widgets/labels?page=2>; rel="next"'
                  : null,
            },
            json: async () => [{ name: "help wanted", description: null }],
          } as unknown as Response;
        }
        return {
          ok: false,
          status: 500,
          headers: emptyHeaders,
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        headers: emptyHeaders,
        json: async () => ({}),
      } as unknown as Response;
    });

    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
      sleepFn: async () => {},
    });

    expect(labelsCalls).toBeGreaterThanOrEqual(2);
    expect(profile.eligibilityLabels.confidence).toBe("explicit");
    expect(profile.eligibilityLabels.value).toEqual([
      { field: "name", contains: "help wanted" },
    ]);
  });

  it("stops pagination when a next page returns an empty array (#8010)", async () => {
    const emptyHeaders = { get: (_name: string) => null };
    let labelsCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels")) {
        labelsCalls += 1;
        if (labelsCalls === 1) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "link"
                  ? '<https://api.github.com/repos/acme/widgets/labels?page=2>; rel="next"'
                  : null,
            },
            json: async () => [{ name: "help wanted", description: null }],
          } as unknown as Response;
        }
        // Empty page still advertises a next link — the empty-page guard must stop the loop.
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "link"
                ? '<https://api.github.com/repos/acme/widgets/labels?page=3>; rel="next"'
                : null,
          },
          json: async () => [],
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        headers: emptyHeaders,
        json: async () => ({}),
      } as unknown as Response;
    });

    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });

    expect(labelsCalls).toBe(2);
    expect(profile.eligibilityLabels.value).toEqual([
      { field: "name", contains: "help wanted" },
    ]);
  });

  it("stops pagination when a later page returns a non-array payload (#8010)", async () => {
    const emptyHeaders = { get: (_name: string) => null };
    let labelsCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels")) {
        labelsCalls += 1;
        if (labelsCalls === 1) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "link"
                  ? '<https://api.github.com/repos/acme/widgets/labels?page=2>; rel="next"'
                  : null,
            },
            json: async () => [{ name: "help wanted", description: null }],
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          headers: emptyHeaders,
          json: async () => ({ message: "weird" }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        headers: emptyHeaders,
        json: async () => ({}),
      } as unknown as Response;
    });

    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });

    expect(labelsCalls).toBe(2);
    expect(profile.eligibilityLabels.value).toEqual([
      { field: "name", contains: "help wanted" },
    ]);
  });

  it("retries a transient 5xx on the labels fetch and yields the same profile as an immediate success (#7090)", async () => {
    // A single 5xx blip on the first attempt must NOT degrade the label signal — the retry rides it out and the
    // resulting profile is identical to one where the labels fetch succeeded immediately.
    const emptyHeaders = { get: (_name: string) => null };
    const sleeps: number[] = [];
    let labelsCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels")) {
        labelsCalls += 1;
        if (labelsCalls === 1)
          return {
            ok: false,
            status: 500,
            headers: emptyHeaders,
            json: async () => ({}),
          } as unknown as Response;
        return {
          ok: true,
          status: 200,
          headers: emptyHeaders,
          json: async () => [
            { name: "help wanted", description: "Extra attention is needed" },
          ],
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        headers: emptyHeaders,
        json: async () => ({}),
      } as unknown as Response;
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(labelsCalls).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(profile.eligibilityLabels.confidence).toBe("explicit");
    expect(profile.eligibilityLabels.value).toEqual([
      { field: "name", contains: "help wanted" },
    ]);
  });

  it("retries a transient 5xx on the CONTRIBUTING.md fetch and reads the linked-issue rule as if it never blipped (#7090)", async () => {
    const sleeps: number[] = [];
    let docCalls = 0;
    const body = bigContributing("Reference an issue with Closes #7.");
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels"))
        return {
          ok: true,
          status: 200,
          json: async () => [],
        } as unknown as Response;
      if (u.includes("/contents/CONTRIBUTING.md")) {
        docCalls += 1;
        if (docCalls === 1)
          return {
            ok: false,
            status: 503,
            json: async () => ({}),
          } as unknown as Response;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            encoding: "base64",
            content: Buffer.from(body).toString("base64"),
          }),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as unknown as Response;
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(docCalls).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(profile.prBody).toEqual({
      value: { requiresLinkedIssue: true },
      confidence: "explicit",
      provenance: [{ source: "contributing_md", detail: "CONTRIBUTING.md" }],
    });
  });

  it("still degrades labels to absent once the 5xx retries are genuinely exhausted, without throwing (#7090)", async () => {
    const sleeps: number[] = [];
    let labelsCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/labels")) {
        labelsCalls += 1;
        return {
          ok: false,
          status: 502,
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as unknown as Response;
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    // DEFAULT_MAX_ATTEMPTS attempts, 2 sleeps between them — then fail open exactly as before.
    expect(labelsCalls).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(profile.eligibilityLabels.confidence).toBe("absent");
    expect(profile.completeness).toBe("absent");
  });

  it("still degrades the doc to absent once its 5xx retries are exhausted, preserving the fail-open contract (#7090)", async () => {
    let docCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels"))
        return {
          ok: true,
          status: 200,
          json: async () => [],
        } as unknown as Response;
      docCalls += 1;
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
      } as unknown as Response;
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
      sleepFn: async () => {},
    });
    // CONTRIBUTING.md's root and `.github/` probes are each retried to exhaustion (3 attempts × 2 paths = 6);
    // then, because that leaves prBody `absent`, the #8316 agent-doc fallback probes AGENTS.md and CLAUDE.md,
    // each likewise retried to exhaustion (3 × 2 = 6) — 12 doc calls total, all still degrading fail-open.
    expect(docCalls).toBe(12);
    expect(profile.prBody.confidence).toBe("absent");
  });

  it("degrades to absent when the transport throws, without propagating the error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.eligibilityLabels.confidence).toBe("absent");
    expect(profile.prBody.confidence).toBe("absent");
  });

  it("returns a safe empty profile for a malformed repo name, without any fetch", async () => {
    const fetchImpl = vi.fn();
    const profile = await extractContributionProfile("not-a-repo", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.repoFullName).toBe("not-a-repo");
    expect(profile.completeness).toBe("absent");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns an empty profile with an empty repoFullName for a non-string input, without fetching", async () => {
    const fetchImpl = vi.fn();
    const profile = await extractContributionProfile(123 as unknown as string, {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.repoFullName).toBe("");
    expect(profile.completeness).toBe("absent");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ignores an undecodable/wrong-encoding contents payload, treating the doc as absent", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/labels"))
        return {
          ok: true,
          status: 200,
          json: async () => [],
        } as unknown as Response;
      // A non-base64 encoding (e.g. a large file returned as a download URL) must not throw.
      return {
        ok: true,
        status: 200,
        json: async () => ({ encoding: "none", content: "" }),
      } as unknown as Response;
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.prBody.confidence).toBe("absent");
  });

  it("sends an Authorization header when a token is supplied, and hits the configured apiBaseUrl", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({
        url: String(url),
        auth: (init.headers as Record<string, string>).authorization,
      });
      return {
        ok: true,
        status: 200,
        json: async () => (String(url).includes("/labels") ? [] : {}),
      } as unknown as Response;
    });
    await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      githubToken: "tok123",
      apiBaseUrl: "https://ghe.example.com/api/v3/",
      generatedAt: AT,
    });
    expect(seen[0]?.url).toContain(
      "https://ghe.example.com/api/v3/repos/acme/widgets/labels",
    );
    expect(seen[0]?.auth).toBe("Bearer tok123");
  });

  it("labels a matched label with no name as an unnamed label in provenance", async () => {
    // A label object missing `name` but matching via description must not crash the provenance detail.
    const fetchImpl = stubFetch({
      labels: [{ description: "good first issue" } as Label],
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.eligibilityLabels.provenance).toEqual([
      { source: "labels", detail: "(unnamed label)" },
    ]);
    expect(profile.eligibilityLabels.value).toEqual([
      { field: "description", contains: "good first issue" },
    ]);
  });

  it("defaults generatedAt to a fresh ISO timestamp when none is supplied", async () => {
    const fetchImpl = stubFetch({ labels: [] });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
    });
    expect(profile.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("degrades a labels response whose body fails to parse as JSON, without throwing", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/labels")) {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("bad json");
          },
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as unknown as Response;
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.eligibilityLabels.confidence).toBe("absent");
  });

  it("computes completeness as the weakest of the three spine signals", async () => {
    // Explicit eligibility + absent exclusion + explicit prBody ⇒ weakest is absent.
    const fetchImpl = stubFetch({
      labels: [{ name: "good first issue", description: null }],
      contributing: bigContributing("Reference an issue with Closes #1."),
    });
    const profile = await extractContributionProfile("acme/widgets", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.eligibilityLabels.confidence).toBe("explicit");
    expect(profile.exclusionLabels.confidence).toBe("absent");
    expect(profile.prBody.confidence).toBe("explicit");
    expect(profile.completeness).toBe("absent");
  });
});

describe("extractContributionProfile — agent-doc PR-body fallback (#8316)", () => {
  it("keeps CONTRIBUTING.md authoritative and ignores agent docs when it yields a non-absent rule", async () => {
    // CONTRIBUTING.md states the rule; an AGENTS.md that WOULD flip the result if consulted must be ignored.
    const fetchImpl = stubFetch({
      contributing: bigContributing("Every PR must include closes #<issue>."),
      agentsMd: bigContributing("This repo has no linked-issue requirement whatsoever."),
    });
    const profile = await extractContributionProfile("acme/has-contributing", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.prBody).toEqual({
      value: { requiresLinkedIssue: true },
      confidence: "explicit",
      provenance: [{ source: "contributing_md", detail: "CONTRIBUTING.md" }],
    });
  });

  it("falls back to AGENTS.md (tagged agent_docs) when there is no CONTRIBUTING.md", async () => {
    const fetchImpl = stubFetch({
      contributing: null,
      agentsMd: bigContributing("Contributors must link the issue: closes #<n>."),
    });
    const profile = await extractContributionProfile("acme/agents-only", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.prBody).toEqual({
      value: { requiresLinkedIssue: true },
      confidence: "explicit",
      provenance: [{ source: "agent_docs", detail: "CONTRIBUTING.md" }],
    });
  });

  it("falls back to CLAUDE.md when AGENTS.md is missing but CLAUDE.md is present", async () => {
    const fetchImpl = stubFetch({
      contributing: null,
      agentsMd: null,
      claudeMd: bigContributing("Please reference an issue in the PR body."),
    });
    const profile = await extractContributionProfile("acme/claude-only", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.prBody).toEqual({
      value: { requiresLinkedIssue: true },
      confidence: "explicit",
      provenance: [{ source: "agent_docs", detail: "CONTRIBUTING.md" }],
    });
  });

  it("stays absent when neither CONTRIBUTING.md nor any agent doc exists", async () => {
    const fetchImpl = stubFetch({ contributing: null, agentsMd: null, claudeMd: null });
    const profile = await extractContributionProfile("acme/nothing", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.prBody).toEqual({ value: null, confidence: "absent", provenance: [] });
  });

  it("treats a signpost-sized agent doc as unknown, not a false rule (no provenance to tag)", async () => {
    const fetchImpl = stubFetch({ contributing: null, agentsMd: "See our wiki." });
    const profile = await extractContributionProfile("acme/tiny-agents", {
      fetchImpl: asFetch(fetchImpl),
      generatedAt: AT,
    });
    expect(profile.prBody).toEqual({ value: null, confidence: "unknown", provenance: [] });
  });
});
