import { describe, expect, it } from "vitest";
import { buildContributorPrStatus, contributorReadinessBand, redactContributorText } from "../../src/signals/contributor-readiness-band";
import type { PublicReadinessScore } from "../../src/signals/engine";
import { PUBLIC_UNSAFE_TERMS } from "../../src/signals/redaction";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|farming|raw trust|trust score|scoreability|cohort|ranking|miner-originated|human-originated|reviewability/i;

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

describe("redactContributorText", () => {
  it("redacts forbidden private terms and collapses whitespace", () => {
    expect(redactContributorText("Your reward and trust score are high")).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
    expect(redactContributorText("hotkey wallet payout")).toBe("[redacted] [redacted] [redacted]");
    expect(redactContributorText("  clean   text  ")).toBe("clean text");
  });

  it("leaves safe text untouched", () => {
    expect(redactContributorText("Maintainer-created issue, good fit.")).toBe("Maintainer-created issue, good fit.");
  });

  // #5840: FORBIDDEN_PRIVATE_TERMS had drifted from redaction.ts's canonical PUBLIC_UNSAFE_TERMS and let
  // these economic-identity terms through unredacted.
  it("redacts bare cohort, previously leaked", () => {
    expect(redactContributorText("Cohort diagnostics flagged this PR")).toBe("[redacted] diagnostics flagged this PR");
  });

  it("redacts bare ranking, previously leaked", () => {
    expect(redactContributorText("Your ranking dropped this week")).toBe("Your [redacted] dropped this week");
  });

  it("redacts miner-originated / human-originated, previously leaked", () => {
    expect(redactContributorText("This looks miner-originated, not human-originated")).toBe("This looks [redacted], not [redacted]");
    // the [-_\s]? separator matches underscore and space forms too, matching PUBLIC_UNSAFE_TERMS.
    expect(redactContributorText("miner_originated and human originated")).toBe("[redacted] and [redacted]");
  });

  it("redacts standalone reviewability while still redacting the compound forms as a whole", () => {
    expect(redactContributorText("Reviewability is limited right now")).toBe("[redacted] is limited right now");
    expect(redactContributorText("reviewability internals exposed")).toBe("[redacted] exposed");
    expect(redactContributorText("private reviewability data")).toBe("[redacted] data");
  });

  it("stays in sync with the canonical PUBLIC_UNSAFE_TERMS vocabulary (drift guard)", () => {
    // Every economic-identity term the canonical boundary blocks must also be scrubbed by this overlay, so the
    // two vocabularies can't silently diverge again. Bare `score` is the one intentional exception: this
    // surface returns readiness as public BANDS, and redaction.ts's own note records sibling surfaces that
    // deliberately do not redact a bare `score`.
    const canonical = new RegExp(PUBLIC_UNSAFE_TERMS, "i");
    const intentionalExceptions = new Set(["public score"]);
    const samples = [
      "reward",
      "wallet",
      "hotkey",
      "coldkey",
      "mnemonic",
      "payout",
      "farming",
      "raw trust",
      "trust score",
      "ranking",
      "cohort",
      "miner-originated",
      "human-originated",
      "private reviewability",
      "reviewability",
      "public score", // intentional exception -- canonical matches it, this overlay deliberately does not
    ];
    for (const sample of samples) {
      expect(canonical.test(sample)).toBe(true); // sanity: the canonical vocabulary really does flag it
      const redacted = redactContributorText(sample);
      if (intentionalExceptions.has(sample)) {
        expect(redacted).toBe(sample); // band-gated: intentionally left as-is
      } else {
        expect(redacted).toBe("[redacted]");
      }
    }
  });
});

describe("buildContributorPrStatus", () => {
  it("returns an overall band + per-component bands, never raw scores", () => {
    const status = buildContributorPrStatus({ repoFullName: "octo/demo", pullNumber: 12, readiness: readiness(72) });
    expect(status.readinessBand).toBe("strong");
    expect(status.reviewStatus).toBe("ready_for_review");
    expect(JSON.stringify(status)).not.toMatch(/"score"|"total"|"max"/);
    expect(status.components.map((component) => component.band)).toEqual(["met", "partial", "unmet"]);
    expect(JSON.stringify(status)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("maps developing/early bands to the matching review status", () => {
    expect(buildContributorPrStatus({ repoFullName: "octo/demo", pullNumber: 1, readiness: readiness(50) }).reviewStatus).toBe("in_progress");
    expect(buildContributorPrStatus({ repoFullName: "octo/demo", pullNumber: 1, readiness: readiness(20) }).reviewStatus).toBe("needs_attention");
  });

  it("treats a zero-max component as unmet without dividing by zero", () => {
    const status = buildContributorPrStatus({
      repoFullName: "octo/demo",
      pullNumber: 1,
      readiness: readiness(80, { components: [{ key: "queue_pressure", label: "Queue pressure", score: 0, max: 0, evidence: "n/a", action: "n/a" }] }),
    });
    expect(status.components[0]!.band).toBe("unmet");
  });

  it("bands a component at the readiness rubric's partial cutoff (ratio >= 0.45) as partial, not unmet", () => {
    // scoreResultIcon in the readiness table treats ratio >= 0.45 as ⚠️ (partial); this band must agree,
    // otherwise a component scored in [0.45, 0.5) is shown as fully unmet in the overlay while the table shows partial.
    const status = buildContributorPrStatus({
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
