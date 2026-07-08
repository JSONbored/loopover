import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLastReviewRecapAttemptedAt,
  getLastReviewRecapAttemptedAtBulk,
  performReviewRecap,
} from "../../src/services/review-recap-runner";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("review-recap runner (#1963)", () => {
  it("returns null before any attempt marker exists", async () => {
    const env = createTestEnv();
    expect(await getLastReviewRecapAttemptedAt(env, REPO)).toBeNull();
  });

  it("records an attempt marker even when Discord delivery is denied", async () => {
    const env = createTestEnv();
    const result = await performReviewRecap(env, REPO, { windowDays: 7, nowIso: "2026-07-08T00:00:00.000Z" });
    expect(result.delivery.sent).toBe(false);
    expect(await getLastReviewRecapAttemptedAt(env, REPO)).not.toBeNull();
  });

  it("bulk-loads attempt markers keyed by repo full name", async () => {
    const env = createTestEnv();
    await performReviewRecap(env, "owner/attempted", { windowDays: 7, nowIso: "2026-07-08T00:00:00.000Z" });
    const bulk = await getLastReviewRecapAttemptedAtBulk(env, ["owner/attempted", "owner/never"]);
    expect(bulk.get("owner/attempted")?.generatedAt).toBeTruthy();
    expect(bulk.get("owner/never")).toBeUndefined();
  });

  it("returns an empty bulk map for an empty repo list", async () => {
    const env = createTestEnv();
    expect(await getLastReviewRecapAttemptedAtBulk(env, [])).toEqual(new Map());
  });
});
