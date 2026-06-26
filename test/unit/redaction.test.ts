import { describe, expect, it } from "vitest";
import { isPublicSafeText, PUBLIC_UNSAFE_PATTERN } from "../../src/signals/redaction";

describe("isPublicSafeText (#542 shared public/private boundary)", () => {
  it("accepts text with no private signals", () => {
    expect(isPublicSafeText("Add a retry to the cache reconnect path.")).toBe(true);
    expect(isPublicSafeText("- PR #12: changes requested.")).toBe(true);
    expect(isPublicSafeText("")).toBe(true);
  });

  it("rejects gittensor economic / identity signals", () => {
    for (const text of [
      "estimated reward is high",
      "your score will rise",
      "wallet 5F...",
      "hotkey leaked",
      "coldkey backup",
      "mnemonic phrase",
      "this looks like farming",
      "payout pending",
      "ranking change",
      "raw trust value",
      "raw-trust score",
      "trust_score 0.8",
      "private reviewability internals",
      "reviewability breakdown",
    ]) {
      expect(isPublicSafeText(text)).toBe(false);
    }
  });

  it("rejects plural signal nouns (the closing \\b must not slip the trailing 's' past a bare term)", () => {
    for (const text of ["your wallets here", "hotkeys", "coldkeys", "mnemonics", "payouts", "rankings", "rewards", "scores"]) {
      expect(isPublicSafeText(text)).toBe(false);
    }
  });

  it("rejects local filesystem paths (posix and Windows)", () => {
    expect(isPublicSafeText("/Users/alice/project")).toBe(false);
    expect(isPublicSafeText("/home/bob/repo")).toBe(false);
    expect(isPublicSafeText("/root/project/src")).toBe(false);
    expect(isPublicSafeText("clone failed at /root/work/repo")).toBe(false);
    expect(isPublicSafeText("/tmp/scratch")).toBe(false);
    expect(isPublicSafeText("C:\\Users\\carol\\repo")).toBe(false);
    expect(isPublicSafeText("C:/Users/carol/repo")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPublicSafeText("WALLET")).toBe(false);
    expect(isPublicSafeText("Payout")).toBe(false);
  });

  it("uses a NON-global pattern so .test() is stateless (no lastIndex carry-over)", () => {
    expect(PUBLIC_UNSAFE_PATTERN.global).toBe(false);
    // A global regex would alternate true/false across repeated .test() calls on the same input.
    expect(PUBLIC_UNSAFE_PATTERN.test("wallet")).toBe(true);
    expect(PUBLIC_UNSAFE_PATTERN.test("wallet")).toBe(true);
    expect(isPublicSafeText("clean line")).toBe(true);
    expect(isPublicSafeText("clean line")).toBe(true);
  });
});
