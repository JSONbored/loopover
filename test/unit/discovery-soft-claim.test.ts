import { describe, expect, it } from "vitest";
import {
  DISCOVERY_INDEX_CONTRACT_VERSION,
  buildSoftClaimRequest,
  softClaimActionForStatus,
} from "../../packages/gittensory-engine/src/index";

const ACTIVE_CLAIM = {
  id: 7,
  repoFullName: "owner/repo",
  issueNumber: 42,
  claimedAt: "2026-01-01T00:00:00Z",
  status: "active" as const,
  note: "picked from the miner lane",
};

describe("soft-claim coordination request builder (#4302)", () => {
  it("re-exports the builder API from the engine barrel", () => {
    expect(typeof buildSoftClaimRequest).toBe("function");
    expect(typeof softClaimActionForStatus).toBe("function");
  });

  it("builds a public-safe claim request from an active claim, copying only known fields", () => {
    const req = buildSoftClaimRequest(ACTIVE_CLAIM, { instanceId: "inst-abc" });
    expect(req).toEqual({
      contractVersion: DISCOVERY_INDEX_CONTRACT_VERSION,
      action: "claim",
      repoFullName: "owner/repo",
      issueNumber: 42,
      claimedAt: "2026-01-01T00:00:00Z",
      note: "picked from the miner lane",
      instanceId: "inst-abc",
    });
    // the local ledger `id` is not leaked into the outbound request
    expect(Object.keys(req ?? {})).not.toContain("id");
  });

  it("maps released/expired claims to a release action", () => {
    expect(softClaimActionForStatus("active")).toBe("claim");
    expect(softClaimActionForStatus("released")).toBe("release");
    expect(softClaimActionForStatus("expired")).toBe("release");
    expect(buildSoftClaimRequest({ ...ACTIVE_CLAIM, status: "released" })?.action).toBe("release");
    expect(buildSoftClaimRequest({ ...ACTIVE_CLAIM, status: "expired" })?.action).toBe("release");
  });

  it("normalizes note and instanceId to null when blank, non-string, or absent", () => {
    expect(buildSoftClaimRequest({ ...ACTIVE_CLAIM, note: "   " })?.note).toBeNull();
    expect(buildSoftClaimRequest({ ...ACTIVE_CLAIM, note: 5 })?.note).toBeNull();
    expect(buildSoftClaimRequest({ ...ACTIVE_CLAIM, note: undefined })?.note).toBeNull();
    expect(buildSoftClaimRequest(ACTIVE_CLAIM)?.instanceId).toBeNull();
    expect(buildSoftClaimRequest(ACTIVE_CLAIM, { instanceId: "   " })?.instanceId).toBeNull();
    expect(buildSoftClaimRequest(ACTIVE_CLAIM, { instanceId: 9 as unknown as string })?.instanceId).toBeNull();
  });

  it("returns null for a non-object claim", () => {
    for (const bad of [null, undefined, 42, "claim", [ACTIVE_CLAIM]]) {
      expect(buildSoftClaimRequest(bad)).toBeNull();
    }
  });

  it("returns null for an invalid repoFullName", () => {
    for (const repoFullName of [123, "no-slash", "owner/", "/repo", "a/b/c"]) {
      expect(buildSoftClaimRequest({ ...ACTIVE_CLAIM, repoFullName })).toBeNull();
    }
  });

  it("returns null for an invalid issueNumber", () => {
    for (const issueNumber of [0, -1, 1.5, "42", undefined]) {
      expect(buildSoftClaimRequest({ ...ACTIVE_CLAIM, issueNumber })).toBeNull();
    }
  });

  it("returns null for a missing/blank/non-string claimedAt", () => {
    for (const claimedAt of [undefined, "", "   ", 123]) {
      expect(buildSoftClaimRequest({ ...ACTIVE_CLAIM, claimedAt })).toBeNull();
    }
  });

  it("returns null for an unknown claim status", () => {
    for (const status of ["done", "", undefined, "ACTIVE"]) {
      expect(buildSoftClaimRequest({ ...ACTIVE_CLAIM, status })).toBeNull();
    }
  });
});
