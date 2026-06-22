import { describe, expect, it } from "vitest";
import { computeStats, handleStats } from "../../src/review/stats";

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
    const res = await handleStats(req({}, "OPTIONS"), stubEnv({ REVIEWBOT_STATS_TOKEN: "s3cret" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("401s (NOT 404) when the token secret is unset — no config oracle, uniform with a wrong token", async () => {
    expect((await handleStats(req({ authorization: "Bearer anything" }), stubEnv())).status).toBe(401);
    expect((await handleStats(req(), stubEnv())).status).toBe(401); // no auth header, unset token → still 401
  });

  it("401s a missing/wrong token", async () => {
    const env = stubEnv({ REVIEWBOT_STATS_TOKEN: "s3cret" });
    expect((await handleStats(req(), env)).status).toBe(401);
    expect((await handleStats(req({ authorization: "Bearer nope" }), env)).status).toBe(401);
  });

  it("200s with JSON + CORS for the correct token", async () => {
    const res = await handleStats(req({ authorization: "Bearer s3cret" }), stubEnv({ REVIEWBOT_STATS_TOKEN: "s3cret" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { projects: string[] };
    expect(body.projects).toContain("awesome-claude");
  });
});
