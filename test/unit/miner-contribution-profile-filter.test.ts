import { describe, expect, it } from "vitest";

import type { ContributionProfile } from "../../packages/loopover-miner/lib/contribution-profile";
import {
  ELIGIBILITY_EXCLUSION_REASONS,
  filterCandidatesByProfiles,
} from "../../packages/loopover-miner/lib/contribution-profile-filter";

type Candidate = {
  repoFullName: string;
  issueNumber: number;
  owner?: string;
  labels?: string[];
  assignees?: string[];
};

const candidate = (issueNumber: number, labels: string[]): Candidate => ({
  repoFullName: "acme/widgets",
  issueNumber,
  owner: "acme",
  labels,
});

/** A trustworthy (explicit-eligibility) profile whose eligibility label is `good first issue` and whose
 *  exclusion label is `blocked` — provenance details carry the real repo label names the filter matches on. */
function trustworthyProfile(
  over: Partial<ContributionProfile> = {},
): ContributionProfile {
  return {
    repoFullName: "acme/widgets",
    schemaVersion: 1,
    generatedAt: "2026-07-18T00:00:00.000Z",
    eligibilityLabels: {
      value: [{ field: "name", contains: "good first issue" }],
      confidence: "explicit",
      provenance: [{ source: "labels", detail: "good first issue" }],
    },
    exclusionLabels: {
      value: [{ field: "name", contains: "blocked" }],
      confidence: "inferred",
      provenance: [{ source: "labels", detail: "blocked" }],
    },
    prBody: { value: null, confidence: "absent", provenance: [] },
    completeness: "inferred",
    ...over,
  };
}

const profilesFor = (profile: ContributionProfile) =>
  new Map([["acme/widgets", profile]]);

describe("filterCandidatesByProfiles (#6798)", () => {
  it("keeps candidates carrying an eligibility label", () => {
    const { kept, excluded } = filterCandidatesByProfiles(
      [candidate(1, ["good first issue"])],
      profilesFor(trustworthyProfile()),
    );
    expect(kept.map((c) => c.issueNumber)).toEqual([1]);
    expect(excluded).toEqual([]);
  });

  it("excludes a candidate that carries an exclusion label", () => {
    const { kept, excluded } = filterCandidatesByProfiles(
      [candidate(1, ["good first issue", "blocked"])],
      profilesFor(trustworthyProfile()),
    );
    // Conflicting signals (both eligibility + exclusion) — exclusion wins, conservatively.
    expect(kept).toEqual([]);
    expect(excluded).toEqual([
      {
        candidate: candidate(1, ["good first issue", "blocked"]),
        reason: ELIGIBILITY_EXCLUSION_REASONS.CONFLICTING_SIGNALS,
      },
    ]);
  });

  it("excludes an exclusion-only candidate as exclusion_label", () => {
    const { excluded } = filterCandidatesByProfiles(
      [candidate(2, ["blocked"])],
      profilesFor(trustworthyProfile()),
    );
    expect(excluded).toEqual([
      {
        candidate: candidate(2, ["blocked"]),
        reason: ELIGIBILITY_EXCLUSION_REASONS.EXCLUSION_LABEL,
      },
    ]);
  });

  it("excludes a candidate with neither an eligibility nor exclusion label as missing_eligibility_label", () => {
    const { kept, excluded } = filterCandidatesByProfiles(
      [candidate(3, ["bug"])],
      profilesFor(trustworthyProfile()),
    );
    expect(kept).toEqual([]);
    expect(excluded).toEqual([
      {
        candidate: candidate(3, ["bug"]),
        reason: ELIGIBILITY_EXCLUSION_REASONS.MISSING_ELIGIBILITY_LABEL,
      },
    ]);
  });

  it("matches labels case-insensitively", () => {
    const { kept } = filterCandidatesByProfiles(
      [candidate(1, ["GOOD First Issue"])],
      profilesFor(trustworthyProfile()),
    );
    expect(kept.map((c) => c.issueNumber)).toEqual([1]);
  });

  it("SAFE DEFAULT: keeps everything when the profile's eligibility confidence is not explicit", () => {
    // A low-confidence/absent eligibility signal must never cause a candidate to be skipped.
    const absent = trustworthyProfile({
      eligibilityLabels: { value: null, confidence: "absent", provenance: [] },
    });
    const { kept, excluded } = filterCandidatesByProfiles(
      [candidate(1, ["bug"]), candidate(2, ["blocked"])],
      profilesFor(absent),
    );
    expect(kept.map((c) => c.issueNumber)).toEqual([1, 2]);
    expect(excluded).toEqual([]);
  });

  it("SAFE DEFAULT: keeps a candidate whose repo has no profile in the map", () => {
    const { kept, excluded } = filterCandidatesByProfiles(
      [{ repoFullName: "other/repo", issueNumber: 9, labels: ["bug"] }],
      profilesFor(trustworthyProfile()),
    );
    expect(kept).toHaveLength(1);
    expect(excluded).toEqual([]);
  });

  it("handles a candidate with no labels field (treated as no labels ⇒ missing eligibility)", () => {
    const { excluded } = filterCandidatesByProfiles(
      [{ repoFullName: "acme/widgets", issueNumber: 4 }],
      profilesFor(trustworthyProfile()),
    );
    expect(excluded[0]?.reason).toBe(
      ELIGIBILITY_EXCLUSION_REASONS.MISSING_ELIGIBILITY_LABEL,
    );
  });

  it("keeps eligible when the profile has no exclusion labels at all", () => {
    const noExclusion = trustworthyProfile({
      exclusionLabels: { value: null, confidence: "absent", provenance: [] },
    });
    const { kept, excluded } = filterCandidatesByProfiles(
      [candidate(1, ["good first issue"]), candidate(2, ["bug"])],
      profilesFor(noExclusion),
    );
    expect(kept.map((c) => c.issueNumber)).toEqual([1]);
    expect(excluded.map((e) => e.reason)).toEqual([
      ELIGIBILITY_EXCLUSION_REASONS.MISSING_ELIGIBILITY_LABEL,
    ]);
  });

  it("ignores a non-string label entry without matching or throwing", () => {
    const { excluded } = filterCandidatesByProfiles(
      [
        {
          repoFullName: "acme/widgets",
          issueNumber: 5,
          labels: [42 as unknown as string],
        },
      ],
      profilesFor(trustworthyProfile()),
    );
    expect(excluded[0]?.reason).toBe(
      ELIGIBILITY_EXCLUSION_REASONS.MISSING_ELIGIBILITY_LABEL,
    );
  });

  it("tolerates malformed provenance (missing field / non-string detail) without throwing", () => {
    // Defensive: an explicit rule with no provenance yields no label names, and a non-string detail entry is
    // skipped — a corrupted/older-extractor profile degrades to "no match", never a crash.
    const malformed = trustworthyProfile({
      eligibilityLabels: {
        value: [{ field: "name", contains: "x" }],
        confidence: "explicit",
      } as never,
      exclusionLabels: {
        value: null,
        confidence: "inferred",
        provenance: [{ source: "labels", detail: 42 }],
      } as never,
    });
    const { excluded } = filterCandidatesByProfiles(
      [candidate(1, ["good first issue"])],
      profilesFor(malformed),
    );
    // eligibilityNames is empty (no provenance) ⇒ nothing matches ⇒ missing_eligibility_label.
    expect(excluded[0]?.reason).toBe(
      ELIGIBILITY_EXCLUSION_REASONS.MISSING_ELIGIBILITY_LABEL,
    );
  });

  it("tolerates a null profilesByRepo map (keeps everything)", () => {
    const { kept } = filterCandidatesByProfiles(
      [candidate(1, ["bug"])],
      null as never,
    );
    expect(kept).toHaveLength(1);
  });

  describe("assignee-exclusion (#7040)", () => {
    it("excludes a candidate assigned to the repo's own owner login", () => {
      const assigned: Candidate = { ...candidate(1, ["good first issue"]), assignees: ["acme"] };
      const { kept, excluded } = filterCandidatesByProfiles([assigned], profilesFor(trustworthyProfile()));
      expect(kept).toEqual([]);
      expect(excluded).toEqual([{ candidate: assigned, reason: ELIGIBILITY_EXCLUSION_REASONS.EXCLUDED_ASSIGNEE }]);
    });

    it("matches the owner login case-insensitively", () => {
      const assigned: Candidate = { ...candidate(1, ["good first issue"]), assignees: ["ACME"] };
      const { excluded } = filterCandidatesByProfiles([assigned], profilesFor(trustworthyProfile()));
      expect(excluded[0]?.reason).toBe(ELIGIBILITY_EXCLUSION_REASONS.EXCLUDED_ASSIGNEE);
    });

    it("does not exclude a candidate assigned to someone other than the repo owner", () => {
      const assigned: Candidate = { ...candidate(1, ["good first issue"]), assignees: ["someone-else"] };
      const { kept, excluded } = filterCandidatesByProfiles([assigned], profilesFor(trustworthyProfile()));
      expect(kept).toHaveLength(1);
      expect(excluded).toEqual([]);
    });

    it("applies unconditionally: excludes an owner-assigned candidate even when the repo has NO profile at all", () => {
      const assigned: Candidate = { ...candidate(1, ["bug"]), repoFullName: "other/repo", assignees: ["other"] };
      const withOwner: Candidate = { ...assigned, owner: "other" };
      const { kept, excluded } = filterCandidatesByProfiles([withOwner], profilesFor(trustworthyProfile()));
      expect(kept).toEqual([]);
      expect(excluded).toEqual([{ candidate: withOwner, reason: ELIGIBILITY_EXCLUSION_REASONS.EXCLUDED_ASSIGNEE }]);
    });

    it("applies unconditionally: excludes an owner-assigned candidate even when the profile's eligibility confidence is not explicit", () => {
      const lowConfidence = trustworthyProfile({
        eligibilityLabels: { value: null, confidence: "absent", provenance: [] },
      });
      const assigned: Candidate = { ...candidate(1, ["bug"]), assignees: ["acme"] };
      const { kept, excluded } = filterCandidatesByProfiles([assigned], profilesFor(lowConfidence));
      expect(kept).toEqual([]);
      expect(excluded).toEqual([{ candidate: assigned, reason: ELIGIBILITY_EXCLUSION_REASONS.EXCLUDED_ASSIGNEE }]);
    });

    it("tolerates a candidate with no owner or assignees fields (never excluded, never throws)", () => {
      const { kept, excluded } = filterCandidatesByProfiles(
        [{ repoFullName: "acme/widgets", issueNumber: 6, labels: ["good first issue"] }],
        profilesFor(trustworthyProfile()),
      );
      expect(kept).toHaveLength(1);
      expect(excluded).toEqual([]);
    });

    it("ignores a non-string assignee entry without matching or throwing", () => {
      const assigned: Candidate = {
        ...candidate(1, ["good first issue"]),
        assignees: [42 as unknown as string],
      };
      const { kept, excluded } = filterCandidatesByProfiles([assigned], profilesFor(trustworthyProfile()));
      expect(kept).toHaveLength(1);
      expect(excluded).toEqual([]);
    });
  });
});
