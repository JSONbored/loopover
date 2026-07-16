import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildEnrichmentAnalyzersTaxonomyDocument } from "../../src/review/enrichment-analyzers-taxonomy";
import { buildFindingTaxonomyDocument } from "../../src/review/finding-taxonomy";
import { createTestEnv } from "../helpers/d1";

// #6593: REST mirrors of the `loopover://finding-taxonomy` / `gittensory://enrichment-analyzers` MCP resources.
// Both delegate to a pure, argument-free builder, so these tests pin the ROUTE contract — served byte-identical
// to the document the MCP resource already returns, and gated exactly like the sibling static-data routes it
// sits with (no new auth middleware of its own) — rather than re-testing the builders themselves.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` });
const PATHS = ["/v1/finding-taxonomy", "/v1/enrichment-analyzers"] as const;

describe("static taxonomy REST mirrors (#6593)", () => {
  it("GET /v1/finding-taxonomy returns the finding taxonomy document", async () => {
    const env = createTestEnv();
    const response = await createApp().request("/v1/finding-taxonomy", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(JSON.parse(JSON.stringify(buildFindingTaxonomyDocument())));
    const doc = body as { categories: unknown[]; severities: unknown[] };
    expect(doc.categories.length).toBeGreaterThan(0);
    expect(doc.severities.length).toBeGreaterThan(0);
  });

  it("GET /v1/enrichment-analyzers returns the enrichment analyzer taxonomy document", async () => {
    const env = createTestEnv();
    const response = await createApp().request("/v1/enrichment-analyzers", { headers: apiHeaders(env) }, env);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(JSON.parse(JSON.stringify(buildEnrichmentAnalyzersTaxonomyDocument())));
    const doc = body as { defaultProfile: unknown; analyzers: unknown[] };
    expect(typeof doc.defaultProfile).toBe("string");
    expect(doc.analyzers.length).toBeGreaterThan(0);
    expect(doc.analyzers[0]).toMatchObject({ name: expect.any(String), category: expect.any(String), costClass: expect.any(String), profiles: expect.any(Array) });
  });

  it("is gated exactly like the sibling static-data routes — no new auth middleware, no new public hole", async () => {
    const app = createApp();
    const env = createTestEnv();
    // /v1/scoring/model is the route these two are modelled on; whatever it answers unauthenticated, they must
    // answer too. Pinning it against the sibling (rather than a hard-coded status) keeps this honest if the
    // shared middleware ever changes.
    const sibling = await app.request("/v1/scoring/model", {}, env);
    for (const path of PATHS) {
      const response = await app.request(path, {}, env);
      expect(response.status, `${path} must match /v1/scoring/model's unauthenticated behavior`).toBe(sibling.status);
    }
  });

  it("exposes no PR/user/private data in either document", async () => {
    const app = createApp();
    const env = createTestEnv();
    for (const path of PATHS) {
      const text = JSON.stringify(await (await app.request(path, { headers: apiHeaders(env) }, env)).json());
      expect(text, path).not.toMatch(/wallet|hotkey|coldkey|trust score|reward|pullNumber|authorLogin/i);
    }
  });
});
