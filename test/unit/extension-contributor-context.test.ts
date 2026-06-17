import { describe, expect, it } from "vitest";
import {
  buildExtensionIssueBadges,
  buildExtensionIssueFit,
  buildExtensionPrStatus,
  contributorReadinessBand,
  redactExtensionText,
} from "../../src/signals/extension-contributor-context";
import type { ContributorOpportunity, PublicReadinessScore } from "../../src/signals/engine";

const FORBIDDEN_PUBLIC_TERMS = /wallet|hotkey|coldkey|mnemonic|reward|payout|farming|raw trust|trust score|scoreability|reviewability internals|private ranking/i;

function opportunity(over: Partial<ContributorOpportunity> = {}): ContributorOpportunity {
  return {
    repoFullName: "octo/demo",
    issueNumber: 7,
    title: "Add cursor pagination to the labels endpoint",
    fit: "good",
    score: 82,
    lane: "direct_pr",
    multiplierTier: "maintainer_created",
    availability: "ready",
    reasons: ["Maintainer-created issue with the biggest multiplier.", "You have touched this repo before."],
    warnings: [],
    ...over,
  };
}

function readiness(total: number, over: Partial<PublicReadinessScore> = {}): PublicReadinessScore {
  return {
    total,
    components: [
      { key: "traceability", label: "Traceability", score: 15, max: 15, evidence: "Linked issue #7.", action: "No action." },
      { key: "validation", label: "Validation", score: 14, max: 25, evidence: "Some tests described.", action: "Add focused tests." },
      { key: "pr_state", label: "PR state", score: 3, max: 10, evidence: "PR is closed.", action: "Reopen if still relevant." },
    ],
    ...over,
  };
}

describe("contributorReadinessBand", () => {
  it("maps the raw score to a public band, never exposing the number", () => {
    expect(contributorReadinessBand(100)).toBe("strong");
    expect(contributorReadinessBand(70)).toBe("strong");
    expect(contributorReadinessBand(69)).toBe("developing");
    expect(contributorReadinessBand(45)).toBe("developing");
    expect(contributorReadinessBand(44)).toBe("early");
    expect(contributorReadinessBand(0)).toBe("early");
  });
});

describe("redactExtensionText", () => {
  it("redacts forbidden private terms and collapses whitespace", () => {
    expect(redactExtensionText("Your reward and trust score are high")).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(redactExtensionText("hotkey wallet payout")).toBe("[redacted] [redacted] [redacted]");
    expect(redactExtensionText("  clean   text  ")).toBe("clean text");
  });

  it("leaves safe text untouched", () => {
    expect(redactExtensionText("Maintainer-created issue, good fit.")).toBe("Maintainer-created issue, good fit.");
  });
});

describe("buildExtensionIssueFit", () => {
  it("returns the fit band (not a raw score) plus public-safe reasons", () => {
    const fit = buildExtensionIssueFit(opportunity());
    expect(fit).toMatchObject({ repoFullName: "octo/demo", issueNumber: 7, fit: "good", multiplierTier: "maintainer_created", availability: "ready" });
    expect(fit).not.toHaveProperty("score");
    expect(JSON.stringify(fit)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("redacts a forbidden term that slips into a reason or title", () => {
    const fit = buildExtensionIssueFit(opportunity({ title: "reward farming issue", reasons: ["You can payout here"] }));
    expect(JSON.stringify(fit)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("defaults a missing issue number to 0", () => {
    expect(buildExtensionIssueFit(opportunity({ issueNumber: undefined })).issueNumber).toBe(0);
  });
});

describe("buildExtensionIssueBadges", () => {
  it("returns per-issue badges scoped to the repo, with bands not scores", () => {
    const badges = buildExtensionIssueBadges(
      [opportunity({ issueNumber: 7 }), opportunity({ issueNumber: 8, fit: "caution" }), opportunity({ repoFullName: "other/repo", issueNumber: 9 })],
      "octo/demo",
    );
    expect(badges.map((badge) => badge.issueNumber)).toEqual([7, 8]);
    expect(badges.every((badge) => !("score" in badge))).toBe(true);
    expect(badges[1]!.fit).toBe("caution");
    expect(JSON.stringify(badges)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("matches the repo case-insensitively and drops opportunities without an issue number", () => {
    const badges = buildExtensionIssueBadges([opportunity({ issueNumber: undefined }), opportunity({ issueNumber: 7 })], "OCTO/Demo");
    expect(badges.map((badge) => badge.issueNumber)).toEqual([7]);
  });
});

describe("buildExtensionPrStatus", () => {
  it("returns an overall band + per-component bands, never raw scores", () => {
    const status = buildExtensionPrStatus({ repoFullName: "octo/demo", pullNumber: 12, readiness: readiness(72) });
    expect(status.readinessBand).toBe("strong");
    expect(status.reviewStatus).toBe("ready_for_review");
    expect(JSON.stringify(status)).not.toMatch(/"score"|"total"|"max"/);
    expect(status.components.map((component) => component.band)).toEqual(["met", "partial", "unmet"]);
    expect(JSON.stringify(status)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("maps developing/early bands to the matching review status", () => {
    expect(buildExtensionPrStatus({ repoFullName: "octo/demo", pullNumber: 1, readiness: readiness(50) }).reviewStatus).toBe("in_progress");
    expect(buildExtensionPrStatus({ repoFullName: "octo/demo", pullNumber: 1, readiness: readiness(20) }).reviewStatus).toBe("needs_attention");
  });

  it("treats a zero-max component as unmet without dividing by zero", () => {
    const status = buildExtensionPrStatus({
      repoFullName: "octo/demo",
      pullNumber: 1,
      readiness: readiness(80, { components: [{ key: "queue_pressure", label: "Queue pressure", score: 0, max: 0, evidence: "n/a", action: "n/a" }] }),
    });
    expect(status.components[0]!.band).toBe("unmet");
  });
});
