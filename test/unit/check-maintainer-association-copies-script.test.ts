import { describe, expect, it } from "vitest";
import { DEFINITION_FILE, findMaintainerAssociationCopies } from "../../scripts/check-maintainer-association-copies";

// The guard for #9860's "eighth copy". Its own logic is tested against a synthetic tree so the cases that
// matter -- what it must catch, and what it must NOT -- are pinned independently of the real repo.
describe("check-maintainer-association-copies", () => {
  const scan = (files: Record<string, string>) =>
    findMaintainerAssociationCopies({
      roots: ["fake"],
      listFiles: () => Object.keys(files),
      readFile: (file) => files[file] ?? "",
    });

  it("catches a re-typed maintainer triple", () => {
    const found = scan({ "fake/a.ts": 'const M = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "fake/a.ts", line: 1 });
  });

  it("catches it regardless of quoting or spacing", () => {
    expect(scan({ "fake/a.ts": "if (['OWNER','MEMBER','COLLABORATOR'].includes(x)) {}" })).toHaveLength(1);
    expect(scan({ "fake/a.ts": '[ "OWNER" ,  "MEMBER" ,   "COLLABORATOR" ]' })).toHaveLength(1);
  });

  it("does NOT flag a full eight-value wire schema", () => {
    // z.enum over GitHub's whole vocabulary is a schema, not this predicate; conflating them would be
    // its own mistake, and the contract legitimately declares it four times.
    const enumLine = 'authorAssociation: z.enum(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "NONE"]),';
    expect(scan({ "fake/schema.ts": enumLine })).toEqual([]);
  });

  it("does NOT flag the definition module itself", () => {
    expect(scan({ [DEFINITION_FILE]: 'export const MAINTAINER_AUTHOR_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];' })).toEqual([]);
  });

  it("reports every occurrence, sorted by file then line", () => {
    const found = scan({
      "fake/b.ts": '["OWNER", "MEMBER", "COLLABORATOR"]',
      "fake/a.ts": 'x\n["OWNER", "MEMBER", "COLLABORATOR"]\ny\n["OWNER", "MEMBER", "COLLABORATOR"]',
    });
    expect(found.map((c) => `${c.file}:${c.line}`)).toEqual(["fake/a.ts:2", "fake/a.ts:4", "fake/b.ts:1"]);
  });

  it("passes on the REAL repository — the whole point of wiring it into test:ci", () => {
    expect(findMaintainerAssociationCopies()).toEqual([]);
  });
});
