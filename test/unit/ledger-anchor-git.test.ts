import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import { buildAnchorLogLine, submitToGitAnchor, type GitHubContentsRequester } from "../../src/review/ledger-anchor-git";
import { buildLedgerAnchorPayload, canonicalJson, type SignedLedgerAnchor } from "../../src/review/ledger-anchor";
import { loadPublicLedgerAnchors } from "../../src/review/ledger-anchor-persistence";

// #9273 (epic #9267). octokit is ALWAYS injected -- never a real GitHub write. The property under test is
// this module's own append/error/persistence logic, exercised against a scripted GitHubContentsRequester.

const TARGET = { owner: "acme", repo: "loopover-anchors", branch: "main", path: "anchors.jsonl" };

function makeSignedAnchor(seq = 1): SignedLedgerAnchor {
  return { payload: buildLedgerAnchorPayload({ seq, rowHash: "a".repeat(64), totalCount: seq }, "2026-07-27T12:00:00.000Z"), signature: "c2ln", keyId: "key1" };
}

function decodeBase64(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

describe("buildAnchorLogLine (#9273)", () => {
  it("commits the SAME canonicalized payload and signature as the Rekor backend anchors -- the two never diverge", () => {
    const signed = makeSignedAnchor();
    const line = buildAnchorLogLine(signed);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ payload: JSON.parse(canonicalJson(signed.payload)), signature: signed.signature, keyId: signed.keyId });
  });
});

describe("submitToGitAnchor (#9273)", () => {
  it("creates the file on first anchor ever (no prior sha to compare-and-swap against)", async () => {
    const env = createTestEnv();
    const signed = makeSignedAnchor(1);
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route.startsWith("GET")) {
        const error = new Error("Not Found") as Error & { status: number };
        error.status = 404;
        throw error;
      }
      expect(params["sha"]).toBeUndefined(); // no sha on a brand-new file
      expect(decodeBase64(params["content"] as string)).toBe(buildAnchorLogLine(signed));
      return { data: { commit: { sha: "deadbeef1" } } };
    });

    await submitToGitAnchor(env, signed, { request } as GitHubContentsRequester, TARGET);

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]).toMatchObject({
      seq: 1,
      backend: "git",
      status: "ok",
      backendRef: { owner: "acme", repo: "loopover-anchors", branch: "main", path: "anchors.jsonl", sha: "deadbeef1" },
    });
  });

  it("APPENDS to existing content rather than overwriting it, using the existing sha as a compare-and-swap guard", async () => {
    const env = createTestEnv();
    const signed = makeSignedAnchor(2);
    const priorLine = '{"prior":"entry"}\n';
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route.startsWith("GET")) return { data: { content: Buffer.from(priorLine).toString("base64"), sha: "old-sha" } };
      expect(params["sha"]).toBe("old-sha");
      expect(decodeBase64(params["content"] as string)).toBe(priorLine + buildAnchorLogLine(signed));
      return { data: { commit: { sha: "newsha2" } } };
    });

    await submitToGitAnchor(env, signed, { request } as GitHubContentsRequester, TARGET);

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]?.backendRef).toMatchObject({ sha: "newsha2" });
  });

  it("treats a GET response with a sha but no inline content (GitHub omits it for files >1MB) as empty existing content, not a crash", async () => {
    const env = createTestEnv();
    const signed = makeSignedAnchor(9);
    const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
      if (route.startsWith("GET")) return { data: { sha: "large-file-sha" } }; // no `content` field
      expect(params["sha"]).toBe("large-file-sha"); // still used for compare-and-swap
      expect(decodeBase64(params["content"] as string)).toBe(buildAnchorLogLine(signed)); // not prefixed with garbage
      return { data: { commit: { sha: "afterlarge" } } };
    });

    await submitToGitAnchor(env, signed, { request } as GitHubContentsRequester, TARGET);
    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]).toMatchObject({ status: "ok", backendRef: { sha: "afterlarge" } });
  });

  it("records status:'failed' (with the real error, not a thrown one) on a rate-limit / auth error", async () => {
    const env = createTestEnv();
    const signed = makeSignedAnchor(3);
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET")) {
        const error = new Error("Not Found") as Error & { status: number };
        error.status = 404;
        throw error;
      }
      const error = new Error("API rate limit exceeded") as Error & { status: number };
      error.status = 403;
      throw error;
    });

    await expect(submitToGitAnchor(env, signed, { request } as GitHubContentsRequester, TARGET)).resolves.toBeUndefined();

    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]).toMatchObject({ backend: "git", status: "failed", error: "API rate limit exceeded" });
  });

  it("records status:'failed' when a non-404 GET error occurs (never conflated with 'file does not exist yet')", async () => {
    const env = createTestEnv();
    const signed = makeSignedAnchor(4);
    const request = vi.fn(async () => {
      const error = new Error("Server Error") as Error & { status: number };
      error.status = 500;
      throw error;
    });

    await submitToGitAnchor(env, signed, { request } as GitHubContentsRequester, TARGET);
    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]).toMatchObject({ status: "failed", error: "Server Error" });
  });

  it("records status:'failed' if the PUT response is missing a commit sha", async () => {
    const env = createTestEnv();
    const signed = makeSignedAnchor(5);
    const request = vi.fn(async (route: string) => {
      if (route.startsWith("GET")) {
        const error = new Error("Not Found") as Error & { status: number };
        error.status = 404;
        throw error;
      }
      return { data: {} }; // no commit.sha
    });

    await submitToGitAnchor(env, signed, { request } as GitHubContentsRequester, TARGET);
    const { anchors } = await loadPublicLedgerAnchors(env);
    expect(anchors[0]).toMatchObject({ status: "failed", error: "GitHub Contents API response did not include a commit sha" });
  });

  it("never throws past the caller, whatever the failure", async () => {
    const env = createTestEnv();
    const signed = makeSignedAnchor(6);
    const request = vi.fn(async () => {
      throw new Error("anything");
    });
    await expect(submitToGitAnchor(env, signed, { request } as GitHubContentsRequester, TARGET)).resolves.toBeUndefined();
  });
});
