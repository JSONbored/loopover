import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeStats,
  handleParity,
  handleStats,
  isParityCutoverReady,
  MIN_PARITY_SAMPLE,
  PARITY_AGREEMENT_FLOOR,
  type GateParityRow,
  type StatsEvalDeps,
} from "../../src/review/stats";

// Stub D1: route by table name — review_audit → reversals, else decision rows.
function stubEnv(extra: Record<string, unknown> = {}): Env {
  const decisions = [
    { bucket: "2026-06-01", project: "awesome-claude", verdict: "merge", n: 5 },
    { bucket: "2026-06-01", project: "awesome-claude", verdict: "close", n: 3 },
    { bucket: "2026-06-01", project: "gittensory", verdict: "comment", n: 2 },
  ];
  const reversals = [{ bucket: "2026-06-01", project: "awesome-claude", n: 1 }];
  const gateActions = [
    { project: "metagraphed", action: "merge", n: 7 },
    { project: "metagraphed", action: "hold", n: 2 },
  ];
  let lastSql = "";
  return {
    ...extra,
    DB: {
      prepare: (s: string) => {
        lastSql = s;
        return {
          bind: () => ({
            all: async () => ({
              // gate_decision breakdown → gateActions; other review_audit reads → reversals;
              // everything else → decision rows. (The eval/parity engine is the default no-op deps.)
              results: lastSql.includes("gate_decision") ? gateActions : lastSql.includes("review_audit") ? reversals : decisions,
            }),
          }),
        };
      },
    },
  } as unknown as Env;
}

const NOW = Date.parse("2026-06-14T00:00:00Z");

describe("computeStats — D1 aggregate for the dashboard", () => {
  it("returns sorted projects/verdicts, rows, reversals, and the window", async () => {
    const out = await computeStats(stubEnv(), { days: 90, bucket: "week", nowMs: NOW });
    expect(out.projects).toEqual(["awesome-claude", "gittensory"]);
    expect(out.verdicts).toEqual(["close", "comment", "merge"]);
    expect(out.rows).toHaveLength(3);
    expect(out.reversals).toEqual([{ bucket: "2026-06-01", project: "awesome-claude", n: 1 }]);
    expect(out.gateActions).toEqual([
      { project: "metagraphed", action: "merge", n: 7 },
      { project: "metagraphed", action: "hold", n: 2 },
    ]);
    expect(out.window).toEqual({ fromIso: "2026-03-16", days: 90, bucket: "week" });
    expect(out.gateEval).toEqual({ rows: [], hasSignal: false });
    expect(out.recommendations).toEqual([]);
    expect(out.gateParity.cutoverReady).toEqual([]);
  });

  it("clamps an absurd window and falls back to a safe bucket", async () => {
    const out = await computeStats(stubEnv(), { days: 99999, bucket: "decade", nowMs: NOW });
    expect(out.window.days).toBe(730);
    expect(out.window.bucket).toBe("day");
  });

  it("defaults to 90 days for a non-positive window", async () => {
    const out = await computeStats(stubEnv(), { days: 0, bucket: "day", nowMs: NOW });
    expect(out.window.days).toBe(90);
  });

  it("falls back to 'day' for a prototype-chain bucket key (whitelist can't be defeated by `constructor`)", async () => {
    for (const evil of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const out = await computeStats(stubEnv(), { days: 30, bucket: evil, nowMs: NOW });
      expect(out.window.bucket).toBe("day");
    }
  });

  it("threads injected eval/parity/tuning deps into the payload", async () => {
    const out = await computeStats(
      stubEnv(),
      { days: 30, bucket: "day", nowMs: NOW },
      {
        computeGateEval: async () => ({ rows: [], hasSignal: true }),
        computeTuningRecommendations: () => [{ project: "p", severity: "warn", message: "tighten" }],
        computeGateParity: async () => ({
          authoritative: "reviewbot",
          shadow: "gittensory",
          hasSignal: true,
          rows: [{ project: "p", pairedSamples: 40, bothMerge: 40, bothClose: 0, bothHold: 0, disagree: 0, agreementRate: 1, unsafeDisagreements: 0, byReasonCode: [] }],
        }),
      },
    );
    expect(out.gateEval.hasSignal).toBe(true);
    expect(out.recommendations).toHaveLength(1);
    expect(out.gateParity.cutoverReady).toEqual([{ project: "p", ready: true }]);
  });
});

describe("handleStats — bearer-gated, CORS-open feed", () => {
  const req = (headers: Record<string, string> = {}, method = "GET") =>
    new Request("https://w.dev/stats/data?days=30&bucket=day", { method, headers });

  it("204s a CORS preflight with no auth", async () => {
    const res = await handleStats(req({}, "OPTIONS"), stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("401s (NOT 404) when the token secret is unset — no config oracle, uniform with a wrong token", async () => {
    expect((await handleStats(req({ authorization: "Bearer anything" }), stubEnv())).status).toBe(401);
    expect((await handleStats(req(), stubEnv())).status).toBe(401); // no auth header, unset token → still 401
  });

  it("401s a missing/wrong token", async () => {
    const env = stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" });
    expect((await handleStats(req(), env)).status).toBe(401);
    expect((await handleStats(req({ authorization: "Bearer nope" }), env)).status).toBe(401);
  });

  it("200s with JSON + CORS for the correct token", async () => {
    const res = await handleStats(req({ authorization: "Bearer s3cret" }), stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { projects: string[] };
    expect(body.projects).toContain("awesome-claude");
  });
});

describe("computeStats — gate-decision read is fail-safe", () => {
  // A stubEnv whose gate_decision query rejects: computeStats should still resolve with gateActions: [].
  function gateThrowingEnv(): Env {
    const decisions = [{ bucket: "2026-06-01", project: "awesome-claude", verdict: "merge", n: 5 }];
    let lastSql = "";
    return {
      DB: {
        prepare: (s: string) => {
          lastSql = s;
          return {
            bind: () => ({
              all: async () => {
                if (lastSql.includes("gate_decision")) throw new Error("gate read down");
                return { results: lastSql.includes("review_audit") ? [] : decisions };
              },
            }),
          };
        },
      },
    } as unknown as Env;
  }

  it("falls back to gateActions: [] when the gate_decision query rejects (the .catch)", async () => {
    const out = await computeStats(gateThrowingEnv(), { days: 30, bucket: "day", nowMs: NOW });
    expect(out.gateActions).toEqual([]);
    expect(out.projects).toEqual(["awesome-claude"]); // the rest of the payload still computes
  });
});

describe("handleParity — bearer-gated, CORS-open cross-system parity feed", () => {
  const PARITY_DEPS: StatsEvalDeps = {
    computeGateEval: async () => ({ rows: [], hasSignal: false }),
    computeTuningRecommendations: () => [],
    computeGateParity: async () => ({
      authoritative: "reviewbot",
      shadow: "gittensory",
      hasSignal: true,
      rows: [
        { project: "gittensory", pairedSamples: 40, bothMerge: 40, bothClose: 0, bothHold: 0, disagree: 0, agreementRate: 1, unsafeDisagreements: 0, byReasonCode: [] },
        { project: "gittensory", pairedSamples: 5, bothMerge: 5, bothClose: 0, bothHold: 0, disagree: 0, agreementRate: 1, unsafeDisagreements: 0, byReasonCode: [] },
      ],
    }),
  };
  const req = (headers: Record<string, string> = {}, method = "GET") =>
    new Request("https://w.dev/gittensory/internal/parity?days=90&shadow=gittensory", { method, headers });

  it("204s a CORS preflight with no auth", async () => {
    const res = await handleParity(req({}, "OPTIONS"), stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" }), "gittensory");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("401s when the token is unset or wrong", async () => {
    expect((await handleParity(req({ authorization: "Bearer anything" }), stubEnv(), "gittensory")).status).toBe(401); // unset
    const env = stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" });
    expect((await handleParity(req(), env, "gittensory")).status).toBe(401); // no header
    expect((await handleParity(req({ authorization: "Bearer nope" }), env, "gittensory")).status).toBe(401); // wrong
  });

  it("200s with the parity report + per-row cutoverReady for the correct token", async () => {
    const res = await handleParity(req({ authorization: "Bearer s3cret" }), stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" }), "gittensory", PARITY_DEPS);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { authoritative: string; shadow: string; cutoverReady: Array<{ project: string; ready: boolean }> };
    expect(body.authoritative).toBe("reviewbot");
    expect(body.shadow).toBe("gittensory");
    // first row (40 paired, perfect agreement, 0 unsafe) is cutover-ready; the thin 5-sample row is not.
    expect(body.cutoverReady).toEqual([{ project: "gittensory", ready: true }, { project: "gittensory", ready: false }]);
  });

  it("forwards the ?authoritative / ?shadow params (non-null branch) and uses ?days override", async () => {
    let seen: { days: number; authoritative?: string; shadow?: string } | undefined;
    const deps: StatsEvalDeps = {
      computeGateEval: async () => ({ rows: [], hasSignal: false }),
      computeTuningRecommendations: () => [],
      computeGateParity: async (_env, o) => {
        seen = { days: o.days, ...(o.authoritative !== undefined ? { authoritative: o.authoritative } : {}), ...(o.shadow !== undefined ? { shadow: o.shadow } : {}) };
        return { authoritative: o.authoritative ?? "a", shadow: o.shadow ?? "s", hasSignal: false, rows: [] };
      },
    };
    const r = new Request("https://w.dev/gittensory/internal/parity?days=14&authoritative=reviewbot&shadow=gittensory", {
      method: "GET",
      headers: { authorization: "Bearer s3cret" },
    });
    const res = await handleParity(r, stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" }), "gittensory", deps);
    expect(res.status).toBe(200);
    expect(seen).toEqual({ days: 14, authoritative: "reviewbot", shadow: "gittensory" });
  });

  it("omits authoritative/shadow (the {} branch) and defaults days to 90 when those params are absent", async () => {
    let seen: { days: number; hasAuthoritative: boolean; hasShadow: boolean } | undefined;
    const deps: StatsEvalDeps = {
      computeGateEval: async () => ({ rows: [], hasSignal: false }),
      computeTuningRecommendations: () => [],
      computeGateParity: async (_env, o) => {
        seen = { days: o.days, hasAuthoritative: "authoritative" in o, hasShadow: "shadow" in o };
        return { authoritative: "reviewbot", shadow: "gittensory", hasSignal: false, rows: [] };
      },
    };
    // No days / authoritative / shadow params → days defaults to 90, both spreads collapse to {}.
    const r = new Request("https://w.dev/gittensory/internal/parity", { method: "GET", headers: { authorization: "Bearer s3cret" } });
    const res = await handleParity(r, stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" }), "gittensory", deps);
    expect(res.status).toBe(200);
    expect(seen).toEqual({ days: 90, hasAuthoritative: false, hasShadow: false });
  });

  it("uses the default deps (defaultStatsEvalDeps) when none are injected — empty parity, no cutoverReady rows", async () => {
    const res = await handleParity(req({ authorization: "Bearer s3cret" }), stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" }), "gittensory");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authoritative: string; cutoverReady: unknown[] };
    // default emptyParity uses the URL's shadow=gittensory and a default authoritative=reviewbot.
    expect(body.authoritative).toBe("reviewbot");
    expect(body.cutoverReady).toEqual([]);
  });
});

describe("handleStats — query-param default branches", () => {
  it("defaults days→90 and bucket→day when those params are absent (the ?? fallbacks)", async () => {
    let captured: { days: number; bucket: string } | undefined;
    const deps: StatsEvalDeps = {
      // capture is observed via the payload window below; deps stay no-op.
      computeGateEval: async (_env, o) => {
        captured = { days: o.days, bucket: "" };
        return { rows: [], hasSignal: false };
      },
      computeTuningRecommendations: () => [],
      computeGateParity: async () => ({ authoritative: "reviewbot", shadow: "gittensory", hasSignal: false, rows: [] }),
    };
    // No days / bucket query params → days ?? 90, bucket ?? "day".
    const r = new Request("https://w.dev/stats/data", { method: "GET", headers: { authorization: "Bearer s3cret" } });
    const res = await handleStats(r, stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" }), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: { days: number; bucket: string } };
    expect(body.window.days).toBe(90);
    expect(body.window.bucket).toBe("day");
    expect(captured?.days).toBe(90);
  });
});

describe("computeStats — NaN window + null D1 results (the ?? [] fallbacks)", () => {
  // A stub whose .all() returns NO `results` key, exercising the `?? []` on decision/reversal/gate rows.
  function nullResultsEnv(): Env {
    return {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({}), // results undefined → the ?? [] fallbacks fire on all three reads
          }),
        }),
      },
    } as unknown as Env;
  }

  it("defaults to 90 days when opts.days is NaN (Number.isFinite false branch)", async () => {
    const out = await computeStats(nullResultsEnv(), { days: Number.NaN, bucket: "day", nowMs: NOW });
    expect(out.window.days).toBe(90);
  });

  it("defaults to 90 days when opts.days is Infinity (Number.isFinite false branch)", async () => {
    const out = await computeStats(nullResultsEnv(), { days: Number.POSITIVE_INFINITY, bucket: "day", nowMs: NOW });
    expect(out.window.days).toBe(90);
  });

  it("falls back to empty arrays when D1 returns no `results` field", async () => {
    const out = await computeStats(nullResultsEnv(), { days: 30, bucket: "day", nowMs: NOW });
    expect(out.rows).toEqual([]);
    expect(out.reversals).toEqual([]);
    expect(out.gateActions).toEqual([]);
    expect(out.projects).toEqual([]);
    expect(out.verdicts).toEqual([]);
  });
});

describe("isParityCutoverReady — every gate condition", () => {
  const base: GateParityRow = {
    project: "p",
    pairedSamples: MIN_PARITY_SAMPLE,
    bothMerge: MIN_PARITY_SAMPLE,
    bothClose: 0,
    bothHold: 0,
    disagree: 0,
    agreementRate: PARITY_AGREEMENT_FLOOR,
    unsafeDisagreements: 0,
    byReasonCode: [],
  };

  it("is ready when all four conditions hold (enough samples, 0 unsafe, rate at the floor)", () => {
    expect(isParityCutoverReady(base)).toBe(true);
  });

  it("is NOT ready with too few paired samples", () => {
    expect(isParityCutoverReady({ ...base, pairedSamples: MIN_PARITY_SAMPLE - 1 })).toBe(false);
  });

  it("is NOT ready with any unsafe disagreement", () => {
    expect(isParityCutoverReady({ ...base, unsafeDisagreements: 1 })).toBe(false);
  });

  it("is NOT ready when agreementRate is null (the != null guard)", () => {
    expect(isParityCutoverReady({ ...base, agreementRate: null })).toBe(false);
  });

  it("is NOT ready when agreementRate is below the floor", () => {
    expect(isParityCutoverReady({ ...base, agreementRate: PARITY_AGREEMENT_FLOOR - 0.001 })).toBe(false);
  });
});

describe("timingSafeEqual + readSecret — branches reached through the handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the native crypto.subtle.timingSafeEqual when present (equal-length, function-typed branch)", async () => {
    const subtle = crypto.subtle as unknown as Record<string, unknown>;
    const had = "timingSafeEqual" in subtle;
    const native = vi.fn((a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]));
    subtle.timingSafeEqual = native;
    try {
      // Correct token, equal lengths → the native path is taken and authorizes (200).
      const res = await handleStats(
        new Request("https://w.dev/stats/data?days=1&bucket=day", { method: "GET", headers: { authorization: "Bearer s3cret" } }),
        stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "s3cret" }),
      );
      expect(res.status).toBe(200);
      expect(native).toHaveBeenCalled();
    } finally {
      if (!had) delete subtle.timingSafeEqual;
    }
  });

  it("uses the manual constant-time loop for UNEQUAL-length tokens (the diff=1 + ?? 0 out-of-range branch)", async () => {
    const subtle = crypto.subtle as unknown as Record<string, unknown>;
    const had = "timingSafeEqual" in subtle;
    // Force the non-native path so the manual loop (and its ?? 0 out-of-bounds reads) runs.
    if (had) delete subtle.timingSafeEqual;
    try {
      // Provided "Bearer x" is far shorter than expected "Bearer <long>" → unequal length → diff seeded 1,
      // the loop XORs out-of-range indices via `?? 0`, and the compare fails → 401.
      const res = await handleStats(
        new Request("https://w.dev/stats/data", { method: "GET", headers: { authorization: "Bearer x" } }),
        stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: "averylongtokenvalue-far-longer-than-x" }),
      );
      expect(res.status).toBe(401);
    } finally {
      // afterEach restores; nothing to re-add since it was absent in this env.
      void had;
    }
  });

  it("treats a non-string token secret as unset (readSecret's `: \"\"` branch → 401)", async () => {
    // GITTENSORY_REVIEW_STATS_TOKEN present but NOT a string → readSecret returns "" → !expected → 401.
    const env = stubEnv({ GITTENSORY_REVIEW_STATS_TOKEN: 12345 });
    const res = await handleStats(
      new Request("https://w.dev/stats/data", { method: "GET", headers: { authorization: "Bearer 12345" } }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
