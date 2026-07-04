import { describe, expect, it } from "vitest";
import { evaluateDenyHooks } from "../../packages/gittensory-miner/lib/deny-hooks.js";
import { denyHookFixtures } from "../fixtures/deny-hooks/cases.js";

// Data-driven deny-hook corpus (#2296): every fixture in test/fixtures/deny-hooks/cases.ts is evaluated against
// evaluateDenyHooks and must match its expected verdict exactly, so the rule matcher is proven to generalize across
// realistic tool-call shapes before any real coding-agent driver is plugged in.

describe("deny-hook fixture corpus (#2296)", () => {
  it("has a non-trivial number of fixtures spanning every default rule", () => {
    expect(denyHookFixtures.length).toBeGreaterThanOrEqual(15);
  });

  it.each(denyHookFixtures)("$name", (fixture) => {
    const verdict = fixture.rules
      ? evaluateDenyHooks(fixture.toolCall, fixture.rules)
      : evaluateDenyHooks(fixture.toolCall);
    expect(verdict.allowed).toBe(fixture.expected.allowed);
    if (fixture.expected.allowed) {
      expect(verdict.blockedBy).toBeUndefined();
    } else if (fixture.expected.blockedByIncludes !== undefined) {
      expect(verdict.blockedBy?.reason).toContain(fixture.expected.blockedByIncludes);
    }
  });
});
