import { test } from "node:test";
import assert from "node:assert/strict";

import { createAnalysisContext } from "../dist/analysis-context.js";
import { boundedFetchJson, boundedFetchStatus } from "../dist/external-fetch.js";

test("boundedFetchJson aborts slow subcalls and records safe diagnostics", async () => {
  const diagnostics = {};
  const fetchImpl = async (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });

  const result = await boundedFetchJson("https://registry.example.test/private", {
    endpointCategory: "npm-packument",
    timeoutMs: 5,
    body: "sensitive request body should not be attached",
    fetchImpl,
    diagnostics,
    phase: "test-phase",
    subcall: "test-subcall",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.equal(diagnostics.partialStatus, "partial");
  assert.equal(diagnostics.partialReason, "npm-packument_timeout");
  assert.equal(diagnostics.endpointCategory, "npm-packument");
  assert.equal(diagnostics.externalFailureReason, "timeout");
  assert.equal(diagnostics.phase, "test-phase");
  assert.equal(diagnostics.subcall, "test-subcall");
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes("registry.example.test"), false);
  assert.equal(serialized.includes("sensitive request body"), false);
});

test("boundedFetchJson caps oversized responses before reading the body", async () => {
  const diagnostics = {};
  let bodyRead = false;

  const result = await boundedFetchJson("https://api.example.test/large", {
    endpointCategory: "pypi-json",
    maxBytes: 4,
    diagnostics,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "5" }),
      text: async () => {
        bodyRead = true;
        return "{}";
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "response_too_large");
  assert.equal(result.capped, true);
  assert.equal(bodyRead, false);
  assert.equal(diagnostics.capped, true);
  assert.equal(diagnostics.endpointCategory, "pypi-json");
  assert.equal(diagnostics.externalFailureReason, "response_too_large");
});

test("boundedFetchStatus checks status without reading a response body", async () => {
  const diagnostics = {};
  let bodyRead = false;
  let method = "";

  const result = await boundedFetchStatus("https://registry.example.test/pkg", {
    endpointCategory: "npm-package-status",
    diagnostics,
    fetchImpl: async (_url, init = {}) => {
      method = init.method ?? "";
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "999999999" }),
        text: async () => {
          bodyRead = true;
          return "{}";
        },
        body: {
          getReader() {
            bodyRead = true;
            throw new Error("body should not be read");
          },
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.bytes, null);
  assert.equal(method, "HEAD");
  assert.equal(bodyRead, false);
});

test("AnalysisContext fetchJson de-dupes identical in-flight calls and caps new category calls", async () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1812,
  });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ ok: true }));
  };

  const [first, second] = await Promise.all([
    context.fetchJson("https://api.osv.dev/v1/query", {
      endpointCategory: "osv-query",
      method: "POST",
      body: JSON.stringify({ id: "one" }),
      fetchImpl,
      maxCallsPerCategory: 1,
    }),
    context.fetchJson("https://api.osv.dev/v1/query", {
      endpointCategory: "osv-query",
      method: "POST",
      body: JSON.stringify({ id: "one" }),
      fetchImpl,
      maxCallsPerCategory: 1,
    }),
  ]);

  assert.equal(first.ok, true);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  assert.deepEqual(context.snapshotMetrics().externalCallsByCategory, {
    "osv-query": 1,
  });
  assert.equal(context.snapshotMetrics().cacheMisses, 1);
  assert.equal(context.snapshotMetrics().cacheHits, 1);

  const cappedDiagnostics = {};
  const capped = await context.fetchJson("https://api.osv.dev/v1/query", {
    endpointCategory: "osv-query",
    method: "POST",
    body: JSON.stringify({ id: "two" }),
    fetchImpl,
    maxCallsPerCategory: 1,
    diagnostics: cappedDiagnostics,
  });

  assert.equal(capped.ok, false);
  assert.equal(capped.reason, "call_cap");
  assert.equal(calls, 1);
  assert.deepEqual(context.snapshotMetrics().cappedWorkByCategory, {
    "osv-query_calls": 1,
  });
  assert.equal(cappedDiagnostics.partialReason, "osv-query_call_cap");
});
