import { describe, expect, it } from "vitest";

import { effectiveLinkedIssueGateMode, withLinkedIssueMaintainerExemption, type LinkedIssueExemptionAuthor } from "../../src/settings/linked-issue-exemption";
import type { GateRuleMode, RepositorySettings } from "../../src/types";

// #10158: `gate.linkedIssue: block` exists to stop unlinked CONTRIBUTOR work. Applied to a maintainer's own
// PR it asks them to file an issue against their own repo first and then holds the PR when they don't --
// `hold | missing_linked_issue` was the second-largest hold bucket on the production Orb.
//
// The exemption is ONE clamp: block -> advisory for maintainer-authored PRs. Everything below is about the
// ways a plausible implementation would over- or under-reach.

const CONTRIBUTOR: LinkedIssueExemptionAuthor = { authorIsOwner: false, authorIsAdmin: false, authorIsAutomationBot: false };
const OWNER: LinkedIssueExemptionAuthor = { authorIsOwner: true, authorIsAdmin: false, authorIsAutomationBot: false };
const ADMIN: LinkedIssueExemptionAuthor = { authorIsOwner: false, authorIsAdmin: true, authorIsAutomationBot: false };
const BOT: LinkedIssueExemptionAuthor = { authorIsOwner: false, authorIsAdmin: false, authorIsAutomationBot: true };

describe("effectiveLinkedIssueGateMode (#10158)", () => {
  it("clamps block to advisory for a maintainer when the exemption is on", () => {
    expect(effectiveLinkedIssueGateMode("block", true, OWNER)).toBe("advisory");
  });

  it("covers every protected author: owner, per-repo admin, and automation bots", () => {
    // Bots are included deliberately -- release-please, dependency bumps and generated-doc refreshes open
    // unlinked PRs constantly, and they are already exempt from auto-close for the same reason.
    for (const author of [OWNER, ADMIN, BOT]) {
      expect(effectiveLinkedIssueGateMode("block", true, author)).toBe("advisory");
    }
  });

  it("INVARIANT: a CONTRIBUTOR is never exempted, which is the entire point of keeping the gate", () => {
    expect(effectiveLinkedIssueGateMode("block", true, CONTRIBUTOR)).toBe("block");
  });

  it("INVARIANT: does nothing at all when the knob is not explicitly true", () => {
    // Absent/false/null must be byte-identical to before this existed. `!== true` rather than a falsy check
    // so a stray string from a hand-edited yml cannot switch it on.
    for (const off of [undefined, null, false] as const) {
      expect(effectiveLinkedIssueGateMode("block", off, OWNER), String(off)).toBe("block");
    }
  });

  it("REGRESSION: never RAISES a mode — `off` stays off, it is not promoted to advisory", () => {
    // The clamp is one-directional. Rewriting `off` to `advisory` would start producing a
    // `missing_linked_issue` finding on a repo that had deliberately switched the gate off entirely, which is
    // the opposite of an exemption.
    expect(effectiveLinkedIssueGateMode("off", true, OWNER)).toBe("off");
    expect(effectiveLinkedIssueGateMode("advisory", true, OWNER)).toBe("advisory");
  });

  it("is exhaustive over the mode vocabulary — only `block` is ever rewritten", () => {
    for (const mode of ["off", "advisory", "block"] as const satisfies readonly GateRuleMode[]) {
      const out = effectiveLinkedIssueGateMode(mode, true, OWNER);
      expect(out, mode).toBe(mode === "block" ? "advisory" : mode);
    }
  });
});

describe("withLinkedIssueMaintainerExemption", () => {
  const base = { linkedIssueGateMode: "block", linkedIssueMaintainerExempt: true } as RepositorySettings;

  it("returns settings whose linkedIssueGateMode is the clamped mode", () => {
    expect(withLinkedIssueMaintainerExemption(base, OWNER).linkedIssueGateMode).toBe("advisory");
  });

  it("REGRESSION: returns the SAME object reference when nothing changes", () => {
    // `configDigest` (decision-record.ts) digests the resolved policy. A gratuitous copy is harmless, but
    // identity here documents that the overwhelmingly common path -- contributor PRs, and every repo that
    // never sets the knob -- is untouched rather than merely equal.
    expect(withLinkedIssueMaintainerExemption(base, CONTRIBUTOR)).toBe(base);
    const off = { linkedIssueGateMode: "block" } as RepositorySettings;
    expect(withLinkedIssueMaintainerExemption(off, OWNER)).toBe(off);
  });

  it("changes NOTHING else on the settings object", () => {
    // The exemption is scoped to one mode. Anything that analyses an issue that IS linked --
    // linkedIssueSatisfactionGateMode, the hard rules, label propagation -- must survive untouched, since
    // those are exactly the "keep all current analysis" half of the requirement.
    const rich = {
      linkedIssueGateMode: "block",
      linkedIssueMaintainerExempt: true,
      linkedIssueSatisfactionGateMode: "block",
      duplicatePrGateMode: "block",
      requireLinkedIssue: true,
    } as unknown as RepositorySettings;
    const out = withLinkedIssueMaintainerExemption(rich, OWNER);
    expect(out.linkedIssueGateMode).toBe("advisory");
    expect(out.linkedIssueSatisfactionGateMode).toBe("block");
    expect(out.duplicatePrGateMode).toBe("block");
    expect(out.requireLinkedIssue).toBe(true);
    // requireLinkedIssue staying true is load-bearing, not incidental: it is what keeps the
    // `missing_linked_issue` FINDING being produced, so the maintainer still sees "No linked issue
    // detected" -- only its power to block is removed.
  });
});
