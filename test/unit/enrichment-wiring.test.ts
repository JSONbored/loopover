import { afterEach, describe, expect, it, vi } from "vitest";
import { runGittensoryAiReview } from "../../src/services/ai-review";
import {
  buildReviewEnrichment,
  EMPTY_ENRICHMENT,
  isEnrichmentEnabled,
  type EnrichmentBrief,
  type ReviewBriefResponse,
} from "../../src/review/enrichment-wire";
import { createTestEnv } from "../helpers/d1";

// ── Test fixtures ────────────────────────────────────────────────────────────────────────────────

/** Build a `Response`-like object for the fetch stub. Body is parsed as JSON when present. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Minimal env shape that drives the seam. `REES_URL` + `REES_SHARED_SECRET` are the only co-config
 *  required when the flag is ON; the rest are filled in per test. */
function makeEnv(over: Partial<{ GITTENSORY_REVIEW_ENRICHMENT: string; REES_URL: string; REES_SHARED_SECRET: string; REES_TIMEOUT_MS: string }> = {}): Env {
  return {
    GITTENSORY_REVIEW_ENRICHMENT: over.GITTENSORY_REVIEW_ENRICHMENT,
    REES_URL: over.REES_URL,
    REES_SHARED_SECRET: over.REES_SHARED_SECRET,
    REES_TIMEOUT_MS: over.REES_TIMEOUT_MS,
  } as unknown as Env;
}

const baseArgs = {
  repoFullName: "acme/widgets",
  prNumber: 7,
  headSha: "sha7",
  title: "Add a feature",
  body: "Implements the thing.",
  author: "alice",
  diff: "### src/a.ts (modified) +1/-0\n@@\n+export const A = 1;",
};

const validBrief: ReviewBriefResponse = {
  schemaVersion: 1,
  repoFullName: "acme/widgets",
  prNumber: 7,
  headSha: "sha7",
  generatedAtIso: "2026-06-26T00:00:00.000Z",
  elapsedMs: 42,
  partial: false,
  analyzerStatus: { cve: "ok" },
  findings: { cve: [] },
  promptSection: "RELEVANT BRIEF:\n- No CVEs found.",
  systemSuffix: "\n\nEnrichment discipline: verify the brief findings against the diff before flagging a defect.",
};

// ── isEnrichmentEnabled ──────────────────────────────────────────────────────────────────────────

describe("isEnrichmentEnabled", () => {
  it("is OFF for unset/false and ON for the truthy convention", () => {
    expect(isEnrichmentEnabled({})).toBe(false);
    expect(isEnrichmentEnabled({ GITTENSORY_REVIEW_ENRICHMENT: "false" })).toBe(false);
    expect(isEnrichmentEnabled({ GITTENSORY_REVIEW_ENRICHMENT: "0" })).toBe(false);
    expect(isEnrichmentEnabled({ GITTENSORY_REVIEW_ENRICHMENT: "true" })).toBe(true);
    expect(isEnrichmentEnabled({ GITTENSORY_REVIEW_ENRICHMENT: "1" })).toBe(true);
    expect(isEnrichmentEnabled({ GITTENSORY_REVIEW_ENRICHMENT: "on" })).toBe(true);
    expect(isEnrichmentEnabled({ GITTENSORY_REVIEW_ENRICHMENT: "yes" })).toBe(true);
  });
});

// ── EMPTY_ENRICHMENT is the contract for the OFF path ───────────────────────────────────────────

describe("EMPTY_ENRICHMENT", () => {
  it("has empty promptSection + systemSuffix (byte-identical prompt when spliced in)", () => {
    expect(EMPTY_ENRICHMENT).toEqual({ promptSection: "", systemSuffix: "" });
  });
});

// ── buildReviewEnrichment — fail-safe paths ──────────────────────────────────────────────────────

describe("buildReviewEnrichment fail-safe paths", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns EMPTY without fetching when the flag is OFF", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, validBrief));
    const result = await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "false", REES_URL: "http://rees", REES_SHARED_SECRET: "sek" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual(EMPTY_ENRICHMENT);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns EMPTY without fetching when REES_URL is missing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, validBrief));
    const result = await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_SHARED_SECRET: "sek" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual(EMPTY_ENRICHMENT);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns EMPTY without fetching when REES_SHARED_SECRET is missing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, validBrief));
    const result = await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "http://rees" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual(EMPTY_ENRICHMENT);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns EMPTY on a non-2xx response (no exception)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "unavailable" }));
    const result = await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "http://rees", REES_SHARED_SECRET: "sek" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual(EMPTY_ENRICHMENT);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns EMPTY when the response body is not valid JSON (parse error)", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));
    const result = await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "http://rees", REES_SHARED_SECRET: "sek" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual(EMPTY_ENRICHMENT);
  });

  it("returns EMPTY on a network/timeout throw (the seam NEVER throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const result = await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "http://rees", REES_SHARED_SECRET: "sek" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual(EMPTY_ENRICHMENT);
  });

  it("returns EMPTY when the parsed body is not an object", async () => {
    const fetchImpl = vi.fn(async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } }));
    const result = await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "http://rees", REES_SHARED_SECRET: "sek" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual(EMPTY_ENRICHMENT);
  });
});

// ── buildReviewEnrichment — happy path + wire-shape assertions ───────────────────────────────────

describe("buildReviewEnrichment happy path", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the brief's promptSection + systemSuffix on a 2xx JSON response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, validBrief));
    const result = await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "http://rees", REES_SHARED_SECRET: "sek" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({
      promptSection: "RELEVANT BRIEF:\n- No CVEs found.",
      systemSuffix: "\n\nEnrichment discipline: verify the brief findings against the diff before flagging a defect.",
    });
  });

  it("POSTs to {REES_URL}/v1/enrich with a Bearer token + JSON body", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // Capture the wire shape so we can assert it stays stable across refactors.
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("authorization")).toBe("Bearer sek");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        repoFullName: "acme/widgets",
        prNumber: 7,
        headSha: "sha7",
        title: "Add a feature",
        author: "alice",
      });
      return jsonResponse(200, validBrief);
    });
    await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "http://rees", REES_SHARED_SECRET: "sek" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledWith = fetchImpl.mock.calls[0]?.[0];
    expect(String(calledWith)).toBe("http://rees/v1/enrich");
  });

  it("strips trailing slashes from REES_URL before building the path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, validBrief));
    await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "http://rees/", REES_SHARED_SECRET: "sek" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const calledWith = (fetchImpl.mock.calls[0] as unknown as [unknown] | undefined)?.[0];
    expect(String(calledWith)).toBe("http://rees/v1/enrich");
  });

  it("tolerates a brief whose promptSection/systemSuffix are missing or non-string", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ...validBrief, promptSection: undefined as unknown as string, systemSuffix: 42 as unknown as string }),
    );
    const result = await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "http://rees", REES_SHARED_SECRET: "sek" }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({ promptSection: "", systemSuffix: "" });
  });

  it("clamps an out-of-range REES_TIMEOUT_MS to a sane band (still issues the request)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, validBrief));
    // 999999999ms > the 60_000ms upper clamp — the seam should still fetch, just under the clamped timeout.
    await buildReviewEnrichment(
      makeEnv({
        GITTENSORY_REVIEW_ENRICHMENT: "true",
        REES_URL: "http://rees",
        REES_SHARED_SECRET: "sek",
        REES_TIMEOUT_MS: "999999999",
      }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("falls back to the default 8000ms when REES_TIMEOUT_MS is unset or invalid", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, validBrief));
    await buildReviewEnrichment(
      makeEnv({
        GITTENSORY_REVIEW_ENRICHMENT: "true",
        REES_URL: "http://rees",
        REES_SHARED_SECRET: "sek",
        REES_TIMEOUT_MS: "not-a-number",
      }),
      baseArgs,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses the global fetch when no fetchImpl override is provided", async () => {
    // Stub the global fetch so the seam falls through to it via `options.fetchImpl ?? fetch`.
    const stub = vi.fn(async () => jsonResponse(200, validBrief));
    vi.stubGlobal("fetch", stub as unknown as typeof fetch);
    const result = await buildReviewEnrichment(
      makeEnv({ GITTENSORY_REVIEW_ENRICHMENT: "true", REES_URL: "http://rees", REES_SHARED_SECRET: "sek" }),
      baseArgs,
    );
    expect(result.promptSection).toBe("RELEVANT BRIEF:\n- No CVEs found.");
    expect(stub).toHaveBeenCalledOnce();
  });
});

// ── runGittensoryAiReview — enrichment integration (prompt byte-identity) ────────────────────────

const notesJson = JSON.stringify({
  assessment: "Looks fine.",
  suggestions: [],
  risks: [],
  criticalDefect: { present: false, confidence: 0, title: "", detail: "" },
});

/** Capture the exact system + user prompts handed to the model so we can assert what the AI sees. */
function capturingAiEnv(opts: {
  enrichment?: EnrichmentBrief;
  grounding?: { systemSuffix?: string; promptSection?: string };
  rag?: string;
}) {
  const seenUser: string[] = [];
  const seenSystem: string[] = [];
  const run = vi.fn(async (_model: string, options: { messages: Array<{ role: string; content: string }> }) => {
    const userMsg = options.messages.find((m) => m.role === "user");
    const systemMsg = options.messages.find((m) => m.role === "system");
    if (userMsg) seenUser.push(userMsg.content);
    if (systemMsg) seenSystem.push(systemMsg.content);
    return { response: notesJson };
  });
  const env = createTestEnv({
    AI: { run } as unknown as Ai,
    AI_SUMMARIES_ENABLED: "true",
    AI_PUBLIC_COMMENTS_ENABLED: "true",
    AI_DAILY_NEURON_BUDGET: "100000",
  });
  const input: Parameters<typeof runGittensoryAiReview>[1] = {
    repoFullName: "acme/widgets",
    prNumber: 7,
    title: "Add a feature",
    body: "Implements the thing.",
    diff: "### src/a.ts (modified) +1/-0\n@@\n+export const A = 1;",
    actor: "alice",
    mode: "advisory",
    providerKey: null,
    ...(opts.enrichment ? { enrichment: opts.enrichment } : {}),
    ...(opts.grounding ? { grounding: opts.grounding } : {}),
    ...(opts.rag ? { ragContext: opts.rag } : {}),
  };
  return { env, seenUser, seenSystem, run, input };
}

describe("runGittensoryAiReview enrichment integration", () => {
  afterEach(() => vi.restoreAllMocks());

  it("absent enrichment → user + system prompts are byte-identical (no enrichment markers)", async () => {
    const { env, seenUser, seenSystem, input } = capturingAiEnv({});
    await runGittensoryAiReview(env, input);
    expect(seenUser).toHaveLength(1);
    expect(seenSystem).toHaveLength(1);
    expect(seenUser[0]).not.toContain("RELEVANT BRIEF");
    expect(seenUser[0]).not.toContain("Enrichment discipline");
    expect(seenSystem[0]).not.toContain("Enrichment discipline");
  });

  it("EMPTY enrichment ({ promptSection: '', systemSuffix: '' }) → byte-identical to absent", async () => {
    const { env, seenUser, seenSystem, input } = capturingAiEnv({ enrichment: EMPTY_ENRICHMENT });
    await runGittensoryAiReview(env, input);
    expect(seenUser).toHaveLength(1);
    expect(seenSystem).toHaveLength(1);
    expect(seenUser[0]).not.toContain("RELEVANT BRIEF");
    expect(seenSystem[0]).not.toContain("Enrichment discipline");
  });

  it("non-empty enrichment → promptSection appears in the user prompt AFTER grounding + RAG", async () => {
    const enrichment: EnrichmentBrief = {
      promptSection: "RELEVANT BRIEF:\n- No CVEs.",
      systemSuffix: "Enrichment discipline: verify the brief against the diff.",
    };
    const { env, seenUser, seenSystem, input } = capturingAiEnv({
      enrichment,
      grounding: { promptSection: "GROUNDING SECTION", systemSuffix: "GROUNDING DISCIPLINE" },
      rag: "RAG CONTEXT",
    });
    await runGittensoryAiReview(env, input);
    expect(seenUser).toHaveLength(1);
    expect(seenSystem).toHaveLength(1);
    const user = seenUser[0]!;
    expect(user).toContain("GROUNDING SECTION");
    expect(user).toContain("RAG CONTEXT");
    expect(user).toContain("RELEVANT BRIEF:\n- No CVEs.");
    // Order: grounding → RAG → enrichment (enrichment sits at the bottom so the reviewer reads it last).
    expect(user.indexOf("GROUNDING SECTION")).toBeLessThan(user.indexOf("RAG CONTEXT"));
    expect(user.indexOf("RAG CONTEXT")).toBeLessThan(user.indexOf("RELEVANT BRIEF:"));
    // System suffix: grounding → enrichment → profile → pathGuidance.
    expect(seenSystem[0]).toContain("GROUNDING DISCIPLINE");
    expect(seenSystem[0]).toContain("Enrichment discipline");
    expect(seenSystem[0]!.indexOf("GROUNDING DISCIPLINE")).toBeLessThan(seenSystem[0]!.indexOf("Enrichment discipline"));
  });
});
