import { describe, expect, it } from "vitest";

import {
  recordVerdict,
  shouldSkipStableVerdict,
  verdictBackoffDelayMs,
  verdictFingerprint,
  VERDICT_BACKOFF_BASE_MS,
  VERDICT_BACKOFF_CAP_MS,
  VERDICT_BACKOFF_MIN_REPEATS,
  verdictStabilityKey,
  readVerdictStability,
  writeVerdictStability,
  type VerdictStabilityState,
} from "../../src/review/verdict-stability";

// #10184: metagraphed#8886 was evaluated 56 times on ONE unchanged commit in 47 minutes, producing the
// identical `hold | missing_linked_issue` every time. Four such PRs made 66% of all decision records in a
// two-hour window, and the same window exhausted the installation's GitHub REST quota.
//
// Every test below is about a way this control could be worse than the problem: stranding a PR it should
// still revisit, engaging on a verdict that is actually moving, or failing closed on missing state.

const HOLD = { action: "hold", reasonCode: "missing_linked_issue", holdCause: null };

describe("verdictFingerprint", () => {
  it("is the DECISION fields and nothing else", () => {
    expect(verdictFingerprint(HOLD)).toBe("hold|missing_linked_issue|");
    expect(verdictFingerprint({ action: "hold", reasonCode: "success", holdCause: "guardrailHit" })).toBe("hold|success|guardrailHit");
  });

  it("separates verdicts that differ only by hold cause", () => {
    // #9991 exists precisely because "hold / success" conflated seven mechanisms. Two different causes are
    // two different answers, and treating them as one would back off through a genuine change.
    const a = verdictFingerprint({ action: "hold", reasonCode: "success", holdCause: "guardrailHit" });
    const b = verdictFingerprint({ action: "hold", reasonCode: "success", holdCause: "screenshotEvidenceHold" });
    expect(a).not.toBe(b);
  });

  it("treats null and absent hold cause identically", () => {
    expect(verdictFingerprint({ action: "merge", reasonCode: "success" })).toBe(
      verdictFingerprint({ action: "merge", reasonCode: "success", holdCause: null }),
    );
  });
});

describe("verdictBackoffDelayMs", () => {
  it("is ZERO below the threshold — the common path is untouched", () => {
    // A PR whose verdict is still moving must behave exactly as it did before this existed.
    for (let n = 0; n < VERDICT_BACKOFF_MIN_REPEATS; n += 1) {
      expect(verdictBackoffDelayMs(n), `repeats=${n}`).toBe(0);
    }
  });

  it("engages at the threshold and grows exponentially", () => {
    expect(verdictBackoffDelayMs(VERDICT_BACKOFF_MIN_REPEATS)).toBe(VERDICT_BACKOFF_BASE_MS);
    expect(verdictBackoffDelayMs(VERDICT_BACKOFF_MIN_REPEATS + 1)).toBe(VERDICT_BACKOFF_BASE_MS * 2);
    expect(verdictBackoffDelayMs(VERDICT_BACKOFF_MIN_REPEATS + 2)).toBe(VERDICT_BACKOFF_BASE_MS * 4);
  });

  it("INVARIANT: never exceeds the cap, however long a PR stays stuck", () => {
    // The liveness property. An uncapped backoff would turn a spend bug into a PR nobody ever looks at again.
    for (const repeats of [10, 50, 500, 10_000]) {
      expect(verdictBackoffDelayMs(repeats), `repeats=${repeats}`).toBeLessThanOrEqual(VERDICT_BACKOFF_CAP_MS);
    }
  });

  it("stays finite at an absurd repeat count — the cap, not an exponent clamp, is what bounds this", () => {
    // `2 ** 1000` is Infinity and `Math.min(Infinity, cap)` is the cap, so the cap alone is sufficient. An
    // earlier version also clamped the exponent; mutation testing showed no test could tell the difference,
    // so the clamp was removed rather than kept as an unverifiable second guard.
    expect(Number.isFinite(verdictBackoffDelayMs(1000))).toBe(true);
    expect(verdictBackoffDelayMs(1000)).toBe(VERDICT_BACKOFF_CAP_MS);
  });

  it("is monotonic — more repeats never means a shorter wait", () => {
    let prev = -1;
    for (let n = 0; n <= 20; n += 1) {
      const d = verdictBackoffDelayMs(n);
      expect(d, `repeats=${n}`).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe("recordVerdict", () => {
  it("counts consecutive identical verdicts", () => {
    let state: VerdictStabilityState | null = null;
    for (let i = 1; i <= 5; i += 1) state = recordVerdict(state, HOLD, i * 1000);
    expect(state?.repeats).toBe(5);
  });

  it("REGRESSION: a CHANGED verdict resets the count to 1", () => {
    // The answer moved, so everything learned about its stability is void. Without this, a PR that flipped
    // between two states would keep backing off as though settled.
    let state = recordVerdict(null, HOLD, 1000);
    state = recordVerdict(state, HOLD, 2000);
    state = recordVerdict(state, { action: "merge", reasonCode: "success" }, 3000);
    expect(state.repeats).toBe(1);
    expect(state.fingerprint).toBe("merge|success|");
  });

  it("resets when only the hold cause changes", () => {
    let state = recordVerdict(null, { action: "hold", reasonCode: "success", holdCause: "guardrailHit" }, 1000);
    state = recordVerdict(state, { action: "hold", reasonCode: "success", holdCause: "advisoryCheckHold" }, 2000);
    expect(state.repeats).toBe(1);
  });
});

describe("shouldSkipStableVerdict", () => {
  const settled = (nowMs: number): VerdictStabilityState => ({
    fingerprint: verdictFingerprint(HOLD),
    repeats: VERDICT_BACKOFF_MIN_REPEATS,
    lastEvaluatedMs: nowMs,
  });

  it("skips while the backoff window is open", () => {
    expect(shouldSkipStableVerdict(settled(0), VERDICT_BACKOFF_BASE_MS - 1)).toBe(true);
  });

  it("evaluates again once the window has elapsed", () => {
    expect(shouldSkipStableVerdict(settled(0), VERDICT_BACKOFF_BASE_MS)).toBe(false);
    expect(shouldSkipStableVerdict(settled(0), VERDICT_BACKOFF_BASE_MS + 1)).toBe(false);
  });

  it("FAILS OPEN with no prior state", () => {
    // Missing state must never suppress a review. Failing closed here would silently stop reviewing PRs --
    // far worse than the churn this prevents.
    expect(shouldSkipStableVerdict(null, Date.now())).toBe(false);
  });

  it("FAILS OPEN below the repeat threshold, however recent the last evaluation", () => {
    const fresh: VerdictStabilityState = { fingerprint: verdictFingerprint(HOLD), repeats: 1, lastEvaluatedMs: 1000 };
    expect(shouldSkipStableVerdict(fresh, 1001)).toBe(false);
  });

  it("REGRESSION: only a HOLD is ever backed off — a pass that ACTED is never throttled", () => {
    // "Same verdict" is not "nothing happened". A pass can take real actions (update-branch, cap accounting,
    // assignment) and still produce an unchanged verdict; throttling that suppresses progress. Caught by the
    // force-fresh-rebase test (#9497/#2552), where three deliberate identical passes spend the 24h
    // update-branch cap and an earlier version of this backoff swallowed the third.
    for (const action of ["merge", "close", "update_branch", "approve", "label"]) {
      const acted: VerdictStabilityState = {
        fingerprint: verdictFingerprint({ action, reasonCode: "success" }),
        repeats: 99,
        lastEvaluatedMs: 0,
      };
      expect(shouldSkipStableVerdict(acted, 1), action).toBe(false);
    }
    // ...while the hold this exists for still backs off.
    const held: VerdictStabilityState = { fingerprint: verdictFingerprint(HOLD), repeats: 99, lastEvaluatedMs: 0 };
    expect(shouldSkipStableVerdict(held, 1)).toBe(true);
  });

  it("INVARIANT: a stuck PR is always revisited within the cap", () => {
    // The liveness guarantee stated as a property rather than trusted from the delay function.
    const veryStuck: VerdictStabilityState = { fingerprint: verdictFingerprint(HOLD), repeats: 9999, lastEvaluatedMs: 0 };
    expect(shouldSkipStableVerdict(veryStuck, VERDICT_BACKOFF_CAP_MS)).toBe(false);
  });
});

describe("persistence (#10184)", () => {
  const makeCache = () => {
    const store = new Map<string, string>();
    return {
      store,
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
    };
  };

  it("keys on the head SHA, so a new commit starts clean", () => {
    // The reset-on-new-commit rule is structural rather than something a caller must remember.
    const a = verdictStabilityKey("Acme/Widgets", 7, "aaa");
    const b = verdictStabilityKey("acme/widgets", 7, "bbb");
    expect(a).not.toBe(b);
    expect(a).toBe(verdictStabilityKey("acme/widgets", 7, "aaa")); // repo case-insensitive
  });

  it("round-trips state", async () => {
    const cache = makeCache();
    const key = verdictStabilityKey("acme/widgets", 7, "aaa");
    const state = recordVerdict(null, HOLD, 1000);
    await writeVerdictStability(cache, key, state);
    expect(await readVerdictStability(cache, key)).toEqual(state);
  });

  it("FAILS OPEN on absent, malformed, or mistyped state", async () => {
    // Every one of these must let the evaluation proceed. Returning a bogus state instead would suppress a
    // review on corrupt data -- the one outcome worse than the churn this prevents.
    const cache = makeCache();
    expect(await readVerdictStability(cache, "missing")).toBeNull();
    cache.store.set("bad-json", "{not json");
    expect(await readVerdictStability(cache, "bad-json")).toBeNull();
    cache.store.set("wrong-shape", JSON.stringify({ fingerprint: 1, repeats: "x" }));
    expect(await readVerdictStability(cache, "wrong-shape")).toBeNull();
    cache.store.set("nan", JSON.stringify({ fingerprint: "f", repeats: Number.NaN, lastEvaluatedMs: 1 }));
    expect(await readVerdictStability(cache, "nan")).toBeNull();
  });

  it("FAILS OPEN with no cache configured at all", async () => {
    expect(await readVerdictStability(undefined, "k")).toBeNull();
    await expect(writeVerdictStability(undefined, "k", recordVerdict(null, HOLD, 1))).resolves.toBeUndefined();
  });

  it("a throwing cache never propagates — telemetry must not fail the pass carrying it", async () => {
    const broken = { get: async () => { throw new Error("boom"); }, set: async () => { throw new Error("boom"); } };
    expect(await readVerdictStability(broken, "k")).toBeNull();
    await expect(writeVerdictStability(broken, "k", recordVerdict(null, HOLD, 1))).resolves.toBeUndefined();
  });
});
