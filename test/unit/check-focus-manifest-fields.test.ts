import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  declaredFields,
  describeFieldDrift,
  findFieldDrift,
  FOCUS_MANIFEST_SOURCE,
  parserReadsAre,
} from "../../scripts/check-focus-manifest-fields";

// #9979 (item 4 of #9860): the guard for a comment that asserts a fact about the code below it.
//
// `FOCUS_MANIFEST_TOP_LEVEL_FIELDS`'s header says "Every top-level key parseFocusManifest below actually
// reads", and nothing enforced it. The list is the single source of truth for unknown-field detection, so
// drift is silent in both directions and worse in the declared-but-unread one: the parser accepts a field,
// warns about nothing, and ignores it, which looks to an operator exactly like a setting that works.

const SOURCE = readFileSync(FOCUS_MANIFEST_SOURCE, "utf8");

/** A miniature file with the same two shapes the checker reads, so the parsing can be driven over inputs the
 *  real file will never contain -- including the broken ones. */
function fixture(input: { declared: readonly string[]; read: readonly string[] }): string {
  return [
    "// preamble",
    `export const FOCUS_MANIFEST_TOP_LEVEL_FIELDS = [\n${input.declared.map((field) => `  "${field}",`).join("\n")}\n] as const;`,
    "",
    "export function parseFocusManifest(raw: unknown): FocusManifest {",
    "  const record = raw as Record<string, JsonValue>;",
    ...input.read.map((field) => `  const ${field} = record.${field};`),
    "  return manifest;",
    "}",
    "",
    "export function parseSomethingElse(raw: unknown) {",
    "  const record = raw as Record<string, JsonValue>;",
    "  return record.notATopLevelField;",
    "}",
  ].join("\n");
}

describe("declaredFields", () => {
  it("reads the names out of the array literal in source order", () => {
    expect(declaredFields(fixture({ declared: ["source", "gate"], read: [] }))).toEqual(["source", "gate"]);
  });

  it("THROWS when the declaration is gone, rather than reporting an empty list", () => {
    // A renamed or deleted constant must break this checker loudly. Returning [] would make the comparison
    // trivially pass and turn the guard into decoration.
    expect(() => declaredFields("export const SOMETHING_ELSE = [] as const;")).toThrow(/could not find the FOCUS_MANIFEST_TOP_LEVEL_FIELDS declaration/);
  });
});

describe("parserReadsAre", () => {
  it("collects record.<field> reads from parseFocusManifest", () => {
    expect(parserReadsAre(fixture({ declared: [], read: ["gate", "settings"] }))).toEqual(["gate", "settings"]);
  });

  it("REGRESSION: stops at the next top-level export, so a sibling parser's fields do not leak in", () => {
    // focus-manifest.ts declares many parsers that all destructure a local named `record`. Reading past the
    // function boundary would pull `notATopLevelField` in and report it as undeclared drift forever.
    expect(parserReadsAre(fixture({ declared: [], read: ["gate"] }))).not.toContain("notATopLevelField");
  });

  it("also handles bracket access", () => {
    const source = fixture({ declared: [], read: ["gate"] }).replace("record.gate", 'record["publicStats"]');
    expect(parserReadsAre(source)).toEqual(["publicStats"]);
  });

  it("THROWS when the signature is missing", () => {
    expect(() => parserReadsAre("export const X = 1;")).toThrow(/could not find export function parseFocusManifest/);
  });

  it("THROWS when the access pattern yields nothing, rather than passing vacuously", () => {
    // The most dangerous silent failure: someone refactors to destructuring (`const { gate } = record`) and a
    // regex-based checker matches zero fields. Zero matches must be an error, never "no drift".
    const refactored = ["export function parseFocusManifest(raw: unknown) {", "  const { gate } = raw as Record<string, unknown>;", "  return gate;", "}"].join("\n");
    expect(() => parserReadsAre(refactored)).toThrow(/access pattern this checker relies on has changed/);
  });
});

describe("findFieldDrift", () => {
  it("reports nothing when the two agree", () => {
    expect(findFieldDrift(["a", "b"], ["a", "b"])).toEqual({ declaredNotRead: [], readNotDeclared: [] });
  });

  it("catches a field declared but never read -- the direction that looks configured and does nothing", () => {
    expect(findFieldDrift(["a", "ghost"], ["a"]).declaredNotRead).toEqual(["ghost"]);
  });

  it("catches a field read but never declared -- a working field warned about as unknown", () => {
    expect(findFieldDrift(["a"], ["a", "orphan"]).readNotDeclared).toEqual(["orphan"]);
  });

  it("is order-insensitive, since the list is source-ordered and the reads are sorted", () => {
    expect(findFieldDrift(["b", "a"], ["a", "b"])).toEqual({ declaredNotRead: [], readNotDeclared: [] });
  });
});

describe("describeFieldDrift", () => {
  it("names each field and what its breakage looks like to an operator", () => {
    const message = describeFieldDrift(findFieldDrift(["a", "ghost"], ["a", "orphan"]));
    expect(message).toContain("ghost");
    expect(message).toContain("orphan");
    expect(message).toContain("silently ignores them");
    expect(message).toContain("Add each to FOCUS_MANIFEST_TOP_LEVEL_FIELDS");
  });
});

describe("the real focus-manifest.ts", () => {
  it("INVARIANT: every declared top-level field is read by parseFocusManifest, and vice versa", () => {
    // The whole point, asserted against the actual file rather than a fixture.
    expect(findFieldDrift(declaredFields(SOURCE), parserReadsAre(SOURCE))).toEqual({ declaredNotRead: [], readNotDeclared: [] });
  });

  it("reads a non-trivial number of fields, so the invariant above cannot pass on an empty set", () => {
    // Guards the guard: if both extractors somehow returned [], the assertion above would pass. They cannot
    // (both throw on no match), and this pins the expectation anyway.
    expect(declaredFields(SOURCE).length).toBeGreaterThan(20);
    expect(parserReadsAre(SOURCE).length).toBeGreaterThan(20);
  });

  it("includes the fields the parser's own structure guarantees", () => {
    // A spot-check with real names, so a wholesale extraction failure that still returned *something* is
    // caught rather than shrugged at.
    expect(declaredFields(SOURCE)).toEqual(expect.arrayContaining(["source", "gate", "settings", "review", "publicStats"]));
  });
});
