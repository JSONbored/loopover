import { describe, expect, it } from "vitest";
import {
  isReviewExecutionJob,
  isSelfHostedReviewRuntime,
} from "../../src/selfhost/review-runtime";

describe("self-host review runtime routing", () => {
  it("detects the Redis-backed self-host review runtime", () => {
    expect(
      isSelfHostedReviewRuntime({
        SELFHOST_TRANSIENT_CACHE: {
          get: async () => null,
          set: async () => undefined,
        },
      } as Pick<Env, "SELFHOST_TRANSIENT_CACHE">),
    ).toBe(true);
    expect(
      isSelfHostedReviewRuntime({} as Pick<Env, "SELFHOST_TRANSIENT_CACHE">),
    ).toBe(false);
  });

  it("classifies only review-execution jobs as self-host-only", () => {
    expect(isReviewExecutionJob({ type: "github-webhook" } as never)).toBe(
      true,
    );
    expect(isReviewExecutionJob({ type: "rag-index-repo" } as never)).toBe(
      true,
    );
    expect(isReviewExecutionJob({ type: "refresh-registry" } as never)).toBe(
      false,
    );
    expect(isReviewExecutionJob(null)).toBe(false);
    expect(isReviewExecutionJob(undefined)).toBe(false);
  });
});
