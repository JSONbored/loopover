import { describe, expect, it } from "vitest";
import { buildCohortRecapSection, type CohortRecapSource } from "../../src/services/maintainer-recap-cohort";

describe("buildCohortRecapSection (#4521)", () => {
  it("returns null when no cohort data is present", () => {
    expect(buildCohortRecapSection({ windowDays: 7 })).toBeNull();
    expect(buildCohortRecapSection({ windowDays: 7, cohorts: {} })).toBeNull();
  });

  it("renders aggregate miner and human lines without actor logins", () => {
    const section = buildCohortRecapSection({
      windowDays: 7,
      cohorts: {
        miner: { reviewed: 4, merged: 3, closed: 1, blocked: 5, gateFalsePositives: 1, gateFalsePositiveRate: 0.2 },
        human: { reviewed: 6, merged: 4, closed: 2, blocked: 8, gateFalsePositives: 2, gateFalsePositiveRate: 0.25 },
      },
    });
    expect(section?.title).toBe("Cohort");
    expect(section?.lines).toHaveLength(2);
    expect(section?.lines.join("\n")).toContain("Miner-originated: 3 merged of 4 reviewed");
    expect(section?.lines.join("\n")).toContain("Human-originated: 4 merged of 6 reviewed");
    expect(section?.lines.join("\n")).not.toMatch(/miner-one|human-one|@/);
  });

  it("renders miner-only cohort lines and n/a gate rates", () => {
    const section = buildCohortRecapSection({
      windowDays: 14,
      cohorts: {
        miner: { reviewed: 2, merged: 1, closed: 1, blocked: 2, gateFalsePositives: 1, gateFalsePositiveRate: null },
      },
    });
    expect(section?.lines).toHaveLength(1);
    expect(section?.lines[0]).toContain("Miner-originated");
    expect(section?.lines[0]).toContain("gate false-positive rate n/a");
  });

  it("renders human-only cohort lines when miner data is absent", () => {
    const section = buildCohortRecapSection({
      windowDays: 7,
      cohorts: {
        human: { reviewed: 5, merged: 3, closed: 2, blocked: 4, gateFalsePositives: 1, gateFalsePositiveRate: 0.25 },
      },
    });
    expect(section?.lines).toHaveLength(1);
    expect(section?.lines[0]).toContain("Human-originated");
    expect(section?.lines[0]).not.toContain("Miner-originated");
  });

  it("returns null when cohort keys exist but every slice is empty", () => {
    // Upstream may carry cohort keys without populated slices; cast exercises the runtime guard.
    const cohorts = { miner: undefined, human: undefined } as unknown as NonNullable<CohortRecapSource["cohorts"]>;
    expect(buildCohortRecapSection({ windowDays: 7, cohorts })).toBeNull();
  });
});
