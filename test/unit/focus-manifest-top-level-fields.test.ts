import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FOCUS_MANIFEST_TOP_LEVEL_FIELDS } from "../../packages/loopover-engine/src/focus-manifest";

// #9860 (item 4): FOCUS_MANIFEST_TOP_LEVEL_FIELDS is a hand-kept list of 28 keys whose doc comment claims it
// is "every top-level key `parseFocusManifest` below actually reads". Nothing checked that claim, and it is
// load-bearing in both directions:
//
//   • A key the parser reads but the list omits is silently reported to operators as an UNKNOWN FIELD --
//     the config-lint/validator path warns about a setting that in fact works.
//   • A key in the list the parser never reads is worse: the validator blesses it, the runtime ignores it,
//     and an operator's setting does nothing while every surface says it is fine.
//
// #9813 and #9821 each shipped a bug from missing one of this registry's touchpoints. This computes the
// relation instead of trusting the comment.
//
// SOURCE-SCANNED rather than exercised through the parser, because the failure is a key the parser reads and
// the list forgot -- which by construction produces no observable behaviour difference to assert on. The
// scan is narrow: `record` is the single local `parseFocusManifest` binds the raw object to, and the function
// body is delimited by the two exported functions around it.
const SOURCE = "packages/loopover-engine/src/focus-manifest.ts";

/** Every `record.<key>` / `record["<key>"]` read inside parseFocusManifest's body. */
function topLevelKeysReadByParser(source: string): Set<string> {
  const start = source.indexOf("export function parseFocusManifest(raw: unknown");
  const end = source.indexOf("export function parseFocusManifestContent");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  const keys = new Set<string>();
  for (const match of body.matchAll(/\brecord\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(match[1]!);
  for (const match of body.matchAll(/\brecord\["([^"]+)"\]/g)) keys.add(match[1]!);
  return keys;
}

describe("FOCUS_MANIFEST_TOP_LEVEL_FIELDS is the set the parser actually reads (#9860)", () => {
  const source = readFileSync(SOURCE, "utf8");

  it("declares every key parseFocusManifest reads", () => {
    // Missing here => the validator calls a working setting an unknown field.
    const read = topLevelKeysReadByParser(source);
    const declared = new Set<string>(FOCUS_MANIFEST_TOP_LEVEL_FIELDS);
    expect([...read].filter((key) => !declared.has(key)).sort()).toEqual([]);
  });

  it("declares nothing the parser ignores", () => {
    // Present here but unread => the validator blesses a setting that silently does nothing at runtime,
    // which is the more dangerous direction: every surface reports success.
    const read = topLevelKeysReadByParser(source);
    expect(FOCUS_MANIFEST_TOP_LEVEL_FIELDS.filter((key) => !read.has(key)).sort()).toEqual([]);
  });

  it("guards against a vacuous scan: the parser really does read a known key", () => {
    // Without this, a refactor that renamed `record` would empty both sets and make the two assertions above
    // pass while checking nothing at all.
    const read = topLevelKeysReadByParser(source);
    expect(read.size).toBeGreaterThan(20);
    expect(read.has("wantedPaths")).toBe(true);
    expect(read.has("gate")).toBe(true);
  });
});
