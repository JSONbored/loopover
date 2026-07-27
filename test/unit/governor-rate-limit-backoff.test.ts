import { describe, expect, it } from "vitest";
import { evaluateLocalRateLimit } from "../../packages/loopover-engine/src/governor/rate-limit";

// #5829: rate-limit.ts had no dedicated test — it was only exercised indirectly, never with `nowMs` moving BACKWARD
// relative to a bucket's `windowStartMs`. These pin `retryAfterMs` to at most one window regardless of clock jumps.
describe("evaluateLocalRateLimit retryAfterMs clamp (#5829)", () => {
  const config = { limit: 5, windowMs: 60_000 };

  it("reports no wait when the event is allowed", () => {
    const decision = evaluateLocalRateLimit({ count: 2, windowStartMs: 0 }, config, 1_000);
    expect(decision.allowed).toBe(true);
    expect(decision.retryAfterMs).toBe(0);
  });

  it("reports the remaining window when blocked under a normal forward clock (no clamp needed)", () => {
    const decision = evaluateLocalRateLimit({ count: 5, windowStartMs: 0 }, config, 30_000);
    expect(decision.allowed).toBe(false);
    // resetAt (0 + 60_000) minus now (30_000) is already within one window, so the clamp is a no-op.
    expect(decision.retryAfterMs).toBe(30_000);
  });

  it("clamps retryAfterMs to at most windowMs after a BACKWARD clock jump", () => {
    // The recorded window start is far AHEAD of `now` — a clock that stepped backward (NTP/VM reset). Pre-fix this
    // returned resetAt (100_000 + 60_000) - now (0) = 160_000, ~2.6x the configured 60s window.
    const decision = evaluateLocalRateLimit({ count: 5, windowStartMs: 100_000 }, config, 0);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBe(config.windowMs); // clamped to 60_000, not 160_000
    expect(decision.retryAfterMs).toBeLessThanOrEqual(config.windowMs);
  });
});
