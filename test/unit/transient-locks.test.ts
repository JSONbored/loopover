import { describe, expect, it } from "vitest";
import { claimTransientLock, releaseTransientLockIfOwner } from "../../src/queue/transient-locks";
import { createTestEnv } from "../helpers/d1";

// #4013 step 1: claimPrActuationLock/releasePrActuationLock/claimAiReviewLock/releaseAiReviewLock's own
// extensive existing coverage (test/unit/queue.test.ts, unmoved -- see the re-export shim in processors.ts)
// already exercises claimTransientLock/releaseTransientLockIfOwner indirectly through every domain wrapper.
// This file closes the ONE gap that extraction exposed: every existing "claim() throws" test's mock cache
// omits releaseIfValue, so it hits claimTransientLock's EARLIER `!cache.releaseIfValue` fail-open branch and
// never actually reaches the try/catch around cache.claim() itself -- a pre-existing gap invisible before
// because it was diluted inside processors.ts's aggregate coverage, not something this extraction introduced.

describe("claimTransientLock — the catch(cache.claim() throws) fail-open branch (#4013 step 1 gap close)", () => {
  it("fails OPEN when cache.claim() itself throws, even with releaseIfValue present (reaches the try/catch, not the earlier releaseIfValue guard)", async () => {
    const env = createTestEnv({
      SELFHOST_TRANSIENT_CACHE: {
        get: async () => null,
        set: async () => undefined,
        claim: async () => {
          throw new Error("redis unavailable");
        },
        releaseIfValue: async () => true,
      },
    });
    const result = await claimTransientLock(env, "some-lock-key", 600);
    expect(result).toEqual({ acquired: true, ownerToken: null });
  });
});

describe("releaseTransientLockIfOwner — no-op when there's no releaseIfValue primitive to release against (#4013 step 1 gap close)", () => {
  it("no-ops (never throws) when SELFHOST_TRANSIENT_CACHE isn't configured at all, given a real owner token", async () => {
    const env = createTestEnv({});
    delete env.SELFHOST_TRANSIENT_CACHE;
    await expect(releaseTransientLockIfOwner(env, "some-lock-key", "a-real-token")).resolves.toBeUndefined();
  });
});
