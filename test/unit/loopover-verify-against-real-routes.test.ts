import { describe, expect, it, vi, afterEach } from "vitest";

import { createApp } from "../../src/api/routes";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import { PUBLIC_PRECISION_MIN_DECIDED } from "../../src/review/public-rule-precision";
import { createTestEnv } from "../helpers/d1";

// #9962: the verifier and the API, wired to each other, with NOTHING in between.
//
// The defect this file exists to make impossible: `loopover-verify` asked for
// `/v1/public/eval-corpus?rule_id=…` while the route has only ever read `?ruleId=`. Every corpus fetch 400'd,
// every commitment went unrehashed, and the tool reported "1 commitment(s) published, but no corresponding
// corpus is downloadable" against a deployment that was serving a complete, correct, matching corpus the whole
// time. A published verifier that cannot verify a healthy deployment is worse than no verifier: it manufactures
// evidence against us, and it did so for as long as it did because BOTH SIDES WERE INDIVIDUALLY TESTED AND
// INDIVIDUALLY CORRECT. The route's tests called the route with the spelling the route wanted; the CLI's tests
// stubbed `fetch` with a fixture map keyed on pathname, which threw the query string away -- so the one thing
// that was broken was the one thing neither suite looked at.
//
// So this suite deliberately owns no fixtures. `fetch` is pointed straight at the real Hono app over a real
// migrated D1, and the REAL `runVerify` drives it: its own URL construction, its own query parameters, its own
// recomputation of every commitment. Any future disagreement about a parameter name, a response field, or a
// status code fails here, because the only oracle is "did the shipped tool actually verify the shipped API".
const RULE_ID = "ai_consensus_defect";
const BASE_URL = "http://routes.test";

async function loadCli() {
  return import("../../packages/loopover-mcp/bin/loopover-verify") as Promise<{
    runVerify: (args: readonly string[], baseUrlOverride?: string) => Promise<number>;
  }>;
}

/** Point global `fetch` at the real app. The URL is decomposed exactly the way an HTTP server would see it --
 *  path AND query preserved -- because the query string is precisely what the old fixture stub discarded. */
function routeFetchTo(env: Env): void {
  const app = createApp();
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    return app.request(`${url.pathname}${url.search}`, {}, env);
  });
}

/** Enough decided cases for the rule to clear PUBLIC_PRECISION_MIN_DECIDED, so it reaches the precision block
 *  and therefore gets a published record with a commitment to check. */
async function seedDecidedRule(env: Env, ruleId: string): Promise<void> {
  const store = createSignalStore(env);
  const now = Date.now();
  for (let i = 0; i < PUBLIC_PRECISION_MIN_DECIDED + 2; i += 1) {
    await store.recordRuleFired({
      ruleId,
      targetKey: `acme/widgets#${i + 1}`,
      outcome: "close",
      occurredAt: new Date(now - (i + 2) * 1000).toISOString(),
      metadata: { confidence: 0.3 + (i % 4) * 0.15 },
    });
    await store.recordHumanOverride({
      ruleId,
      targetKey: `acme/widgets#${i + 1}`,
      verdict: i % 3 === 0 ? "reversed" : "confirmed",
      occurredAt: new Date(now - (i + 1) * 1000).toISOString(),
    });
  }
}

/** Run the real CLI against the real app and return its parsed `--json` report. */
async function verifyAgainst(env: Env): Promise<{ code: number; results: { id: string; status: string; detail: string }[] }> {
  routeFetchTo(env);
  const { runVerify } = await loadCli();
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const code = await runVerify(["--json", "--base-url", BASE_URL]);
    return { code, results: JSON.parse(chunks.join("")).results };
  } finally {
    spy.mockRestore();
  }
}

const claim = (results: { id: string; status: string; detail: string }[], id: string) => results.find((result) => result.id === id)!;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loopover-verify against the real public routes (#9962)", () => {
  it("REGRESSION: rehashes the published corpus and PASSES the commitment claim", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true" });
    await seedDecidedRule(env, RULE_ID);

    const { results } = await verifyAgainst(env);
    const corpus = claim(results, "corpus-commitments");

    // Before the fix this was `skip` with "no corresponding corpus is downloadable" -- the corpus fetch 400'd
    // on the parameter name, so nothing was ever rehashed. A skip is the failure mode here, not a pass.
    expect(corpus.status).toBe("pass");
    expect(corpus.detail).toMatch(/case\(s\) rehashed exactly/);
    expect(corpus.detail).not.toMatch(/unverified/);
  });

  it("INVARIANT: the record digests claim passes over the same live surface", async () => {
    // Guards the seeding above rather than the fix: if no record were published at all, the corpus claim would
    // skip for a completely different reason and the assertion above would be vacuous.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true" });
    await seedDecidedRule(env, RULE_ID);

    const { results } = await verifyAgainst(env);
    expect(claim(results, "record-digests").status).toBe("pass");
  });

  it("MUTATION GUARD: the corpus claim degrades to a skip when the corpus genuinely cannot be fetched", async () => {
    // Proves the pass above is not vacuous -- that the claim really is driven by a successful corpus fetch and
    // would notice its absence. The query is stripped entirely rather than misspelled, so this stays honest
    // regardless of which spellings the route accepts.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true" });
    await seedDecidedRule(env, RULE_ID);
    const app = createApp();
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      const search = url.pathname === "/v1/public/eval-corpus" ? "" : url.search;
      return app.request(`${url.pathname}${search}`, {}, env);
    });
    const { runVerify } = await loadCli();
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    await runVerify(["--json", "--base-url", BASE_URL]);
    spy.mockRestore();

    const corpus = claim(JSON.parse(chunks.join("")).results, "corpus-commitments");
    expect(corpus.status).toBe("skip");
    expect(corpus.detail).toMatch(/no corresponding corpus is downloadable/);
  });

  it("asks for the CANONICAL ruleId spelling, not the compatibility alias", async () => {
    // The route accepts `rule_id` too, so the end-to-end claim above would pass either way -- which is the
    // point of the alias, but it also means nothing else pins what OUR client sends. This does. The alias
    // exists for verifiers already installed in the wild; new code must not drift onto a deprecated spelling
    // and quietly make the alias load-bearing.
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true" });
    await seedDecidedRule(env, RULE_ID);
    const app = createApp();
    const corpusQueries: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/public/eval-corpus") corpusQueries.push(url.searchParams);
      return app.request(`${url.pathname}${url.search}`, {}, env);
    });
    const { runVerify } = await loadCli();
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runVerify(["--json", "--base-url", BASE_URL]);
    spy.mockRestore();

    expect(corpusQueries.length).toBeGreaterThan(0);
    for (const query of corpusQueries) {
      expect(query.get("ruleId")).toBe(RULE_ID);
      expect(query.has("rule_id")).toBe(false);
    }
  });
});

describe("/v1/public/eval-corpus parameter spellings (#9962)", () => {
  const get = (env: Env, query: string) => createApp().request(`/v1/public/eval-corpus${query}`, {}, env);

  it("serves the same corpus for the canonical ruleId and the rule_id alias", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true" });
    await seedDecidedRule(env, RULE_ID);

    const canonical = await get(env, `?ruleId=${RULE_ID}`);
    const alias = await get(env, `?rule_id=${RULE_ID}`);

    expect(canonical.status).toBe(200);
    // The alias exists so that verifiers ALREADY PUBLISHED -- which ask for this spelling and got a 400 --
    // start working against production without their users upgrading anything.
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(await canonical.json());
  });

  it("prefers the canonical spelling when a caller passes both", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true" });
    await seedDecidedRule(env, RULE_ID);

    const response = await get(env, `?ruleId=${RULE_ID}&rule_id=some_other_rule`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ruleId: string }).ruleId).toBe(RULE_ID);
  });

  it("still requires one of them", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true" });
    const response = await get(env, "");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "rule_id_required" });
  });

  it("publishes readFailed so a reader can tell a degraded read from a quiet rule", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "true" });
    await seedDecidedRule(env, RULE_ID);
    const healthy = (await (await get(env, `?ruleId=${RULE_ID}`)).json()) as { readFailed: boolean; caseCount: number };
    expect(healthy).toMatchObject({ readFailed: false });
    expect(healthy.caseCount).toBeGreaterThan(0);
  });
});
