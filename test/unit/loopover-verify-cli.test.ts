import { afterEach, describe, expect, it, vi } from "vitest";

import { contentDigest } from "@loopover/contract/digest";

// The bin's own source, imported in-process (the format-table.test.ts pattern). It is import-safe by
// construction -- it self-executes only when it is argv[1] -- so this drives the real entry point: argv
// parsing, fetch orchestration, rendering and exit code, without spawning a subprocess whose execution
// would be invisible to instrumentation.
async function loadCli() {
  return import("../../packages/loopover-mcp/bin/loopover-verify") as Promise<{
    parseBaseUrl: (args: readonly string[], fallback?: string) => { ok: true; baseUrl: string } | { ok: false; error: string };
    runVerify: (args: readonly string[], baseUrlOverride?: string) => Promise<number>;
  }>;
}

/** Capture stdout for one run rather than letting the CLI print into the test output. */
function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore(), text: () => chunks.join("") };
}

/** Serve a fixed map of path -> body; anything unmapped 404s, which is what a real deployment does for a
 *  surface it has disabled. */
function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    const body = routes[key] ?? routes[url.pathname];
    if (body === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseBaseUrl", () => {
  it("defaults, strips a trailing slash, and accepts an explicit http(s) base", async () => {
    const { parseBaseUrl } = await loadCli();
    expect(parseBaseUrl([])).toEqual({ ok: true, baseUrl: "https://api.loopover.ai" });
    expect(parseBaseUrl(["--base-url", "https://example.test/"])).toEqual({ ok: true, baseUrl: "https://example.test" });
    expect(parseBaseUrl(["--base-url", "http://localhost:8787"])).toEqual({ ok: true, baseUrl: "http://localhost:8787" });
  });

  it("rejects a missing value, a flag mistaken for a value, a non-URL, and a non-http scheme", async () => {
    const { parseBaseUrl } = await loadCli();
    expect(parseBaseUrl(["--base-url"]).ok).toBe(false);
    expect(parseBaseUrl(["--base-url", "--json"]).ok).toBe(false);
    expect(parseBaseUrl(["--base-url", "not a url"]).ok).toBe(false);
    const scheme = parseBaseUrl(["--base-url", "file:///etc/passwd"]);
    expect(scheme.ok).toBe(false);
    expect(scheme.ok === false && scheme.error).toContain("must be http(s)");
  });
});

describe("runVerify", () => {
  it("prints usage and exits 0 for --help without touching the network", async () => {
    const { runVerify } = await loadCli();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = captureStdout();
    const code = await runVerify(["--help"]);
    out.restore();
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.text()).toContain("no credentials");
  });

  it("exits 1 and marks the row FAIL when a published digest does not recompute", async () => {
    const { runVerify } = await loadCli();
    stubFetch({
      "/v1/public/eval-scores": { records: [{ subject: { id: "loopover" }, workUnit: { ruleId: "rule_a" }, score: { decided: 3 }, recordDigest: "0".repeat(64) }] },
    });
    const out = captureStdout();
    const code = await runVerify([], "https://example.test");
    out.restore();
    expect(code).toBe(1);
    expect(out.text()).toContain("FAIL");
  });

  it("exits 0 and reports PASS on a wholly consistent deployment", async () => {
    const { runVerify } = await loadCli();
    const preimage = { subject: { id: "loopover" }, workUnit: { ruleId: "rule_a" }, score: { decided: 3 }, commitments: {} };
    stubFetch({
      "/v1/public/eval-scores": { records: [{ ...preimage, recordDigest: await contentDigest(preimage) }] },
      "/v1/public/stats": { totals: { handled: 500 }, reviewParity: { verdicts: 12 } },
    });
    const out = captureStdout();
    const code = await runVerify([], "https://example.test");
    out.restore();
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("PASS");
    expect(text).not.toContain("FAIL");
  });

  it("degrades every unreachable surface to SKIP rather than failing or throwing", async () => {
    // A deployment with public stats switched off is not a deployment failing verification, and one dead
    // endpoint must not abort the claims that were still checkable.
    const { runVerify } = await loadCli();
    stubFetch({});
    const out = captureStdout();
    const code = await runVerify([], "https://example.test");
    out.restore();
    expect(code).toBe(0);
    expect(out.text()).toContain("0 passed, 0 failed, 4 skipped");
  });

  it("survives a transport-level throw, reporting it instead of crashing", async () => {
    const { runVerify } = await loadCli();
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const out = captureStdout();
    const code = await runVerify([], "https://example.test");
    out.restore();
    expect(code).toBe(0);
    expect(out.text()).toContain("SKIP");
  });

  it("emits machine-readable results under --json", async () => {
    const { runVerify } = await loadCli();
    stubFetch({ "/v1/public/stats": { totals: { handled: 5 }, reviewParity: { verdicts: 1 } } });
    const out = captureStdout();
    const code = await runVerify(["--json"], "https://example.test");
    out.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(out.text()) as { baseUrl: string; results: Array<{ id: string; status: string }>; summary: string };
    expect(parsed.baseUrl).toBe("https://example.test");
    expect(parsed.results.map((result) => result.id)).toEqual(["record-digests", "corpus-commitments", "anchor-checkpoint", "stats-parity"]);
    expect(parsed.results.find((result) => result.id === "stats-parity")?.status).toBe("pass");
  });

  it("sends no Authorization header on any request", async () => {
    // The load-bearing property of the whole tool: a verifier that needs our credentials verifies nothing.
    const { runVerify } = await loadCli();
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    });
    const out = captureStdout();
    await runVerify([], "https://example.test");
    out.restore();
    expect(seen.length).toBeGreaterThan(0);
    for (const headers of seen) expect(Object.keys(headers)).not.toContain("authorization");
  });

  it("fetches one corpus per committed rule, deduplicating repeats", async () => {
    const { runVerify } = await loadCli();
    const record = async (ruleId: string) => {
      const preimage = { workUnit: { ruleId }, score: { decided: 1 }, commitments: { corpusChecksum: "abc" } };
      return { ...preimage, recordDigest: await contentDigest(preimage) };
    };
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      // #9962: `ruleId`, the spelling the route actually reads. This assertion previously read `rule_id` --
      // the same wrong spelling the CLI was sending -- so the two agreed with each other and disagreed with
      // production, and the test passed while every real corpus fetch 400'd.
      if (url.pathname === "/v1/public/eval-corpus") requested.push(url.searchParams.get("ruleId") ?? "");
      if (url.pathname === "/v1/public/eval-scores") {
        return new Response(JSON.stringify({ records: [await record("rule_a"), await record("rule_a"), await record("rule_b")] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
    const out = captureStdout();
    await runVerify([], "https://example.test");
    out.restore();
    expect(requested.sort()).toEqual(["rule_a", "rule_b"]);
  });
});
