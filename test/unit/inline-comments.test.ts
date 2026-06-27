import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { InlineFinding } from "../../src/services/ai-review";
import { isInlineCommentsEnabled, maybePostInlineComments, postInlineReviewComments, rightSideLinesFromPatch, selectInlineComments, shouldRequestInlineFindings } from "../../src/review/inline-comments";
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

  it("caps the output at 10 comments", () => {
    const bigPatch = "@@ -1,0 +1,12 @@\n" + Array.from({ length: 12 }, (_, i) => `+line${i + 1}`).join("\n");
    const bigFiles = [{ path: "src/big.ts", payload: { patch: bigPatch } }];
    const many: InlineFinding[] = Array.from({ length: 12 }, (_, i) => ({ path: "src/big.ts", line: i + 1, severity: "nit", body: `b${i + 1}` }));
    expect(selectInlineComments(many, bigFiles)).toHaveLength(10);
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

  it("swallows an API error (the gate is never affected) and reports 0 posted", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/access_tokens")) return Response.json({ token: "t" });
      return new Response("boom", { status: 500 }); // /reviews → non-2xx → octokit throws → caught
    });
    expect(await postInlineReviewComments(envWithKey(), { ...base, commitId: "headsha", findings })).toEqual({ posted: 0 });
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
});
