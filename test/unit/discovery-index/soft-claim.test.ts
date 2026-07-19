import { describe, expect, it } from "vitest";
import { TtlCache } from "../../../packages/discovery-index/src/cache";
import { parseSoftClaimRequest, softClaimKey, SoftClaimStore } from "../../../packages/discovery-index/src/soft-claim";

function clock(startMs = 0) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("parseSoftClaimRequest (#7166)", () => {
  it("parses a valid claim request", () => {
    expect(parseSoftClaimRequest({ repoFullName: "acme/widgets", issueNumber: 42, action: "claim" })).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 42,
      action: "claim",
    });
  });

  it("parses a valid release request", () => {
    expect(parseSoftClaimRequest({ repoFullName: "acme/widgets", issueNumber: 42, action: "release" })).toEqual({
      repoFullName: "acme/widgets",
      issueNumber: 42,
      action: "release",
    });
  });

  it("rejects a non-object or array payload", () => {
    expect(parseSoftClaimRequest(null)).toBeNull();
    expect(parseSoftClaimRequest("nope")).toBeNull();
    expect(parseSoftClaimRequest([])).toBeNull();
  });

  it("rejects a malformed repoFullName", () => {
    for (const repoFullName of ["no-slash", "/repo", "owner/", "a/b/c", 123, undefined]) {
      expect(parseSoftClaimRequest({ repoFullName, issueNumber: 1, action: "claim" })).toBeNull();
    }
  });

  it("rejects an invalid issueNumber", () => {
    for (const issueNumber of [0, -1, 1.5, "42", undefined, null]) {
      expect(parseSoftClaimRequest({ repoFullName: "a/b", issueNumber, action: "claim" })).toBeNull();
    }
  });

  it("rejects an unknown action", () => {
    expect(parseSoftClaimRequest({ repoFullName: "a/b", issueNumber: 1, action: "delete" })).toBeNull();
    expect(parseSoftClaimRequest({ repoFullName: "a/b", issueNumber: 1 })).toBeNull();
  });

  it("never reads note, instanceId, or any other field from the payload", () => {
    const parsed = parseSoftClaimRequest({
      repoFullName: "a/b",
      issueNumber: 1,
      action: "claim",
      note: "secret plan",
      instanceId: "abc",
      reward: 100,
    });
    expect(parsed).toEqual({ repoFullName: "a/b", issueNumber: 1, action: "claim" });
  });
});

describe("softClaimKey (#7166)", () => {
  it("combines repoFullName and issueNumber into a stable key", () => {
    expect(softClaimKey("acme/widgets", 42)).toBe("acme/widgets#42");
  });
});

describe("SoftClaimStore (#7166)", () => {
  it("accepts a fresh claim on an unclaimed key", () => {
    const store = new SoftClaimStore(new TtlCache(), 1000);
    expect(store.claim("k")).toEqual({ accepted: true, ageMs: null });
  });

  it("reports an already-held claim's age on a repeat claim, and refreshes its TTL", () => {
    const c = clock();
    const store = new SoftClaimStore(new TtlCache(c.now), 1000, c.now);
    expect(store.claim("k")).toEqual({ accepted: true, ageMs: null });
    c.advance(300);
    expect(store.claim("k")).toEqual({ accepted: false, ageMs: 300 });
    // The refresh extended the TTL from t=300, so the claim is still active at t=1000 (300 + 1000 > 1000
    // total elapsed since t=0 would have expired an un-refreshed claim by now).
    c.advance(700);
    expect(store.claim("k")).toEqual({ accepted: false, ageMs: 1000 });
  });

  it("allows reclaiming an expired claim, resetting its age", () => {
    const c = clock();
    const store = new SoftClaimStore(new TtlCache(c.now), 100, c.now);
    expect(store.claim("k")).toEqual({ accepted: true, ageMs: null });
    c.advance(101);
    expect(store.claim("k")).toEqual({ accepted: true, ageMs: null });
  });

  it("release removes an active claim so the next claim is fresh", () => {
    const store = new SoftClaimStore(new TtlCache(), 1000);
    store.claim("k");
    store.release("k");
    expect(store.claim("k")).toEqual({ accepted: true, ageMs: null });
  });

  it("release on an absent key is a harmless no-op", () => {
    const store = new SoftClaimStore(new TtlCache(), 1000);
    expect(() => store.release("never-claimed")).not.toThrow();
  });

  it("keeps two different keys' claims independent", () => {
    const store = new SoftClaimStore(new TtlCache(), 1000);
    expect(store.claim("a")).toEqual({ accepted: true, ageMs: null });
    expect(store.claim("b")).toEqual({ accepted: true, ageMs: null });
    expect(store.claim("a")).toMatchObject({ accepted: false });
  });
});
