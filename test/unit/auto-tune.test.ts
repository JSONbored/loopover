import { describe, expect, it, vi } from "vitest";
import {
  AUTOCLEAR_AFTER_MS,
  applyAutoTune,
  applyCloseAutoTune,
  computeTuningRecommendations,
  type FlagStore,
  type GateEvalReport,
  type GateEvalRow,
  maybeAutoClearCloseHoldOnly,
  maybeAutoClearHoldOnly,
  planAutoTune,
  planCloseAutoTune,
  shouldAutoClear,
  shouldAutoClearClose,
} from "../../src/review/auto-tune";

const row = (over: Partial<GateEvalRow>): GateEvalRow => ({
  project: "p",
  wouldMerge: 0,
  mergeConfirmed: 0,
  mergeFalse: 0,
  wouldClose: 0,
  closeConfirmed: 0,
  closeFalse: 0,
  hold: 0,
  decided: 0,
  mergePrecision: null,
  closePrecision: null,
  ...over,
});
const report = (rows: GateEvalRow[]): GateEvalReport => ({ rows, hasSignal: rows.some((r) => r.decided >= 10) });

/** A stub FlagStore (the injected seam — the live D1-backed store is deferred infra). */
function stubFlags(over: Partial<FlagStore> = {}): {
  flags: FlagStore;
  isHoldOnly: ReturnType<typeof vi.fn>;
  isCloseHoldOnly: ReturnType<typeof vi.fn>;
  setFlag: ReturnType<typeof vi.fn>;
  flagSetAt: ReturnType<typeof vi.fn>;
} {
  const isHoldOnly = vi.fn(async (_project: string) => false);
  const isCloseHoldOnly = vi.fn(async (_project: string) => false);
  const setFlag = vi.fn(async (_key: string, _on: boolean) => undefined);
  const flagSetAt = vi.fn(async (_key: string): Promise<string | null> => null);
  const flags: FlagStore = { isHoldOnly, isCloseHoldOnly, setFlag, flagSetAt, ...over };
  return { flags, isHoldOnly, isCloseHoldOnly, setFlag, flagSetAt };
}

describe("planAutoTune (#self-improve) — circuit-breaker is one-directional", () => {
  it("engages when merge precision drops below the floor over a real sample", () => {
    const a = planAutoTune(report([row({ project: "gittensory", decided: 20, wouldMerge: 12, mergeConfirmed: 8, mergePrecision: 0.66 })]));
    expect(a).toHaveLength(1);
    expect(a[0]?.project).toBe("gittensory");
    expect(a[0]?.message).toMatch(/Auto-merge DISABLED/);
  });
  it("does NOT engage on a thin sample (< min decided)", () => {
    expect(planAutoTune(report([row({ project: "p", decided: 5, wouldMerge: 5, mergeConfirmed: 2, mergePrecision: 0.4 })]))).toHaveLength(0);
  });
  it("does NOT engage when precision is healthy (it only ever tightens, never loosens)", () => {
    expect(planAutoTune(report([row({ project: "p", decided: 30, wouldMerge: 30, mergeConfirmed: 29, mergePrecision: 0.97 })]))).toHaveLength(0);
  });
});

describe("applyAutoTune", () => {
  it("sets the holdonly flag for a newly-flagged project", async () => {
    const { flags, setFlag } = stubFlags();
    const engaged = await applyAutoTune(flags, report([row({ project: "g", decided: 20, wouldMerge: 10, mergeConfirmed: 5, mergePrecision: 0.5 })]));
    expect(engaged).toHaveLength(1);
    expect(setFlag).toHaveBeenCalledWith("holdonly:g", true);
  });
  it("does not re-engage (or re-alert) a project already held", async () => {
    const { flags, setFlag } = stubFlags({ isHoldOnly: vi.fn(async () => true) });
    const engaged = await applyAutoTune(flags, report([row({ project: "g", decided: 20, wouldMerge: 10, mergeConfirmed: 5, mergePrecision: 0.5 })]));
    expect(engaged).toHaveLength(0);
    expect(setFlag).not.toHaveBeenCalled();
  });
  it("swallows a write error and continues (fail-safe)", async () => {
    const { flags } = stubFlags({
      setFlag: vi.fn(async () => {
        throw new Error("d1 down");
      }),
    });
    const engaged = await applyAutoTune(flags, report([row({ project: "g", decided: 20, wouldMerge: 10, mergeConfirmed: 5, mergePrecision: 0.5 })]));
    expect(engaged).toHaveLength(0); // not pushed because the write threw
  });
});

describe("shouldAutoClear (#272 recovery-gated breaker auto-clear)", () => {
  const now = Date.parse("2026-06-20T12:00:00Z");
  const past = new Date(now - AUTOCLEAR_AFTER_MS - 3_600_000).toISOString(); // >24h ago
  const recent = new Date(now - 3_600_000).toISOString(); // 1h ago
  const recovered = report([row({ project: "g", decided: 20, wouldMerge: 20, mergeConfirmed: 20, mergePrecision: 1.0 })]);
  const failing = report([row({ project: "g", decided: 20, wouldMerge: 10, mergeConfirmed: 5, mergePrecision: 0.5 })]);
  it("never clears when not auto-engaged for this project (setAt null = global/human breaker)", () => {
    expect(shouldAutoClear(recovered, "g", null, now)).toBe(false);
  });
  it("waits out the cooldown", () => {
    expect(shouldAutoClear(recovered, "g", recent, now)).toBe(false);
  });
  it("clears after cooldown once precision recovered (or there's no recent merge signal)", () => {
    expect(shouldAutoClear(recovered, "g", past, now)).toBe(true);
    expect(shouldAutoClear(report([]), "g", past, now)).toBe(true);
  });
  it("keeps the breaker engaged if precision is STILL failing after cooldown", () => {
    expect(shouldAutoClear(failing, "g", past, now)).toBe(false);
  });
  it("parses a SQLite 'YYYY-MM-DD HH:MM:SS' (UTC, no zone) timestamp as UTC, not local (#272 tz-fix)", () => {
    const sqlite = new Date(now - AUTOCLEAR_AFTER_MS - 3_600_000).toISOString().slice(0, 19).replace("T", " "); // 25h ago, SQLite format
    expect(shouldAutoClear(recovered, "g", sqlite, now)).toBe(true);
    const sqliteRecent = new Date(now - 3_600_000).toISOString().slice(0, 19).replace("T", " "); // 1h ago
    expect(shouldAutoClear(recovered, "g", sqliteRecent, now)).toBe(false);
  });
  it("maybeAutoClearHoldOnly clears the flag when due", async () => {
    const { flags, setFlag } = stubFlags({ flagSetAt: vi.fn(async () => past) });
    expect(await maybeAutoClearHoldOnly(flags, recovered, "g", now)).toBe(true);
    expect(setFlag).toHaveBeenCalledWith("holdonly:g", false);
  });
  it("maybeAutoClearHoldOnly does NOT clear while still in cooldown", async () => {
    const { flags, setFlag } = stubFlags({ flagSetAt: vi.fn(async () => recent) });
    expect(await maybeAutoClearHoldOnly(flags, recovered, "g", now)).toBe(false);
    expect(setFlag).not.toHaveBeenCalled();
  });
  it("maybeAutoClearHoldOnly swallows a read error and stays held (fail-safe catch)", async () => {
    // flagSetAt throwing exercises the try/catch around the clear path: it must fail CLOSED (return false,
    // breaker stays engaged) and never call setFlag — a DB blip can't silently re-enable auto-merge.
    const setFlag = vi.fn(async () => undefined);
    const flags: FlagStore = {
      isHoldOnly: vi.fn(async () => true),
      isCloseHoldOnly: vi.fn(async () => true),
      setFlag,
      flagSetAt: vi.fn(async () => {
        throw new Error("d1 read down");
      }),
    };
    expect(await maybeAutoClearHoldOnly(flags, recovered, "g", now)).toBe(false);
    expect(setFlag).not.toHaveBeenCalled();
  });
});

// ── CLOSE-precision circuit-breaker (symmetric mirror of the merge breaker) ─────────────────────────────────

describe("planCloseAutoTune (#close-precision-breaker) — tightening-only, close direction", () => {
  it("engages when CLOSE precision drops below the floor over a real sample", () => {
    const a = planCloseAutoTune(report([row({ project: "gittensory", decided: 20, wouldClose: 12, closeConfirmed: 8, closePrecision: 0.66 })]));
    expect(a).toHaveLength(1);
    expect(a[0]?.project).toBe("gittensory");
    expect(a[0]?.message).toMatch(/Auto-CLOSE DISABLED/);
    expect(a[0]?.message).toContain("closehold:gittensory");
  });
  it("does NOT engage on a thin would-close sample even with enough total decided PRs", () => {
    expect(planCloseAutoTune(report([row({ project: "p", decided: 20, wouldClose: 1, closeConfirmed: 0, closePrecision: 0 })]))).toHaveLength(0);
  });
  it("does NOT engage when both decided and would-close samples are thin", () => {
    expect(planCloseAutoTune(report([row({ project: "p", decided: 5, wouldClose: 5, closeConfirmed: 2, closePrecision: 0.4 })]))).toHaveLength(0);
  });
  it("does NOT engage when close precision is null (no would-close predictions with a known outcome)", () => {
    expect(planCloseAutoTune(report([row({ project: "p", decided: 30, wouldClose: 0, closeConfirmed: 0, closePrecision: null })]))).toHaveLength(0);
  });
  it("does NOT engage when close precision is healthy (it only ever tightens, never loosens)", () => {
    expect(planCloseAutoTune(report([row({ project: "p", decided: 30, wouldClose: 30, closeConfirmed: 29, closePrecision: 0.97 })]))).toHaveLength(0);
  });
});

describe("applyCloseAutoTune", () => {
  it("sets the closehold flag for a newly-flagged project", async () => {
    const { flags, setFlag } = stubFlags();
    const engaged = await applyCloseAutoTune(flags, report([row({ project: "g", decided: 20, wouldClose: 10, closeConfirmed: 5, closePrecision: 0.5 })]));
    expect(engaged).toHaveLength(1);
    expect(setFlag).toHaveBeenCalledWith("closehold:g", true);
  });
  it("does not re-engage (or re-alert) a project already close-held", async () => {
    const { flags, setFlag } = stubFlags({ isCloseHoldOnly: vi.fn(async () => true) });
    const engaged = await applyCloseAutoTune(flags, report([row({ project: "g", decided: 20, wouldClose: 10, closeConfirmed: 5, closePrecision: 0.5 })]));
    expect(engaged).toHaveLength(0);
    expect(setFlag).not.toHaveBeenCalled();
  });
  it("swallows a write error and continues (fail-safe, ev:close_tune_error)", async () => {
    const { flags } = stubFlags({
      setFlag: vi.fn(async () => {
        throw new Error("d1 down");
      }),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const engaged = await applyCloseAutoTune(flags, report([row({ project: "g", decided: 20, wouldClose: 10, closeConfirmed: 5, closePrecision: 0.5 })]));
    expect(engaged).toHaveLength(0); // not pushed because the write threw
    expect(log).toHaveBeenCalledWith(expect.stringContaining("close_tune_error"));
    log.mockRestore();
  });
});

describe("shouldAutoClearClose (#close-precision-breaker recovery-gated auto-clear)", () => {
  const now = Date.parse("2026-06-20T12:00:00Z");
  const past = new Date(now - AUTOCLEAR_AFTER_MS - 3_600_000).toISOString(); // >24h ago
  const recent = new Date(now - 3_600_000).toISOString(); // 1h ago
  const recovered = report([row({ project: "g", decided: 20, wouldClose: 20, closeConfirmed: 20, closePrecision: 1.0 })]);
  const failing = report([row({ project: "g", decided: 20, wouldClose: 10, closeConfirmed: 5, closePrecision: 0.5 })]);
  it("never clears when not auto-engaged for this project (setAt null = global/human breaker)", () => {
    expect(shouldAutoClearClose(recovered, "g", null, now)).toBe(false);
  });
  it("waits out the cooldown", () => {
    expect(shouldAutoClearClose(recovered, "g", recent, now)).toBe(false);
  });
  it("clears after cooldown once close precision recovered (or there's no recent close signal)", () => {
    expect(shouldAutoClearClose(recovered, "g", past, now)).toBe(true);
    expect(shouldAutoClearClose(report([]), "g", past, now)).toBe(true);
  });
  it("keeps the breaker engaged if close precision is STILL failing over a real close sample after cooldown", () => {
    expect(shouldAutoClearClose(failing, "g", past, now)).toBe(false);
  });
  it("clears after cooldown when the only failing close precision signal is undersampled", () => {
    const sparseFalseClose = report([row({ project: "g", decided: 20, wouldClose: 1, closeConfirmed: 0, closePrecision: 0 })]);
    expect(shouldAutoClearClose(sparseFalseClose, "g", past, now)).toBe(true);
  });
  it("parses a SQLite 'YYYY-MM-DD HH:MM:SS' (UTC, no zone) timestamp as UTC, not local", () => {
    const sqlite = new Date(now - AUTOCLEAR_AFTER_MS - 3_600_000).toISOString().slice(0, 19).replace("T", " "); // 25h ago, SQLite format
    expect(shouldAutoClearClose(recovered, "g", sqlite, now)).toBe(true);
    const sqliteRecent = new Date(now - 3_600_000).toISOString().slice(0, 19).replace("T", " "); // 1h ago
    expect(shouldAutoClearClose(recovered, "g", sqliteRecent, now)).toBe(false);
  });
  it("maybeAutoClearCloseHoldOnly clears the flag when due", async () => {
    const { flags, setFlag } = stubFlags({ flagSetAt: vi.fn(async () => past) });
    expect(await maybeAutoClearCloseHoldOnly(flags, recovered, "g", now)).toBe(true);
    expect(setFlag).toHaveBeenCalledWith("closehold:g", false);
  });
  it("maybeAutoClearCloseHoldOnly does NOT clear while still in cooldown", async () => {
    const { flags, setFlag } = stubFlags({ flagSetAt: vi.fn(async () => recent) });
    expect(await maybeAutoClearCloseHoldOnly(flags, recovered, "g", now)).toBe(false);
    expect(setFlag).not.toHaveBeenCalled();
  });
  it("maybeAutoClearCloseHoldOnly swallows a read error and stays held (fail-CLOSED catch)", async () => {
    // flagSetAt throwing exercises the try/catch around the clear path: it must fail CLOSED (return false,
    // breaker stays engaged) and never call setFlag — a DB blip can't silently re-enable auto-close.
    const setFlag = vi.fn(async () => undefined);
    const flags: FlagStore = {
      isHoldOnly: vi.fn(async () => true),
      isCloseHoldOnly: vi.fn(async () => true),
      setFlag,
      flagSetAt: vi.fn(async () => {
        throw new Error("d1 read down");
      }),
    };
    expect(await maybeAutoClearCloseHoldOnly(flags, recovered, "g", now)).toBe(false);
    expect(setFlag).not.toHaveBeenCalled();
  });
});

describe("computeTuningRecommendations (#self-improve)", () => {
  it("says READY when merge precision is high over a real sample with no false closes", () => {
    const recs = computeTuningRecommendations(report([row({ project: "gittensory", decided: 20, wouldMerge: 18, mergeConfirmed: 18, mergePrecision: 1.0 })]));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.severity).toBe("good");
    expect(recs[0]?.message).toMatch(/ready to flip live/i);
  });

  it("WARNs (do not flip) when it would auto-merge PRs the human closed", () => {
    const recs = computeTuningRecommendations(report([row({ project: "awesome-claude", decided: 20, wouldMerge: 10, mergeConfirmed: 7, mergeFalse: 3, mergePrecision: 0.7 })]));
    expect(recs[0]?.severity).toBe("warn");
    expect(recs[0]?.message).toMatch(/do NOT flip live/i);
  });

  it("attaches a TIGHTENING overridePayload (raise floor to 0.95) on a merge-precision failure (#275)", () => {
    const recs = computeTuningRecommendations(report([row({ project: "awesome-claude", decided: 20, wouldMerge: 10, mergeConfirmed: 7, mergeFalse: 3, mergePrecision: 0.7 })]));
    const warn = recs.find((r) => r.severity === "warn");
    expect(warn?.overridePayload).toEqual({ confidenceFloor: 0.95 });
  });

  it("WARNs to loosen when it would auto-close PRs the human merged — and attaches NO payload (loosening is never auto-applied)", () => {
    const recs = computeTuningRecommendations(report([row({ project: "p", decided: 15, wouldMerge: 10, mergeConfirmed: 10, mergePrecision: 1.0, wouldClose: 5, closeConfirmed: 3, closeFalse: 2, closePrecision: 0.6 })]));
    const loosen = recs.find((r) => r.severity === "warn" && /loosen/i.test(r.message));
    expect(loosen).toBeDefined();
    expect(loosen?.overridePayload).toBeUndefined();
  });

  it("asks for more data on a thin sample", () => {
    const recs = computeTuningRecommendations(report([row({ project: "p", decided: 4 })]));
    expect(recs[0]?.severity).toBe("info");
    expect(recs[0]?.message).toMatch(/more shadow data/i);
  });

  it("ranks warnings before ready/info", () => {
    const recs = computeTuningRecommendations(
      report([
        row({ project: "ready", decided: 20, wouldMerge: 20, mergeConfirmed: 20, mergePrecision: 1.0 }),
        row({ project: "risky", decided: 20, wouldMerge: 10, mergeConfirmed: 5, mergeFalse: 5, mergePrecision: 0.5 }),
      ]),
    );
    expect(recs[0]?.severity).toBe("warn");
  });

  it("renders an em-dash for a NULL close precision in the loosen-warn message (pct null branch)", () => {
    // closeFalse > 0 but closePrecision is null (e.g. no would-close predictions had a known outcome): the
    // loosen-warn message interpolates pct(null) → "—" rather than a percentage. Exercises pct's null side.
    const recs = computeTuningRecommendations(
      report([row({ project: "p", decided: 15, wouldMerge: 10, mergeConfirmed: 10, mergePrecision: 1.0, closeFalse: 2, closePrecision: null })]),
    );
    const loosen = recs.find((r) => r.severity === "warn" && /loosen/i.test(r.message));
    expect(loosen).toBeDefined();
    expect(loosen?.message).toContain("close precision —");
  });

  it("says READY when close precision is also high and non-null (ready close-precision threshold branch)", () => {
    // The "ready" guard's close arm is (closePrecision == null || closePrecision >= READY_CLOSE_PRECISION).
    // Prior ready tests only hit the null arm; this hits the non-null-and-passing arm: high merge precision,
    // no false closes, and a non-null close precision at/above the 0.9 ready bar.
    const recs = computeTuningRecommendations(
      report([row({ project: "ready2", decided: 20, wouldMerge: 18, mergeConfirmed: 18, mergePrecision: 1.0, wouldClose: 4, closeConfirmed: 4, closeFalse: 0, closePrecision: 0.95 })]),
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]?.severity).toBe("good");
    expect(recs[0]?.message).toMatch(/ready to flip live/i);
  });

  it("does NOT say ready when a non-null close precision is below the ready bar (close arm fails)", () => {
    // Same ready conditions but closePrecision below READY_CLOSE_PRECISION (0.9) and no false closes → neither
    // warn nor good fires, so the project yields no recommendation. Asserts the close arm gates 'good'.
    const recs = computeTuningRecommendations(
      report([row({ project: "borderline", decided: 20, wouldMerge: 18, mergeConfirmed: 18, mergePrecision: 1.0, wouldClose: 4, closeConfirmed: 3, closeFalse: 0, closePrecision: 0.8 })]),
    );
    expect(recs).toHaveLength(0);
  });

  it("breaks a severity tie by project name (sort localeCompare fallback)", () => {
    // Two projects with the SAME severity (both 'good') force the sort comparator's secondary key —
    // a.project.localeCompare(b.project) — which the primary severity-order key alone never exercises.
    const recs = computeTuningRecommendations(
      report([
        row({ project: "zeta", decided: 20, wouldMerge: 20, mergeConfirmed: 20, mergePrecision: 1.0 }),
        row({ project: "alpha", decided: 20, wouldMerge: 20, mergeConfirmed: 20, mergePrecision: 1.0 }),
      ]),
    );
    expect(recs.map((r) => r.project)).toEqual(["alpha", "zeta"]);
  });
});
