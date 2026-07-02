import { describe, expect, it } from "vitest";
import { detectMigrationCollisions, extractMigrationNumber, KNOWN_MIGRATION_DUPLICATES, MIGRATION_FILENAME_PATTERN } from "../../src/db/migration-collisions";

describe("extractMigrationNumber (#2550)", () => {
  it("extracts the 4-digit number from a conforming filename", () => {
    expect(extractMigrationNumber("0001_initial.sql")).toBe(1);
    expect(extractMigrationNumber("0090_contributor_cap_label.sql")).toBe(90);
    expect(extractMigrationNumber("1234_some_migration.sql")).toBe(1234);
  });

  it("returns null for a non-conforming filename", () => {
    expect(extractMigrationNumber("not_a_migration.sql")).toBeNull();
    expect(extractMigrationNumber("001_too_few_digits.sql")).toBeNull();
    expect(extractMigrationNumber("0001.sql")).toBeNull();
    expect(extractMigrationNumber("0001_UPPER.sql")).toBeNull();
  });

  it("MIGRATION_FILENAME_PATTERN matches the same conforming/non-conforming shapes", () => {
    expect(MIGRATION_FILENAME_PATTERN.test("0001_initial.sql")).toBe(true);
    expect(MIGRATION_FILENAME_PATTERN.test("not_a_migration.sql")).toBe(false);
  });
});

describe("detectMigrationCollisions (#2550)", () => {
  it("returns [] for a filename list with no duplicate numbers", () => {
    expect(detectMigrationCollisions(["0001_a.sql", "0002_b.sql", "0003_c.sql"])).toEqual([]);
  });

  it("returns [] for an empty list", () => {
    expect(detectMigrationCollisions([])).toEqual([]);
  });

  it("flags a genuine collision (two files, same number, no grandfather list)", () => {
    const collisions = detectMigrationCollisions(["0090_a.sql", "0090_b.sql"]);
    expect(collisions).toEqual([{ number: 90, paddedNumber: "0090", files: ["0090_a.sql", "0090_b.sql"] }]);
  });

  it("sorts a collision's files alphabetically regardless of input order", () => {
    const collisions = detectMigrationCollisions(["0090_z.sql", "0090_a.sql"]);
    expect(collisions[0]?.files).toEqual(["0090_a.sql", "0090_z.sql"]);
  });

  it("sorts multiple simultaneous collisions numerically", () => {
    const collisions = detectMigrationCollisions(["0090_a.sql", "0090_b.sql", "0010_a.sql", "0010_b.sql"]);
    expect(collisions.map((c) => c.number)).toEqual([10, 90]);
  });

  it("ignores non-conforming filenames entirely (no crash, no false collision)", () => {
    expect(detectMigrationCollisions(["README.md", "not_a_migration.sql", "0001_a.sql"])).toEqual([]);
  });

  it("does not flag an EXACT grandfathered set as a collision", () => {
    const known = new Map([[90, new Set(["0090_a.sql", "0090_b.sql"])]]);
    expect(detectMigrationCollisions(["0090_a.sql", "0090_b.sql"], known)).toEqual([]);
  });

  it("STILL flags a collision when a third file joins an already-grandfathered number", () => {
    const known = new Map([[90, new Set(["0090_a.sql", "0090_b.sql"])]]);
    const collisions = detectMigrationCollisions(["0090_a.sql", "0090_b.sql", "0090_c.sql"], known);
    expect(collisions).toEqual([{ number: 90, paddedNumber: "0090", files: ["0090_a.sql", "0090_b.sql", "0090_c.sql"] }]);
  });

  it("STILL flags a collision when the grandfathered set doesn't exactly match (substitution)", () => {
    const known = new Map([[90, new Set(["0090_a.sql", "0090_b.sql"])]]);
    const collisions = detectMigrationCollisions(["0090_a.sql", "0090_c.sql"], known);
    expect(collisions).toEqual([{ number: 90, paddedNumber: "0090", files: ["0090_a.sql", "0090_c.sql"] }]);
  });

  it("defaults knownDuplicates to an empty map when omitted", () => {
    expect(detectMigrationCollisions(["0090_a.sql", "0090_b.sql"])).toHaveLength(1);
  });
});

describe("KNOWN_MIGRATION_DUPLICATES (#2550)", () => {
  it("stays byte-identical to scripts/check-migrations.mjs's grandfathered list", () => {
    // A drift here would mean the CI script and the live premerge recheck disagree about what's grandfathered
    // — this pins the exact set so a future addition to one side without the other is caught immediately.
    expect([...KNOWN_MIGRATION_DUPLICATES.keys()].sort((a, b) => a - b)).toEqual([15, 17, 74, 90]);
    expect(KNOWN_MIGRATION_DUPLICATES.get(90)).toEqual(new Set(["0090_contributor_cap_label.sql", "0090_pull_request_detail_sync_head_sha.sql"]));
  });
});
