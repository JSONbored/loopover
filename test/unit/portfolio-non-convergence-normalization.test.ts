import { describe, expect, it } from "vitest";

import {
  classifyPortfolioConvergence,
  type PortfolioConvergenceInput,
} from "../../packages/loopover-engine/src/portfolio/non-convergence";

// #6173: classifyPortfolioConvergence is composed into the same fail-closed ladder as governor/budget-cap.ts
// and governor/rate-limit.ts, but read its counts raw. A NaN/negative value failed every `>=` threshold check
// and the trailing `> 0` check, so it quietly returned "converging" — the ALLOW-equivalent verdict — where its
// siblings fail toward deny, and printed NaN into the reasons a maintainer reads.
//
// The engine package's own suite (packages/loopover-engine/test/portfolio-non-convergence.test.ts) covers this
// too, but it runs under node:test against dist/, which produces no coverage signal for src/. These exercise
// the same normalization through the SOURCE path, which is what Codecov measures.

const base: PortfolioConvergenceInput = { attempts: 0, consecutiveFailures: 0, reenqueues: 0, reachedDone: false };

describe("classifyPortfolioConvergence input normalization (#6173)", () => {
  it("fails CLOSED on a malformed threshold — the direction budget-cap.ts's malformed ceiling produces", () => {
    // budget-cap: a non-finite limit clamps to 0, so `used >= limit` (0 >= 0) reads exceeded. Same clamp here
    // makes `consecutiveFailures >= maxConsecutiveFailures` (0 >= 0) read non_convergent, not converging.
    const verdict = classifyPortfolioConvergence(
      { ...base, attempts: 1, consecutiveFailures: Number.NaN, reenqueues: -3 },
      { maxConsecutiveFailures: Number.NaN, maxReenqueues: Number.POSITIVE_INFINITY },
    );
    expect(verdict.status).toBe("non_convergent");
  });

  it("clamps NaN/negative counts to 0 instead of letting them decide the verdict", () => {
    const verdict = classifyPortfolioConvergence({ ...base, attempts: 4, consecutiveFailures: Number.NaN, reenqueues: -2 });
    expect(verdict.status).toBe("converging");
    expect(verdict.reasons.join(" ")).not.toMatch(/NaN|-\d/);
  });

  it("a non-finite attempts count reads converging, not a streak on an item never attempted", () => {
    // Unnormalized, `NaN <= 0` was false, so the no-attempts guard was skipped entirely.
    const verdict = classifyPortfolioConvergence({ ...base, attempts: Number.NaN, consecutiveFailures: 5, reenqueues: 5 });
    expect(verdict.status).toBe("converging");
    expect(verdict.reasons.join(" ")).toMatch(/first attempt/i);
  });

  it("floors fractional counts, matching rate-limit.ts's integer discipline", () => {
    const verdict = classifyPortfolioConvergence({ ...base, attempts: 3, consecutiveFailures: 3.9 });
    expect(verdict.status).toBe("non_convergent");
    expect(verdict.reasons.join(" ")).toContain("3 consecutive failures");
  });

  it("normalizes the re-enqueue arm independently of the failure arm", () => {
    const verdict = classifyPortfolioConvergence({ ...base, attempts: 3, consecutiveFailures: -1, reenqueues: 3.7 });
    expect(verdict.status).toBe("non_convergent");
    expect(verdict.reasons.join(" ")).toContain("re-enqueued 3 times");
  });

  describe("legitimate input still classifies exactly as before", () => {
    it("reached done wins over any streak", () => {
      expect(classifyPortfolioConvergence({ attempts: 4, consecutiveFailures: 9, reenqueues: 9, reachedDone: true }).status).toBe("converging");
    });

    it("a below-threshold streak is stalled (both arms of the stalled OR)", () => {
      expect(classifyPortfolioConvergence({ ...base, attempts: 2, consecutiveFailures: 1 }).status).toBe("stalled");
      expect(classifyPortfolioConvergence({ ...base, attempts: 2, reenqueues: 1 }).status).toBe("stalled");
    });

    it("an at-threshold streak is non_convergent, and both streaks surface both reasons", () => {
      expect(classifyPortfolioConvergence({ ...base, attempts: 3, consecutiveFailures: 3 }).status).toBe("non_convergent");
      expect(classifyPortfolioConvergence({ ...base, attempts: 6, consecutiveFailures: 4, reenqueues: 5 }).reasons).toHaveLength(2);
    });

    it("attempts in progress with no streak is converging", () => {
      expect(classifyPortfolioConvergence({ ...base, attempts: 5 }).reasons.join(" ")).toMatch(/no failure streak/i);
    });

    it("zero attempts is converging", () => {
      expect(classifyPortfolioConvergence({ ...base, attempts: 0 }).status).toBe("converging");
    });
  });
});
