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

  it("catches an ===/|| chain, not just an array literal — the form review caught it missing", () => {
    // The first version of this guard only matched comma-separated arrays, so it could never have found
    // engine.ts's `value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR"` and its 14 call
    // sites. A guard that recognises one spelling of what it guards is a hand-maintained list again.
    const chain = 'return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";';
    expect(scan({ "fake/a.ts": chain })).toHaveLength(1);
  });

  it("catches a chain a formatter has broken across lines", () => {
    const wrapped = 'return (\n  value === "OWNER" ||\n  value === "MEMBER" ||\n  value === "COLLABORATOR"\n);';
    expect(scan({ "fake/a.ts": wrapped })).toHaveLength(1);
  });

  it("reports the line that NAMES an association, not the window's first line", () => {
    const found = scan({ "fake/a.ts": '}\n\nfunction f() {\n  return x === "OWNER" || x === "MEMBER" || x === "COLLABORATOR";' });
    expect(found[0]?.line, "a window opening on a brace must not be what gets reported").toBe(4);
    expect(found[0]?.snippet).toContain("OWNER");
  });

  it("does NOT flag a site with genuinely different semantics that is allowlisted with a reason", () => {
    // command-authorization.ts maps OWNER/MEMBER to `maintainer` but COLLABORATOR to a SEPARATE role.
    // "Fixing" it would grant collaborators maintainer-only commands.
    const allowed = new Map([["fake/roles.ts", "different semantics: COLLABORATOR is its own role"]]);
    const line = 'if (a === "OWNER" || a === "MEMBER") r.push("maintainer");\nif (a === "COLLABORATOR") r.push("collaborator");';
    expect(scan({ "fake/roles.ts": line })).toHaveLength(1);
    expect(findMaintainerAssociationCopies({ roots: ["fake"], listFiles: () => ["fake/roles.ts"], readFile: () => line, allowed })).toEqual([]);
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
    const spaced = ['["OWNER", "MEMBER", "COLLABORATOR"]', "", "", "", "", '["OWNER", "MEMBER", "COLLABORATOR"]'].join("\n");
    const found = scan({ "fake/b.ts": '["OWNER", "MEMBER", "COLLABORATOR"]', "fake/a.ts": spaced });
    expect(found.map((c) => `${c.file}:${c.line}`)).toEqual(["fake/a.ts:1", "fake/a.ts:6", "fake/b.ts:1"]);
  });

  it("collapses occurrences that fall inside ONE window into a single report", () => {
    // Deliberate: the scan reads a 4-line window so a formatter-wrapped chain is still caught, and two
    // hits inside one window are one finding, not two. The guard's job is to fail the build and name the
    // file -- a developer fixes the file and re-runs, so duplicate noise costs more than it informs.
    const adjacent = '["OWNER", "MEMBER", "COLLABORATOR"]\nx\n["OWNER", "MEMBER", "COLLABORATOR"]';
    expect(scan({ "fake/a.ts": adjacent })).toHaveLength(1);
  });

  it("passes on the REAL repository — the whole point of wiring it into test:ci", () => {
    expect(findMaintainerAssociationCopies()).toEqual([]);
  });
});
