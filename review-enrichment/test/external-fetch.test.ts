import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createAnalysisContext } from "../dist/analysis-context.js";
import {
  boundedFetchJson,
  boundedFetchStatus,
  boundedFetchText,
  resetExternalFetchCircuitBreakerForTest,
} from "../dist/external-fetch.js";

beforeEach(() => {
  resetExternalFetchCircuitBreakerForTest();
});

afterEach(() => {
  resetExternalFetchCircuitBreakerForTest();
  mock.timers.reset();
});

test("boundedFetchJson aborts slow subcalls and records safe diagnostics", async () => {
  const diagnostics = {};
  const fetchImpl = async (_url, init = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        {
          once: true,
        },
      );
    });

  const result = await boundedFetchJson(
    "https://registry.example.test/private",
    {
      endpointCategory: "npm-packument",
      timeoutMs: 5,
      body: "sensitive request body should not be attached",
      fetchImpl,
      diagnostics,
      phase: "test-phase",
      subcall: "test-subcall",
    },
  );

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

test("circuit breaker: a healthy endpoint never opens the circuit", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };

  for (let index = 0; index < 10; index += 1) {
    const result = await boundedFetchText("https://api.example.test/healthy", {
      endpointCategory: "npm-version",
      fetchImpl,
    });
    assert.equal(result.ok, true);
  }

  assert.equal(calls, 10);
});

test("circuit breaker: opens after threshold consecutive network errors and skips the underlying fetch during cooldown", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("connection refused");
  };

  for (let index = 0; index < 3; index += 1) {
    const result = await boundedFetchText("https://api.example.test/down", {
      endpointCategory: "osv-query",
      fetchImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "network_error");
  }
  assert.equal(calls, 3);

  const openResult = await boundedFetchText("https://api.example.test/down", {
    endpointCategory: "osv-query",
    fetchImpl,
  });
  assert.equal(openResult.ok, false);
  assert.equal(openResult.reason, "circuit_open");
  assert.equal(openResult.elapsedMs, 0);
  assert.equal(
    calls,
    3,
    "underlying fetchImpl must not be invoked while the circuit is open",
  );
});

test("circuit breaker: opens after threshold consecutive 500s and attaches circuit_open diagnostics", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("boom", { status: 500 });
  };

  for (let index = 0; index < 3; index += 1) {
    const result = await boundedFetchText("https://api.example.test/500s", {
      endpointCategory: "pypi-json",
      fetchImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "http_error");
  }

  const diagnostics = {};
  const openResult = await boundedFetchText("https://api.example.test/500s", {
    endpointCategory: "pypi-json",
    fetchImpl,
    diagnostics,
  });
  assert.equal(openResult.ok, false);
  assert.equal(openResult.reason, "circuit_open");
  assert.equal(calls, 3);
  assert.equal(diagnostics.externalFailureReason, "circuit_open");
  assert.equal(diagnostics.partialStatus, "partial");
  assert.equal(diagnostics.endpointCategory, "pypi-json");
});

test("circuit breaker: recovers after the default cooldown elapses", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls <= 3) throw new Error("connection refused");
      return new Response("{}", { status: 200 });
    };

    for (let index = 0; index < 3; index += 1) {
      const result = await boundedFetchText(
        "https://api.example.test/recovers",
        {
          endpointCategory: "pypi-json",
          fetchImpl,
        },
      );
      assert.equal(result.ok, false);
    }
    assert.equal(calls, 3);

    const stillOpen = await boundedFetchText(
      "https://api.example.test/recovers",
      {
        endpointCategory: "pypi-json",
        fetchImpl,
      },
    );
    assert.equal(stillOpen.reason, "circuit_open");
    assert.equal(calls, 3);

    // Advance past the 30s default cooldown window.
    mock.timers.tick(30_001);

    const recovered = await boundedFetchText(
      "https://api.example.test/recovers",
      {
        endpointCategory: "pypi-json",
        fetchImpl,
      },
    );
    assert.equal(recovered.ok, true);
    assert.equal(
      calls,
      4,
      "the real fetchImpl must be reached again after cooldown",
    );
  } finally {
    mock.timers.reset();
  }
});

test("circuit breaker: bundlephobia-size gets a longer 60s cooldown, not the 30s default", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls <= 3) throw new Error("connection refused");
      return new Response("{}", { status: 200 });
    };

    for (let index = 0; index < 3; index += 1) {
      const result = await boundedFetchText(
        "https://api.example.test/bundlephobia-recovers",
        {
          endpointCategory: "bundlephobia-size",
          fetchImpl,
        },
      );
      assert.equal(result.ok, false);
    }
    assert.equal(calls, 3);

    // Advance past the 30s default — bundlephobia-size's own 60s cooldown must still be open.
    mock.timers.tick(30_001);
    const stillOpenAt30s = await boundedFetchText(
      "https://api.example.test/bundlephobia-recovers",
      {
        endpointCategory: "bundlephobia-size",
        fetchImpl,
      },
    );
    assert.equal(stillOpenAt30s.reason, "circuit_open");
    assert.equal(calls, 3, "the 60s category cooldown must not recover early at 30s");

    // Advance the remaining 30s past the 60s category-specific cooldown.
    mock.timers.tick(30_000);
    const recovered = await boundedFetchText(
      "https://api.example.test/bundlephobia-recovers",
      {
        endpointCategory: "bundlephobia-size",
        fetchImpl,
      },
    );
    assert.equal(recovered.ok, true);
    assert.equal(
      calls,
      4,
      "the real fetchImpl must be reached again after the 60s category cooldown",
    );
  } finally {
    mock.timers.reset();
  }
});

test("circuit breaker regression: repeated plain 404s never trip the breaker (typosquat candidate lookups)", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 404 });
  };

  for (let index = 0; index < 10; index += 1) {
    const result = await boundedFetchStatus(
      "https://registry.example.test/candidate",
      {
        endpointCategory: "npm-attestations",
        fetchImpl,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "http_error");
    assert.equal(result.status, 404);
  }

  // The Nth+1 call must still reach the real fetchImpl, not a circuit_open skip.
  assert.equal(calls, 10);
  const stillReal = await boundedFetchStatus(
    "https://registry.example.test/candidate",
    {
      endpointCategory: "npm-attestations",
      fetchImpl,
    },
  );
  assert.equal(stillReal.reason, "http_error");
  assert.equal(calls, 11);
});

test("circuit breaker regression: repeated aborted results never trip the breaker", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  };

  for (let index = 0; index < 10; index += 1) {
    const controller = new AbortController();
    controller.abort();
    const result = await boundedFetchText("https://api.example.test/aborted", {
      endpointCategory: "deps-dev",
      signal: controller.signal,
      fetchImpl,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "aborted");
  }

  // fetchImpl was never reached (caller-aborted before dispatch), and the
  // circuit is still closed: a normal call goes through to the real fetch.
  assert.equal(calls, 0);
  const normal = await boundedFetchText("https://api.example.test/aborted", {
    endpointCategory: "deps-dev",
    fetchImpl,
  });
  assert.equal(normal.ok, true);
  assert.equal(calls, 1);
});

test("circuit breaker: boundedFetchStatus and boundedFetchText/Json share one circuit per endpointCategory", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("connection refused");
  };

  // Trip the breaker via boundedFetchStatus.
  for (let index = 0; index < 3; index += 1) {
    const result = await boundedFetchStatus("https://api.example.test/shared", {
      endpointCategory: "github-commits",
      fetchImpl,
    });
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 3);

  // A subsequent boundedFetchJson call for the same category is short-circuited.
  const jsonResult = await boundedFetchJson("https://api.example.test/shared", {
    endpointCategory: "github-commits",
    fetchImpl,
  });
  assert.equal(jsonResult.ok, false);
  assert.equal(jsonResult.reason, "circuit_open");
  assert.equal(
    calls,
    3,
    "boundedFetchJson must not invoke fetchImpl while the shared circuit is open",
  );

  // And vice versa: reset, trip via boundedFetchJson (through boundedFetchText), confirm
  // boundedFetchStatus for the same category is short-circuited too.
  resetExternalFetchCircuitBreakerForTest();
  calls = 0;
  for (let index = 0; index < 3; index += 1) {
    const result = await boundedFetchJson("https://api.example.test/shared-2", {
      endpointCategory: "github-heavy-shared",
      fetchImpl,
    });
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 3);

  const statusResult = await boundedFetchStatus(
    "https://api.example.test/shared-2",
    {
      endpointCategory: "github-heavy-shared",
      fetchImpl,
    },
  );
  assert.equal(statusResult.ok, false);
  assert.equal(statusResult.reason, "circuit_open");
  assert.equal(calls, 3);
});

test("circuit breaker: two different endpointCategory values never cross-contaminate", async () => {
  let failingCalls = 0;
  const failingFetch = async () => {
    failingCalls += 1;
    throw new Error("connection refused");
  };
  let healthyCalls = 0;
  const healthyFetch = async () => {
    healthyCalls += 1;
    return new Response("{}", { status: 200 });
  };

  for (let index = 0; index < 3; index += 1) {
    const result = await boundedFetchText("https://api.example.test/failing", {
      endpointCategory: "endoflife",
      fetchImpl: failingFetch,
    });
    assert.equal(result.ok, false);
  }
  assert.equal(failingCalls, 3);

  const openResult = await boundedFetchText(
    "https://api.example.test/failing",
    {
      endpointCategory: "endoflife",
      fetchImpl: failingFetch,
    },
  );
  assert.equal(openResult.reason, "circuit_open");

  // The unrelated category is unaffected and still reaches the real fetch.
  const unaffected = await boundedFetchText(
    "https://api.example.test/healthy",
    {
      endpointCategory: "pypi-simple",
      fetchImpl: healthyFetch,
    },
  );
  assert.equal(unaffected.ok, true);
  assert.equal(healthyCalls, 1);
});

test("resetExternalFetchCircuitBreakerForTest clears circuit state between tests", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("connection refused");
  };

  for (let index = 0; index < 3; index += 1) {
    await boundedFetchText("https://api.example.test/leak-check", {
      endpointCategory: "npm-version-leak-check",
      fetchImpl,
    });
  }
  const open = await boundedFetchText("https://api.example.test/leak-check", {
    endpointCategory: "npm-version-leak-check",
    fetchImpl,
  });
  assert.equal(open.reason, "circuit_open");

  resetExternalFetchCircuitBreakerForTest();

  const afterReset = await boundedFetchText(
    "https://api.example.test/leak-check",
    {
      endpointCategory: "npm-version-leak-check",
      fetchImpl,
    },
  );
  // After a full reset, the circuit is closed again: this call reaches the
  // real (failing) fetchImpl rather than being short-circuited.
  assert.equal(afterReset.reason, "network_error");
  assert.equal(calls, 4);
});
