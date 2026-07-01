// Units for the CODEOWNERS analyzer (#1515). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanCodeowners } from "../dist/analyzers/codeowners.js";

const req = (overrides: Record<string, unknown> = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  githubToken: "ghp_test",
  author: "alice",
  files: [{ path: "src/a.ts" }],
  ...overrides,
});

test("scanCodeowners: rejects multi-segment repo slugs without fetching", async () => {
  let called = false;
  const out = await scanCodeowners(
    req({ repoFullName: "octo/repo/extra" }),
    async () => {
      called = true;
      return new Response("* @bob\n", { status: 200 });
    },
  );
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("scanCodeowners: requires token, author, and a valid owner/repo slug", async () => {
  let called = false;
  const fetch = async () => {
    called = true;
    return new Response("* @bob\n", { status: 200 });
  };
  assert.deepEqual(await scanCodeowners(req({ githubToken: undefined }), fetch), []);
  assert.deepEqual(await scanCodeowners(req({ author: undefined }), fetch), []);
  assert.deepEqual(await scanCodeowners(req({ repoFullName: "bad slug/x!" }), fetch), []);
  assert.equal(called, false);
});

test("scanCodeowners: fetches CODEOWNERS for a canonical owner/repo slug", async () => {
  let url = "";
  const out = await scanCodeowners(req(), async (input) => {
    url = String(input);
    return new Response("* @alice\n", { status: 200 });
  });
  assert.match(url, /\/repos\/octo\/repo\/contents\//);
  assert.deepEqual(out, []);
});

test("scanCodeowners: reports files where the author is not listed as an owner", async () => {
  const out = await scanCodeowners(req({ author: "alice" }), async () =>
    new Response("src/a.ts @bob\n", { status: 200 }),
  );
  assert.deepEqual(out, [{ file: "src/a.ts", owners: ["@bob"] }]);
});
