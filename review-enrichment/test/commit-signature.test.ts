// Units for the commit-signature / verified-author provenance analyzer (#1517). Kept in its own file (not
// enrichment.test.ts) so concurrent analyzer PRs don't collide on a shared test file. Runs against the
// compiled dist/. All network is mocked — nothing here touches GitHub, so it never flakes offline/in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchHeadCommit,
  hasVerifiedHistory,
  scanCommitSignature,
} from "../dist/analyzers/commit-signature.js";
import { renderBrief } from "../dist/render.js";

// A minimal Response-like shape (ok + status + json), matching the other analyzer tests.
const jsonResponse = (body, code = 200) => ({
  ok: code >= 200 && code < 300,
  status: code,
  json: async () => body,
});

// Base request: a head commit on a well-formed repo slug with a broker token present.
const req = (overrides = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  headSha: "deadbeef",
  githubToken: "ghp_test",
  ...overrides,
});

// A fetch router: returns the head-commit payload for the commits/{sha} URL, and history payloads for the
// commits?author / repo-wide commits list URLs. `authorHistory`/`repoHistory` are arrays of {verified} booleans.
const routedFetch = ({ head, authorHistory, repoHistory }) =>
  async (url) => {
    if (/\/commits\/[^/?]+$/.test(url)) return jsonResponse(head);
    const toCommits = (verifiedFlags) =>
      verifiedFlags.map((verified) => ({ commit: { verification: { verified } } }));
    if (url.includes("author="))
      return jsonResponse(toCommits(authorHistory ?? []));
    return jsonResponse(toCommits(repoHistory ?? []));
  };

const verifiedHead = (login = "octo") => ({
  commit: { verification: { verified: true, reason: "valid" } },
  author: { login },
  committer: { login },
});

const throwingFetch = async () => {
  throw new Error("network down");
};

test("fetchHeadCommit returns the payload on 200, null on a non-200 or error", async () => {
  const head = verifiedHead();
  const ok = await fetchHeadCommit("o", "r", "sha", {}, async () => jsonResponse(head));
  assert.deepEqual(ok, head);
  assert.equal(await fetchHeadCommit("o", "r", "sha", {}, async () => jsonResponse({}, 404)), null);
  assert.equal(await fetchHeadCommit("o", "r", "sha", {}, throwingFetch), null);
  assert.equal(await fetchHeadCommit("o", "r", "sha", {}, async () => jsonResponse(head), AbortSignal.abort()), null);
});

test("hasVerifiedHistory: true/false on a definitive page, null otherwise", async () => {
  const page = (flags) => async () => jsonResponse(flags.map((v) => ({ commit: { verification: { verified: v } } })));
  assert.equal(await hasVerifiedHistory("o", "r", {}, page([true, false])), true);
  assert.equal(await hasVerifiedHistory("o", "r", {}, page([false, false])), false);
  assert.equal(await hasVerifiedHistory("o", "r", {}, async () => jsonResponse([], 500)), null);
  assert.equal(await hasVerifiedHistory("o", "r", {}, async () => jsonResponse({ message: "x" })), null); // not an array
  assert.equal(await hasVerifiedHistory("o", "r", {}, throwingFetch), null);
});

test("scanCommitSignature: a verified head with a matching author yields no finding", async () => {
  const findings = await scanCommitSignature(
    req(),
    routedFetch({ head: verifiedHead(), authorHistory: [true], repoHistory: [true] }),
  );
  assert.deepEqual(findings, []);
});

test("scanCommitSignature: an unsigned head is flagged with its reason", async () => {
  const head = {
    commit: { verification: { verified: false, reason: "unsigned" } },
    author: { login: "octo" },
    committer: { login: "octo" },
  };
  // Author already has verified history → not a new committer; the finding is the unverified signature itself.
  const findings = await scanCommitSignature(
    req(),
    routedFetch({ head, authorHistory: [true], repoHistory: [true] }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].verified, false);
  assert.equal(findings[0].reason, "unsigned");
  assert.equal(findings[0].authorMismatch, false);
  assert.equal(findings[0].newCommitter, false);
  assert.equal(findings[0].authorLogin, "octo");
});

test("scanCommitSignature: an author/committer login mismatch is flagged even when verified", async () => {
  const head = {
    commit: { verification: { verified: true, reason: "valid" } },
    author: { login: "octo" },
    committer: { login: "someone-else" },
  };
  const findings = await scanCommitSignature(
    req(),
    routedFetch({ head, authorHistory: [true], repoHistory: [true] }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].authorMismatch, true);
  assert.equal(findings[0].verified, true);
});

test("scanCommitSignature: a new committer in a repo with verified history is flagged", async () => {
  const head = {
    commit: { verification: { verified: false, reason: "unsigned" } },
    author: { login: "newcomer" },
    committer: { login: "newcomer" },
  };
  const findings = await scanCommitSignature(
    req(),
    // author has no verified commits, but the repo otherwise does → impersonation signal.
    routedFetch({ head, authorHistory: [false], repoHistory: [true] }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].newCommitter, true);
});

test("scanCommitSignature: an unverified head in a repo with NO verified history is not a new-committer signal", async () => {
  const head = {
    commit: { verification: { verified: false, reason: "unsigned" } },
    author: { login: "newcomer" },
    committer: { login: "newcomer" },
  };
  const findings = await scanCommitSignature(
    req(),
    routedFetch({ head, authorHistory: [false], repoHistory: [false] }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].newCommitter, false); // unsigned, but not impersonation
  assert.equal(findings[0].verified, false);
});

test("scanCommitSignature fails safe without a token or head SHA", async () => {
  assert.deepEqual(await scanCommitSignature(req({ githubToken: undefined }), throwingFetch), []);
  assert.deepEqual(await scanCommitSignature(req({ headSha: undefined }), throwingFetch), []);
});

test("scanCommitSignature fails closed on a malformed repo slug WITHOUT any network call", async () => {
  // A spy that records invocation: a malformed slug must be rejected BEFORE any GitHub request, so the guard
  // can never query the wrong repository. (A throwing fetch would be swallowed by the analyzer's fail-safe
  // try/catch and could mask a slug that slipped through, so assert the call never happens instead.)
  for (const repoFullName of ["not-a-slug", "o/r/extra", "/r", "o/", "a/b/c/d"]) {
    let called = false;
    const spyFetch: typeof fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    assert.deepEqual(await scanCommitSignature(req({ repoFullName }), spyFetch), [], `${repoFullName} must yield no finding`);
    assert.equal(called, false, `${repoFullName} must not trigger any GitHub request`);
  }
});

test("scanCommitSignature fails safe when the head fetch throws or returns no commit", async () => {
  assert.deepEqual(await scanCommitSignature(req(), throwingFetch), []);
  assert.deepEqual(await scanCommitSignature(req(), async () => jsonResponse({})), []);
});

test("scanCommitSignature stops on an already-aborted signal", async () => {
  const findings = await scanCommitSignature(req(), routedFetch({ head: verifiedHead() }), {
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(findings, []);
});

test("renderBrief emits a public-safe commit-signature block", () => {
  const { promptSection } = renderBrief({
    commitSignature: [
      {
        verified: false,
        reason: "unsigned",
        authorLogin: "newcomer",
        authorMismatch: true,
        newCommitter: true,
      },
    ],
  });
  assert.match(promptSection, /Head-commit signature \/ author provenance/);
  assert.match(promptSection, /signature \*\*unverified\*\*/);
  assert.match(promptSection, /unsigned/);
  assert.match(promptSection, /author and committer logins differ/);
  assert.match(promptSection, /no verified history/);
  assert.match(promptSection, /newcomer/);
  // Public-safe: no token, email, or local path ever appears in the rendered block.
  assert.equal(promptSection.includes("ghp_"), false);
  assert.equal(promptSection.includes("@"), false);
});
