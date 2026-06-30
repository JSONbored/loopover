import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BODY_BYTES,
  parseEnrichRequestBody,
  readEnrichRequestText,
} from "../dist/request-guardrails.js";

test("parseEnrichRequestBody accepts a minimal valid enrichment request", () => {
  const result = parseEnrichRequestBody(
    JSON.stringify({
      repoFullName: "JSONbored/gittensory",
      prNumber: 1814,
      files: [{ path: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+export const a = 1;" }],
    }),
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.repoFullName, "JSONbored/gittensory");
    assert.equal(result.payload.prNumber, 1814);
    assert.ok(result.bodyBytes > 0);
  }
});

test("parseEnrichRequestBody rejects malformed JSON and invalid shallow schema", () => {
  const malformed = parseEnrichRequestBody("{not json");
  assert.deepEqual(malformed, {
    ok: false,
    status: 400,
    error: "bad_json",
    bodyBytes: 9,
  });

  const badSchema = parseEnrichRequestBody(JSON.stringify({ repoFullName: "bad", prNumber: 0 }));
  assert.equal(badSchema.ok, false);
  if (!badSchema.ok) {
    assert.equal(badSchema.status, 400);
    assert.equal(badSchema.error, "bad_request");
  }
});

test("parseEnrichRequestBody rejects oversized body, file list, diff, and patch payloads", () => {
  const hugeBody = parseEnrichRequestBody("x".repeat(2 * 1024 * 1024 + 1));
  assert.equal(hugeBody.ok, false);
  if (!hugeBody.ok) {
    assert.equal(hugeBody.status, 413);
    assert.equal(hugeBody.error, "request_too_large");
  }

  const tooManyFiles = parseEnrichRequestBody(
    JSON.stringify({
      repoFullName: "JSONbored/gittensory",
      prNumber: 1814,
      files: Array.from({ length: 301 }, (_, index) => ({ path: `src/${index}.ts` })),
    }),
  );
  assert.equal(tooManyFiles.ok, false);
  if (!tooManyFiles.ok) assert.equal(tooManyFiles.error, "too_many_files");

  const hugeDiff = parseEnrichRequestBody(
    JSON.stringify({
      repoFullName: "JSONbored/gittensory",
      prNumber: 1814,
      diff: "x".repeat(1_000_001),
    }),
  );
  assert.equal(hugeDiff.ok, false);
  if (!hugeDiff.ok) assert.equal(hugeDiff.error, "diff_too_large");

  const hugePatch = parseEnrichRequestBody(
    JSON.stringify({
      repoFullName: "JSONbored/gittensory",
      prNumber: 1814,
      files: [{ path: "src/a.ts", patch: "x".repeat(1_500_001) }],
    }),
  );
  assert.equal(hugePatch.ok, false);
  if (!hugePatch.ok) assert.equal(hugePatch.error, "patches_too_large");
});

test("readEnrichRequestText rejects an oversized Content-Length without reading the body", async () => {
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([123]));
      controller.close();
    },
  });
  const request = new Request("https://rees.example/v1/enrich", {
    method: "POST",
    headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    body,
    duplex: "half",
  } as RequestInit);

  const result = await readEnrichRequestText(request);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 413);
    assert.equal(result.error, "request_too_large");
    assert.equal(result.bodyBytes, MAX_BODY_BYTES + 1);
  }
  assert.equal(request.bodyUsed, false);
});

test("readEnrichRequestText stops streaming once the request body exceeds the cap", async () => {
  let pulls = 0;
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (pulls > 5) controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  const request = new Request("https://rees.example/v1/enrich", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);

  const result = await readEnrichRequestText(request);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 413);
    assert.equal(result.error, "request_too_large");
    assert.ok(result.bodyBytes > MAX_BODY_BYTES);
  }
  assert.equal(canceled, true);
  assert.ok(pulls < 6);
});

test("readEnrichRequestText returns a small request body", async () => {
  const raw = JSON.stringify({ repoFullName: "JSONbored/gittensory", prNumber: 1836 });
  const request = new Request("https://rees.example/v1/enrich", {
    method: "POST",
    body: raw,
  });

  const result = await readEnrichRequestText(request);

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.raw, raw);
    assert.equal(result.bodyBytes, new TextEncoder().encode(raw).byteLength);
  }
});
