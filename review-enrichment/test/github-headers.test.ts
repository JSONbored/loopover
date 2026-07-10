import assert from "node:assert/strict";
import { test } from "node:test";

import { githubHeaders } from "../dist/github-headers.js";

test("githubHeaders defaults to the structured-JSON Accept media type", () => {
  const headers = githubHeaders("tok_abc123");
  assert.deepEqual(headers, {
    Authorization: "Bearer tok_abc123",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "gittensory-review-enrichment",
  });
});

test("githubHeaders with no opts argument matches an explicit raw:false", () => {
  assert.deepEqual(githubHeaders("tok_abc123"), githubHeaders("tok_abc123", { raw: false }));
});

test("githubHeaders switches Accept to the raw media type when opts.raw is true", () => {
  const headers = githubHeaders("tok_abc123", { raw: true });
  assert.deepEqual(headers, {
    Authorization: "Bearer tok_abc123",
    Accept: "application/vnd.github.raw",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "gittensory-review-enrichment",
  });
});

test("githubHeaders with an empty opts object behaves like the default (JSON)", () => {
  assert.deepEqual(githubHeaders("tok_abc123", {}), githubHeaders("tok_abc123"));
});

test("githubHeaders always embeds the caller's token verbatim in the Bearer value", () => {
  assert.equal(githubHeaders("ghs_anotherToken999").Authorization, "Bearer ghs_anotherToken999");
});
