import { describe, expect, it } from "vitest";

// Import the .ts SOURCE via a non-literal specifier so CI's `--coverage.all=false` run grades discover-cli.ts,
// not a stale post-build .js artifact (#8544, same pattern as miner-replay-snapshot.test.ts / #8510).
const DISCOVER_CLI_MODULE = "../../packages/loopover-miner/lib/discover-cli.ts";
const {
  ELIGIBILITY_EXCLUSION_METADATA_MAX_ASSIGNEES,
  ELIGIBILITY_EXCLUSION_METADATA_MAX_LABELS,
  ELIGIBILITY_EXCLUSION_METADATA_MAX_STRING_CHARS,
  buildEligibilityExclusionMetadata,
} = (await import(DISCOVER_CLI_MODULE)) as typeof import("../../packages/loopover-miner/lib/discover-cli.js");

function labelList(count: number, prefix = "label"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

describe("buildEligibilityExclusionMetadata (#8544)", () => {
  it("records labels, assignees, and owner when all three are present", () => {
    expect(
      buildEligibilityExclusionMetadata({
        owner: "acme",
        labels: ["help wanted", "bug"],
        assignees: ["alice", "bob"],
      }),
    ).toEqual({
      owner: "acme",
      labels: ["help wanted", "bug"],
      assignees: ["alice", "bob"],
    });
  });

  it("omits each field when absent from the candidate", () => {
    expect(buildEligibilityExclusionMetadata({})).toBeUndefined();
    expect(buildEligibilityExclusionMetadata({ labels: [] })).toBeUndefined();
    expect(buildEligibilityExclusionMetadata({ assignees: [] })).toBeUndefined();
    expect(buildEligibilityExclusionMetadata({ owner: "" })).toBeUndefined();
    expect(buildEligibilityExclusionMetadata({ labels: ["bug"] })).toEqual({ labels: ["bug"] });
    expect(buildEligibilityExclusionMetadata({ assignees: ["alice"] })).toEqual({ assignees: ["alice"] });
    expect(buildEligibilityExclusionMetadata({ owner: "acme" })).toEqual({ owner: "acme" });
    expect(buildEligibilityExclusionMetadata({ labels: [null as unknown as string, "bug"] })).toEqual({
      labels: ["bug"],
    });
  });

  it("keeps exactly-max label and assignee counts without a truncated key", () => {
    expect(
      buildEligibilityExclusionMetadata({
        labels: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_LABELS),
        assignees: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_ASSIGNEES, "user"),
      }),
    ).toEqual({
      labels: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_LABELS),
      assignees: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_ASSIGNEES, "user"),
    });
  });

  it("clamps one-over-max label and assignee counts and sets truncated", () => {
    const metadata = buildEligibilityExclusionMetadata({
      labels: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_LABELS + 1),
      assignees: labelList(ELIGIBILITY_EXCLUSION_METADATA_MAX_ASSIGNEES + 1, "user"),
    });
    expect(metadata?.labels).toHaveLength(ELIGIBILITY_EXCLUSION_METADATA_MAX_LABELS);
    expect(metadata?.assignees).toHaveLength(ELIGIBILITY_EXCLUSION_METADATA_MAX_ASSIGNEES);
    expect(metadata?.truncated).toBe(true);
  });

  it("keeps exactly-max-length strings without truncated", () => {
    const exact = "x".repeat(ELIGIBILITY_EXCLUSION_METADATA_MAX_STRING_CHARS);
    expect(
      buildEligibilityExclusionMetadata({
        owner: exact,
        labels: [exact],
        assignees: [exact],
      }),
    ).toEqual({
      owner: exact,
      labels: [exact],
      assignees: [exact],
    });
  });

  it("truncates one-over-max-length owner, label, and assignee strings and sets truncated", () => {
    const over = "y".repeat(ELIGIBILITY_EXCLUSION_METADATA_MAX_STRING_CHARS + 1);
    const expected = "y".repeat(ELIGIBILITY_EXCLUSION_METADATA_MAX_STRING_CHARS);
    expect(buildEligibilityExclusionMetadata({ owner: over })).toEqual({
      owner: expected,
      truncated: true,
    });
    expect(buildEligibilityExclusionMetadata({ labels: [over] })).toEqual({
      labels: [expected],
      truncated: true,
    });
    expect(buildEligibilityExclusionMetadata({ assignees: [over] })).toEqual({
      assignees: [expected],
      truncated: true,
    });
  });
});
