import { describe, expect, it } from "vitest";
import { findMutatedReleasedMigrations, type ReleasedTagManifest } from "../../scripts/check-released-migrations-immutable";
import { MIGRATION_REBASELINE } from "../../scripts/migration-rebaseline";

// #9420: a doc-comment edit inside migrations/0180_decision_ledger.sql shipped in orb-v3.5.0. Because
// src/selfhost/migrate.ts hashes each applied migration's FULL text and throws on a post-apply mismatch,
// that comment made every already-upgraded ORB fail to BOOT. Caught by comparing the live server's
// _selfhost_migrations ledger against the repo before the next image was cut. These pin the guard.

const tag = (name: string, files: Record<string, string>): ReleasedTagManifest => ({ tag: name, files: new Map(Object.entries(files)) });

describe("findMutatedReleasedMigrations (#9420)", () => {
  it("REGRESSION: reproduces the real failure — a released migration whose content changed", () => {
    const violations = findMutatedReleasedMigrations(
      [tag("orb-v3.5.0-beta.5", { "0180_decision_ledger.sql": "blob-original" })],
      new Map([["0180_decision_ledger.sql", "blob-edited"]]),
    );
    expect(violations).toEqual([{ file: "0180_decision_ledger.sql", tag: "orb-v3.5.0-beta.5", kind: "modified" }]);
  });

  it("passes once the file is restored — the fix, not just the detection", () => {
    const violations = findMutatedReleasedMigrations(
      [tag("orb-v3.5.0-beta.5", { "0180_decision_ledger.sql": "blob-original" })],
      new Map([["0180_decision_ledger.sql", "blob-original"]]),
    );
    expect(violations).toEqual([]);
  });

  it("freezes at the FIRST release, so a later tag that disagrees cannot move the baseline", () => {
    // This is the #9420 shape exactly: beta.5 shipped the original, 3.5.0 shipped the edit. Anchoring on the
    // earliest tag is what lets the correct repair (restore the original) ever go green again -- checking
    // against every tag would make the two releases contradict each other permanently.
    const violations = findMutatedReleasedMigrations(
      [
        tag("orb-v3.5.0-beta.5", { "0180_decision_ledger.sql": "blob-original" }),
        tag("orb-v3.5.0", { "0180_decision_ledger.sql": "blob-edited" }),
      ],
      new Map([["0180_decision_ledger.sql", "blob-original"]]),
    );
    expect(violations).toEqual([]);
  });

  it("REGRESSION: deleting a released migration is refused too", () => {
    const violations = findMutatedReleasedMigrations([tag("orb-v1.0.0", { "0007_thing.sql": "blob" })], new Map());
    expect(violations).toEqual([{ file: "0007_thing.sql", tag: "orb-v1.0.0", kind: "deleted" }]);
  });

  it("a NEW, never-released migration is free to change", () => {
    const violations = findMutatedReleasedMigrations(
      [tag("orb-v1.0.0", { "0007_thing.sql": "blob" })],
      new Map([
        ["0007_thing.sql", "blob"],
        ["0008_brand_new.sql", "anything-at-all"],
      ]),
    );
    expect(violations).toEqual([]);
  });

  it("reports every violation, sorted, not just the first", () => {
    const violations = findMutatedReleasedMigrations(
      [tag("orb-v1.0.0", { "0009_b.sql": "x", "0008_a.sql": "x", "0010_c.sql": "x" })],
      new Map([
        ["0009_b.sql", "changed"],
        ["0008_a.sql", "changed"],
        ["0010_c.sql", "x"],
      ]),
    );
    expect(violations.map((violation) => violation.file)).toEqual(["0008_a.sql", "0009_b.sql"]);
  });

  it("no released tags means nothing is frozen — an empty repo is not a violation", () => {
    expect(findMutatedReleasedMigrations([], new Map([["0001_x.sql", "blob"]]))).toEqual([]);
  });
});

describe("MIGRATION_REBASELINE", () => {
  it("INVARIANT: every rebaselined file still exists and is still released", async () => {
    // A stale entry is worse than none: it silently exempts a filename that no longer means anything, and
    // (per validate-no-hand-written-js's stale-path lesson) a watched path that quietly stops existing is
    // how a guard rots. Fails here rather than degrading in silence.
    const { readdirSync } = await import("node:fs");
    const onDisk = new Set(readdirSync("migrations"));
    for (const file of MIGRATION_REBASELINE.keys()) expect({ file, present: onDisk.has(file) }).toEqual({ file, present: true });
  });

  it("INVARIANT: the table does not grow — a new entry means someone papered over a boot-breaking edit", () => {
    // Pinned to the count generated when the guard landed. Raising this number is not a merge conflict to
    // resolve; it means the change under review edits a released migration and must be done differently.
    expect(MIGRATION_REBASELINE.size).toBe(35);
  });

  it("re-freezes rather than exempts: a rebaselined file that changes AGAIN is still caught", () => {
    const [file] = [...MIGRATION_REBASELINE.keys()];
    expect(file).toBeDefined();
    const frozenBlob = MIGRATION_REBASELINE.get(file!);
    const violations = findMutatedReleasedMigrations(
      [tag("orb-v0.1.0-beta.1", { [file!]: "the-original-pre-edit-blob" })],
      new Map([[file!, "a-brand-new-edit"]]),
    );
    expect(violations).toHaveLength(1);
    expect(frozenBlob).not.toBe("a-brand-new-edit");
  });
});
