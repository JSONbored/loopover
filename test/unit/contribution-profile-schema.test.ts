import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONTRIBUTION_PROFILE_CACHE_TTL_MS,
  CONTRIBUTION_PROFILE_SCHEMA_VERSION,
  CONTRIBUTION_PROFILE_STORE_TABLE,
  CONTRIBUTION_SIGNAL_CONFIDENCE_LEVELS,
  CONTRIBUTION_SIGNAL_SOURCES,
  emptyContributionProfile,
  weakestConfidence,
} from "../../packages/loopover-miner/lib/contribution-profile.js";

const docPath = join(
  process.cwd(),
  "packages/loopover-miner/docs/contribution-profile.md",
);

describe("ContributionProfile schema constants (#6795)", () => {
  it("pins the schema version, TTL, table name, and vocabularies", () => {
    expect(CONTRIBUTION_PROFILE_SCHEMA_VERSION).toBe(1);
    expect(CONTRIBUTION_PROFILE_CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(CONTRIBUTION_PROFILE_STORE_TABLE).toBe("miner_contribution_profile");
    expect(CONTRIBUTION_SIGNAL_CONFIDENCE_LEVELS).toEqual([
      "explicit",
      "inferred",
      "absent",
      "unknown",
    ]);
    expect(CONTRIBUTION_SIGNAL_SOURCES).toEqual([
      "labels",
      "contributing_md",
      "pr_template",
      "agent_docs",
    ]);
  });

  it("freezes the vocabulary tuples so a consumer cannot mutate the shared constants", () => {
    expect(Object.isFrozen(CONTRIBUTION_SIGNAL_CONFIDENCE_LEVELS)).toBe(true);
    expect(Object.isFrozen(CONTRIBUTION_SIGNAL_SOURCES)).toBe(true);
  });
});

describe("emptyContributionProfile (#6795)", () => {
  it("builds a fully-absent profile so an unprofiled repo is treated conservatively, not as unrestricted", () => {
    const profile = emptyContributionProfile(
      "acme/widgets",
      "2026-07-18T00:00:00.000Z",
    );
    expect(profile).toEqual({
      repoFullName: "acme/widgets",
      schemaVersion: 1,
      generatedAt: "2026-07-18T00:00:00.000Z",
      eligibilityLabels: { value: null, confidence: "absent", provenance: [] },
      exclusionLabels: { value: null, confidence: "absent", provenance: [] },
      prBody: { value: null, confidence: "absent", provenance: [] },
      completeness: "absent",
    });
  });

  it("returns independent rule objects (no shared reference between the three absent rules)", () => {
    // The default rules must not alias one instance, or the extractor mutating one would corrupt the others.
    const profile = emptyContributionProfile(
      "acme/widgets",
      "2026-07-18T00:00:00.000Z",
    );
    expect(profile.eligibilityLabels).not.toBe(profile.exclusionLabels);
    expect(profile.eligibilityLabels.provenance).not.toBe(
      profile.exclusionLabels.provenance,
    );
  });
});

describe("weakestConfidence (#6795)", () => {
  it("returns the least-confident value so one strong signal never masks an absent one", () => {
    expect(weakestConfidence(["explicit", "explicit"])).toBe("explicit");
    expect(weakestConfidence(["explicit", "inferred"])).toBe("inferred");
    expect(weakestConfidence(["explicit", "absent"])).toBe("absent");
    expect(weakestConfidence(["absent", "unknown"])).toBe("unknown");
  });

  it("treats an empty set as unknown (nothing observed)", () => {
    expect(weakestConfidence([])).toBe("unknown");
  });

  it("ignores an unrecognized confidence rather than ranking it", () => {
    // Defensive: a bad value from a future/older extractor must not silently become the weakest.
    expect(weakestConfidence(["explicit", "bogus" as never])).toBe("explicit");
  });
});

describe("ContributionProfile design doc (#6795)", () => {
  it("documents every profile field and the findings that shaped them", () => {
    const doc = readFileSync(docPath, "utf8");
    for (const field of [
      "eligibilityLabels",
      "exclusionLabels",
      "prBody",
      "completeness",
      "schemaVersion",
    ]) {
      expect(doc).toContain(field);
    }
    // The three load-bearing #6794 findings must be cited, so the schema stays traceable to evidence.
    expect(doc).toContain("name AND description");
    expect(doc).toContain("loopover-local");
    expect(doc).toContain("weakest");
    expect(doc).toContain("miner_contribution_profile");
  });
});
