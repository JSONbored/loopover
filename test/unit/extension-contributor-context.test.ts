import { describe, expect, it } from "vitest";
import {
  buildExtensionIssueBadges,
  buildExtensionIssueFit,
  buildExtensionPrStatus,
  contributorReadinessBand,
  redactExtensionText,
} from "../../src/signals/extension-contributor-context";
import { isPublicSafeText } from "../../src/signals/redaction";
import type { ContributorOpportunity, PublicReadinessScore } from "../../src/signals/engine";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|farming|raw trust|trust score|scoreability|reviewability|cohort|ranking|miner-originated|human-originated/i;

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

  it("redacts a bare cohort reference (#5840)", () => {
    expect(redactExtensionText("Cohort diagnostics flagged this PR")).toBe("[redacted] diagnostics flagged this PR");
  });

  it("redacts a bare ranking reference (#5840)", () => {
    expect(redactExtensionText("Your ranking dropped this week")).toBe("Your [redacted] dropped this week");
  });

  it("redacts miner-originated and human-originated (#5840)", () => {
    expect(redactExtensionText("This looks miner-originated, not human-originated")).toBe(
      "This looks [redacted], not [redacted]",
    );
  });

  it("redacts a standalone reviewability reference, not just the compound phrases (#5840)", () => {
    expect(redactExtensionText("Reviewability is limited right now")).toBe("[redacted] is limited right now");
  });
});

describe("FORBIDDEN_EXTENSION_TERMS drift guard (#5840)", () => {
  it("redacts a representative sample of every canonical PUBLIC_UNSAFE_TERMS entry, so this module can't silently drift from the shared public/private boundary again", () => {
    const samples = [
      "Your reward is pending.",
      "Your score is pending.",
      "Check your wallet balance.",
      "Rotate your hotkey.",
      "Rotate your coldkey.",
      "Keep the mnemonic safe.",
      "The payout is scheduled.",
      "Your ranking dropped this week.",
      "Cohort diagnostics flagged this PR.",
      "This looks miner-originated, not human-originated.",
      "We detected farming behavior.",
      "This uses raw trust internally.",
      "The trust score moved.",
      "This is private reviewability data.",
      "Reviewability is limited right now.",
    ];

    for (const sample of samples) {
      // Sanity check: confirm the sample really is flagged unsafe by the canonical pattern.
      expect(isPublicSafeText(sample)).toBe(false);
      expect(isPublicSafeText(redactExtensionText(sample))).toBe(true);
    }
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

  it("bands a component at the readiness rubric's partial cutoff (ratio >= 0.45) as partial, not unmet", () => {
    // scoreResultIcon in the readiness table treats ratio >= 0.45 as ⚠️ (partial); the extension band must agree,
    // otherwise a component scored in [0.45, 0.5) is shown as fully unmet in the overlay while the table shows partial.
    const status = buildExtensionPrStatus({
      repoFullName: "octo/demo",
      pullNumber: 1,
      readiness: readiness(55, {
        components: [
          { key: "validation", label: "Validation", score: 9, max: 20, evidence: "Some tests.", action: "Add tests." }, // ratio 0.45 (boundary)
          { key: "change_scope", label: "Change scope", score: 49, max: 100, evidence: "Large diff.", action: "Split it." }, // ratio 0.49
        ],
      }),
    });
    expect(status.components.map((component) => component.band)).toEqual(["partial", "partial"]);
  });
});
