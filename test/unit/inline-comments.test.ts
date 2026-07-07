import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { InlineFinding } from "../../src/services/ai-review";
import { isInlineCommentsEnabled, maybePostInlineComments, postInlineReviewComments, rightSideLinesFromPatch, selectInlineComments, shouldRenderFindingCategories, shouldRenderSuggestions, shouldRequestInlineFindings } from "../../src/review/inline-comments";
import { createTestEnv } from "../helpers/d1";

function envWithKey() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return createTestEnv({ GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString() });
}

const fileWith = (path: string, patch: string) => ({ path, payload: { patch } });

describe("isInlineCommentsEnabled (#inline-comments)", () => {
  it("is truthy-string gated and OFF by default", () => {
    expect(isInlineCommentsEnabled({})).toBe(false);
    expect(isInlineCommentsEnabled({ GITTENSORY_REVIEW_INLINE_COMMENTS: "true" })).toBe(true);
    expect(isInlineCommentsEnabled({ GITTENSORY_REVIEW_INLINE_COMMENTS: "on" })).toBe(true);
    expect(isInlineCommentsEnabled({ GITTENSORY_REVIEW_INLINE_COMMENTS: "false" })).toBe(false);
  });
});

describe("shouldRequestInlineFindings (#inline-comments)", () => {
  const on = { GITTENSORY_REVIEW_INLINE_COMMENTS: "true", GITTENSORY_REVIEW_REPOS: "acme/widgets" };
  it("requires ALL THREE gates: the per-repo manifest toggle, the operator flag, and the cutover allowlist", () => {
    expect(shouldRequestInlineFindings(on, "acme/widgets", true)).toBe(true);
    expect(shouldRequestInlineFindings(on, "acme/widgets", false)).toBe(false); // manifest toggle off
    expect(shouldRequestInlineFindings(on, "acme/widgets", undefined)).toBe(false); // manifest toggle absent
    expect(shouldRequestInlineFindings({ GITTENSORY_REVIEW_REPOS: "acme/widgets" }, "acme/widgets", true)).toBe(false); // operator flag off
    expect(shouldRequestInlineFindings(on, "other/repo", true)).toBe(false); // repo not allowlisted
  });
});

describe("shouldRenderSuggestions (#1956)", () => {
  it("requires the manifest toggle AND inline comments already being enabled — a suggestion has nothing to attach to otherwise", () => {
    expect(shouldRenderSuggestions(true, true)).toBe(true);
    expect(shouldRenderSuggestions(true, false)).toBe(false); // manifest toggle off
    expect(shouldRenderSuggestions(true, undefined)).toBe(false); // manifest toggle absent
    expect(shouldRenderSuggestions(false, true)).toBe(false); // inline comments themselves are off
    expect(shouldRenderSuggestions(false, false)).toBe(false);
  });
});

describe("shouldRenderFindingCategories (#1958)", () => {
  it("requires the manifest toggle AND inline comments already being enabled — a category has nothing to categorize otherwise", () => {
    expect(shouldRenderFindingCategories(true, true)).toBe(true);
    expect(shouldRenderFindingCategories(true, false)).toBe(false); // manifest toggle off
    expect(shouldRenderFindingCategories(true, undefined)).toBe(false); // manifest toggle absent
    expect(shouldRenderFindingCategories(false, true)).toBe(false); // inline comments themselves are off
    expect(shouldRenderFindingCategories(false, false)).toBe(false);
  });
});

describe("rightSideLinesFromPatch (#inline-comments)", () => {
  it("returns RIGHT-side line numbers for added + context lines, excluding deleted lines and the no-newline marker", () => {
    const patch = "@@ -1,3 +1,4 @@\n ctx1\n-removed\n+added2\n+added3\n ctx4\n\\ No newline at end of file";
    expect([...rightSideLinesFromPatch(patch)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("handles multiple hunks and ignores any preamble before the first hunk header", () => {
    const patch = "preamble line\n@@ -10,1 +10,2 @@\n ctx10\n+add11\n@@ -50,0 +60,1 @@\n+add60";
    expect([...rightSideLinesFromPatch(patch)].sort((a, b) => a - b)).toEqual([10, 11, 60]);
  });

  it("returns an empty set when there is no hunk header (or an empty patch)", () => {
    expect(rightSideLinesFromPatch("no hunks here").size).toBe(0);
    expect(rightSideLinesFromPatch("").size).toBe(0);
  });

  it("does NOT add a spurious line for a trailing newline (regression — would 422 a finding anchored past the hunk)", () => {
    // The trailing "\n" makes split() emit a final "" element; it must be ignored, not counted as line 3.
    expect([...rightSideLinesFromPatch("@@ -1,1 +1,2 @@\n ctx\n+added2\n")].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe("selectInlineComments (#inline-comments)", () => {
  const files = [fileWith("src/a.ts", "@@ -1,1 +1,2 @@\n ctx\n+added2"), { path: "src/no-patch.ts", payload: {} }];

  it("keeps a finding on a commentable diff line; drops out-of-diff lines, no-patch files, and unknown files (no 422)", () => {
    const out = selectInlineComments(
      [
        { path: "src/a.ts", line: 2, severity: "blocker", body: "On the added line." },
        { path: "src/a.ts", line: 99, severity: "nit", body: "Out of the diff." },
        { path: "src/no-patch.ts", line: 1, severity: "nit", body: "File has no patch." },
        { path: "src/missing.ts", line: 1, severity: "nit", body: "File not in the PR." },
      ],
      files,
    );
    expect(out).toEqual([{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Blocker:** On the added line." }]);
  });

  it("dedupes by path+line (first wins) and labels nits", () => {
    const out = selectInlineComments(
      [
        { path: "src/a.ts", line: 1, severity: "nit", body: "First." },
        { path: "src/a.ts", line: 1, severity: "blocker", body: "Duplicate line — dropped." },
      ],
      files,
    );
    expect(out).toEqual([{ path: "src/a.ts", line: 1, side: "RIGHT", body: "**Nit:** First." }]);
  });

  it("drops inline nits below review.min_finding_severity while keeping blockers (#2048)", () => {
    const out = selectInlineComments(
      [
        { path: "src/a.ts", line: 2, severity: "blocker", body: "Must fix." },
        { path: "src/a.ts", line: 2, severity: "nit", body: "Style only." },
      ],
      files,
      false,
      false,
      "major",
    );
    expect(out).toEqual([{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Blocker:** Must fix." }]);
  });

  it("caps the output at 10 comments", () => {
    const bigPatch = "@@ -1,0 +1,12 @@\n" + Array.from({ length: 12 }, (_, i) => `+line${i + 1}`).join("\n");
    const bigFiles = [{ path: "src/big.ts", payload: { patch: bigPatch } }];
    const many: InlineFinding[] = Array.from({ length: 12 }, (_, i) => ({ path: "src/big.ts", line: i + 1, severity: "nit", body: `b${i + 1}` }));
    expect(selectInlineComments(many, bigFiles)).toHaveLength(10);
  });

  describe("suggestion blocks (#1956)", () => {
    const withSuggestion: InlineFinding = { path: "src/a.ts", line: 2, severity: "nit", body: "Use const.", suggestion: "const x = 1;" };

    it("defaults to OFF (backward compatible) — a suggestion is never rendered when the third argument is omitted", () => {
      const out = selectInlineComments([withSuggestion], files);
      expect(out).toEqual([{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Nit:** Use const." }]);
    });

    it("does not render a suggestion when explicitly disabled, even if the finding carries one", () => {
      const out = selectInlineComments([withSuggestion], files, false);
      expect(out[0]?.body).not.toContain("```suggestion");
    });

    it("renders a GitHub-native suggested-change block when enabled and the finding carries a suggestion", () => {
      const out = selectInlineComments([withSuggestion], files, true);
      expect(out[0]?.body).toBe("**Nit:** Use const.\n\n```suggestion\nconst x = 1;\n```");
    });

    it("renders no suggestion block (finding text only) when enabled but the finding has none", () => {
      const noSuggestion: InlineFinding = { path: "src/a.ts", line: 2, severity: "nit", body: "Use const." };
      const out = selectInlineComments([noSuggestion], files, true);
      expect(out[0]?.body).toBe("**Nit:** Use const.");
    });

    it("fails safe: drops a suggestion whose own text contains a triple-backtick run, to avoid corrupting the comment's markdown fence, but keeps the finding text", () => {
      const breaksFence: InlineFinding = { path: "src/a.ts", line: 2, severity: "blocker", body: "Fix this.", suggestion: "```\nescape attempt\n```" };
      const out = selectInlineComments([breaksFence], files, true);
      expect(out[0]?.body).toBe("**Blocker:** Fix this.");
      expect(out[0]?.body).not.toContain("escape attempt");
    });

    it("strips the suggestion on a context line but keeps the plain inline comment (#2140)", () => {
      const contextFinding: InlineFinding = {
        path: "src/a.ts",
        line: 1,
        severity: "nit",
        body: "On context.",
        suggestion: "ctx fix",
      };
      const out = selectInlineComments([contextFinding], files, true);
      expect(out).toEqual([{ path: "src/a.ts", line: 1, side: "RIGHT", body: "**Nit:** On context." }]);
    });

    it("never emits a suggestion for a file with no usable patch (#2140)", () => {
      const finding: InlineFinding = {
        path: "src/no-patch.ts",
        line: 1,
        severity: "nit",
        body: "missing patch",
        suggestion: "fix",
      };
      expect(selectInlineComments([finding], files, true)).toEqual([]);
    });

    it("renders a multi-line ```suggestion when the full range is added and commentable (#2141)", () => {
      const multiFiles = [{ path: "src/a.ts", payload: { patch: "@@ -1,0 +1,3 @@\n+one\n+two\n+three" } }];
      const finding: InlineFinding = {
        path: "src/a.ts",
        line: 1,
        endLine: 3,
        severity: "nit",
        body: "Replace block.",
        suggestion: "alpha\nbeta\ngamma",
      };
      const out = selectInlineComments([finding], multiFiles, true);
      expect(out).toEqual([
        {
          path: "src/a.ts",
          line: 3,
          start_line: 1,
          start_side: "RIGHT",
          side: "RIGHT",
          body: "**Nit:** Replace block.\n\n```suggestion\nalpha\nbeta\ngamma\n```",
        },
      ]);
    });

    it("downgrades to a single-line anchor when the range is only partially commentable (#2141)", () => {
      const partialFiles = [{ path: "src/a.ts", payload: { patch: "@@ -1,1 +1,2 @@\n ctx\n+added2" } }];
      const finding: InlineFinding = {
        path: "src/a.ts",
        line: 1,
        endLine: 99,
        severity: "nit",
        body: "Partial range.",
        suggestion: "fix",
      };
      const out = selectInlineComments([finding], partialFiles, true);
      expect(out).toEqual([
        { path: "src/a.ts", line: 1, side: "RIGHT", body: "**Nit:** Partial range." },
      ]);
    });

    it("strips the suggestion on a multi-line range that includes a context line (#2141)", () => {
      const mixedFiles = [{ path: "src/a.ts", payload: { patch: "@@ -1,2 +1,4 @@\n ctx\n+add2\n ctx4\n+add4" } }];
      const finding: InlineFinding = {
        path: "src/a.ts",
        line: 2,
        endLine: 3,
        severity: "nit",
        body: "Mixed range.",
        suggestion: "add2\nctx4",
      };
      const out = selectInlineComments([finding], mixedFiles, true);
      expect(out[0]).toMatchObject({
        path: "src/a.ts",
        line: 3,
        start_line: 2,
        start_side: "RIGHT",
        side: "RIGHT",
      });
      expect(out[0]?.body).toBe("**Nit:** Mixed range.");
      expect(out[0]?.body).not.toContain("```suggestion");
    });
  });

  describe("category tags (#1958 / #2149)", () => {
    const withCategory: InlineFinding = { path: "src/a.ts", line: 2, severity: "nit", body: "Use const.", category: "style" };

    it("defaults to OFF (backward compatible) — no category tag when the fourth argument is omitted", () => {
      const out = selectInlineComments([withCategory], files);
      expect(out).toEqual([{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Nit:** Use const." }]);
    });

    it("does not render a category tag when explicitly disabled, even if the finding carries one", () => {
      const out = selectInlineComments([withCategory], files, false, false);
      expect(out[0]?.body).not.toContain(" · Style");
    });

    it("renders the model's own category when enabled and the finding carries one", () => {
      const out = selectInlineComments([withCategory], files, false, true);
      expect(out[0]?.body).toBe("**Nit · Style:** Use const.");
    });

    it("falls back to the deterministic classifier when enabled but the finding has no category (safe default, never omitted)", () => {
      const noCategory: InlineFinding = { path: "src/app.test.ts", line: 2, severity: "nit", body: "Use const." };
      const out = selectInlineComments([noCategory], [fileWith("src/app.test.ts", "@@ -1,1 +1,2 @@\n ctx\n+added2")], false, true);
      expect(out[0]?.body).toBe("**Nit · Tests:** Use const.");
    });

    it("composes with a suggestion block — both the category tag and the suggestion render together", () => {
      const both: InlineFinding = { path: "src/a.ts", line: 2, severity: "blocker", body: "Missing null check.", category: "correctness", suggestion: "if (!x) return;" };
      const out = selectInlineComments([both], files, true, true);
      expect(out[0]?.body).toBe("**Blocker · Correctness:** Missing null check.\n\n```suggestion\nif (!x) return;\n```");
    });
  });

  describe("per-category cap (#2159)", () => {
    const capFiles = [fileWith("src/a.ts", "@@ -1,0 +1,6 @@\n+1\n+2\n+3\n+4\n+5\n+6")];
    const styleFindings: InlineFinding[] = Array.from({ length: 4 }, (_, index) => ({
      path: "src/a.ts",
      line: index + 1,
      severity: "nit" as const,
      body: `style-${index + 1}`,
      category: "style" as const,
    }));
    const securityFinding: InlineFinding = {
      path: "src/a.ts",
      line: 5,
      severity: "blocker",
      body: "security issue",
      category: "security",
    };

    it("defaults to byte-identical first-seen selection when perCategoryCap is omitted", () => {
      const out = selectInlineComments([...styleFindings, securityFinding], capFiles);
      expect(out.map((comment) => comment.body)).toEqual([
        "**Nit:** style-1",
        "**Nit:** style-2",
        "**Nit:** style-3",
        "**Nit:** style-4",
        "**Blocker:** security issue",
      ]);
    });

    it("limits each category and prefers blockers/security when perCategoryCap is set", () => {
      const out = selectInlineComments([...styleFindings, securityFinding], capFiles, false, false, null, 2);
      expect(out.map((comment) => comment.body)).toEqual(["**Blocker:** security issue", "**Nit:** style-1", "**Nit:** style-2"]);
    });
  });
});

describe("postInlineReviewComments (#inline-comments, fail-safe)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const files = [fileWith("src/a.ts", "@@ -1,1 +1,2 @@\n ctx\n+added2")];
  const findings: InlineFinding[] = [{ path: "src/a.ts", line: 2, severity: "nit", body: "guard this" }];
  const base = { installationId: 7, repoFullName: "acme/widgets", pullNumber: 3, files, mode: "live" as const };

  it("no-ops (no GitHub call) when nothing is anchorable, or when the head SHA is unknown", async () => {
    let fetched = false;
    vi.stubGlobal("fetch", async () => {
      fetched = true;
      return Response.json({});
    });
    expect(await postInlineReviewComments(envWithKey(), { ...base, commitId: "sha", findings: [] })).toEqual({ posted: 0 });
    expect(await postInlineReviewComments(envWithKey(), { ...base, commitId: null, findings })).toEqual({ posted: 0 });
    expect(fetched).toBe(false);
  });

  it("posts the selected comments as a single quiet COMMENT review and returns the count", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/pulls/3/reviews")) return Response.json({ id: 5 });
      return new Response("unexpected", { status: 500 });
    });
    expect(await postInlineReviewComments(envWithKey(), { ...base, commitId: "headsha", findings })).toEqual({ posted: 1 });
    expect(calls[0]?.body).toMatchObject({ event: "COMMENT", commit_id: "headsha", comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Nit:** guard this" }] });
  });

  it("swallows an API error (the gate is never affected), reports 0 posted, and surfaces it at ERROR for Sentry (#5)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("boom", { status: 500 }); // /reviews → non-2xx → octokit throws → caught
    });
    expect(await postInlineReviewComments(envWithKey(), { ...base, commitId: "headsha", findings })).toEqual({ posted: 0 });
    // The failure is now emitted at level:error so the central Sentry forwarder captures it (was an invisible warn).
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("inline_comments_post_failed") && String(c[0]).includes('"level":"error"'))).toBe(true);
    errSpy.mockRestore();
  });
});

describe("maybePostInlineComments (#inline-comments, review-path entry)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const files = [fileWith("src/a.ts", "@@ -1,1 +1,2 @@\n ctx\n+added2")];
  const findings: InlineFinding[] = [{ path: "src/a.ts", line: 2, severity: "nit", body: "guard this" }];
  const base = { installationId: 7, repoFullName: "acme/widgets", pullNumber: 3, commitId: "headsha", mode: "live" as const, inlineCommentsEnabled: true };

  it("is a no-op — it does not even load the PR files — when the review produced no findings", async () => {
    const getFiles = vi.fn(async () => files);
    let fetched = false;
    vi.stubGlobal("fetch", async () => {
      fetched = true;
      return Response.json({});
    });
    await maybePostInlineComments(envWithKey(), { ...base, aiReview: undefined, getFiles });
    await maybePostInlineComments(envWithKey(), { ...base, aiReview: { inlineFindings: undefined }, getFiles });
    await maybePostInlineComments(envWithKey(), { ...base, aiReview: { inlineFindings: [] }, getFiles });
    expect(getFiles).not.toHaveBeenCalled();
    expect(fetched).toBe(false);
  });

  it("is a no-op at the write boundary when inline comments are disabled, even with model findings", async () => {
    const getFiles = vi.fn(async () => files);
    let fetched = false;
    vi.stubGlobal("fetch", async () => {
      fetched = true;
      return Response.json({});
    });
    await maybePostInlineComments(envWithKey(), {
      ...base,
      inlineCommentsEnabled: false,
      aiReview: { inlineFindings: findings },
      getFiles,
    });
    expect(getFiles).not.toHaveBeenCalled();
    expect(fetched).toBe(false);
  });

  it("loads the PR files and posts the inline review when the review produced findings", async () => {
    const getFiles = vi.fn(async () => files);
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/pulls/3/reviews")) return Response.json({ id: 9 });
      return new Response("unexpected", { status: 500 });
    });
    await maybePostInlineComments(envWithKey(), { ...base, aiReview: { inlineFindings: findings }, getFiles });
    expect(getFiles).toHaveBeenCalledTimes(1);
    expect(calls[0]?.body).toMatchObject({ event: "COMMENT", comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Nit:** guard this" }] });
  });

  it("renders a suggested-change block end-to-end when suggestionsEnabled is threaded through (#1956)", async () => {
    const getFiles = vi.fn(async () => files);
    const withSuggestion: InlineFinding[] = [{ path: "src/a.ts", line: 2, severity: "nit", body: "guard this", suggestion: "if (x) guard();" }];
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/pulls/3/reviews")) return Response.json({ id: 10 });
      return new Response("unexpected", { status: 500 });
    });
    await maybePostInlineComments(envWithKey(), { ...base, aiReview: { inlineFindings: withSuggestion }, getFiles, suggestionsEnabled: true });
    expect(calls[0]?.body).toMatchObject({ comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Nit:** guard this\n\n```suggestion\nif (x) guard();\n```" }] });
  });

  it("omits the suggestion block end-to-end when suggestionsEnabled is not passed (default off, backward compatible)", async () => {
    const getFiles = vi.fn(async () => files);
    const withSuggestion: InlineFinding[] = [{ path: "src/a.ts", line: 2, severity: "nit", body: "guard this", suggestion: "if (x) guard();" }];
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/pulls/3/reviews")) return Response.json({ id: 11 });
      return new Response("unexpected", { status: 500 });
    });
    await maybePostInlineComments(envWithKey(), { ...base, aiReview: { inlineFindings: withSuggestion }, getFiles });
    expect(calls[0]?.body).toMatchObject({ comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Nit:** guard this" }] });
  });

  it("renders a category tag end-to-end when categoriesEnabled is threaded through (#1958)", async () => {
    const getFiles = vi.fn(async () => files);
    const withCategory: InlineFinding[] = [{ path: "src/a.ts", line: 2, severity: "nit", body: "guard this", category: "maintainability" }];
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/pulls/3/reviews")) return Response.json({ id: 12 });
      return new Response("unexpected", { status: 500 });
    });
    await maybePostInlineComments(envWithKey(), { ...base, aiReview: { inlineFindings: withCategory }, getFiles, categoriesEnabled: true });
    expect(calls[0]?.body).toMatchObject({ comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Nit · Maintainability:** guard this" }] });
  });

  it("threads perCategoryCap end-to-end when set (#2159)", async () => {
    const getFiles = vi.fn(async () => [
      fileWith("src/a.ts", "@@ -1,0 +1,4 @@\n+1\n+2\n+3\n+4"),
    ]);
    const styleFindings: InlineFinding[] = Array.from({ length: 3 }, (_, index) => ({
      path: "src/a.ts",
      line: index + 1,
      severity: "nit" as const,
      body: `style-${index + 1}`,
      category: "style" as const,
    }));
    const securityFinding: InlineFinding = { path: "src/a.ts", line: 4, severity: "blocker", body: "security", category: "security" };
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/pulls/3/reviews")) return Response.json({ id: 14 });
      return new Response("unexpected", { status: 500 });
    });
    await maybePostInlineComments(envWithKey(), {
      ...base,
      aiReview: { inlineFindings: [...styleFindings, securityFinding] },
      getFiles,
      perCategoryCap: 1,
    });
    expect(calls[0]?.body).toMatchObject({
      comments: [
        { body: "**Blocker:** security" },
        { body: "**Nit:** style-1" },
      ],
    });
  });

  it("omits the category tag end-to-end when categoriesEnabled is not passed (default off, backward compatible)", async () => {
    const getFiles = vi.fn(async () => files);
    const withCategory: InlineFinding[] = [{ path: "src/a.ts", line: 2, severity: "nit", body: "guard this", category: "maintainability" }];
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/pulls/3/reviews")) return Response.json({ id: 13 });
      return new Response("unexpected", { status: 500 });
    });
    await maybePostInlineComments(envWithKey(), { ...base, aiReview: { inlineFindings: withCategory }, getFiles });
    expect(calls[0]?.body).toMatchObject({ comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "**Nit:** guard this" }] });
  });
});
