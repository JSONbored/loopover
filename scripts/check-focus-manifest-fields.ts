#!/usr/bin/env node
// `FOCUS_MANIFEST_TOP_LEVEL_FIELDS` must equal the keys `parseFocusManifest` actually reads (#9979, item 4
// of #9860).
//
// The list's own comment says "Every top-level key `parseFocusManifest` below actually reads." That is a
// statement about code twenty lines further down, and nothing enforced it -- the same shape as the
// `turbo.json` inputs comment #9860 calls out as the tell: a snapshot written as though it were a guarantee.
//
// DRIFT IS SILENT IN BOTH DIRECTIONS, and asymmetrically bad, because this list is the single source of
// truth for unknown-field detection (#9065):
//
//   • DECLARED BUT NEVER READ -- the parser accepts the field, warns about nothing, and ignores it. An
//     operator puts it in `.loopover.yml`, sees no error, and the setting does nothing at all. This is the
//     worse direction: it looks configured.
//   • READ BUT NOT DECLARED -- the parser consumes the field while simultaneously warning "unknown top-level
//     field" about it, and config-lint's `recognizedFieldsFor` leaves it out of the recognized count. A
//     working field reported as a mistake.
//
// COMPUTED, NOT RESTATED. There is deliberately no second list here. The declared names are read out of the
// array literal and the used names out of the function body, so this file has nothing to keep in sync and
// cannot itself go stale -- the bar #9853 set and the one #9860 asks for.
//
// A REGEX OVER SOURCE, not the TypeScript AST, and that is a real tradeoff worth stating. The access pattern
// it depends on is uniform and mechanical (`record.<field>` inside one function), and {@link parserReadsAre}
// FAILS LOUDLY if the shape it relies on ever disappears rather than quietly matching nothing -- which is the
// failure mode that would turn this into another guard that reads as coverage while checking nothing.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FOCUS_MANIFEST_SOURCE = "packages/loopover-engine/src/focus-manifest.ts";

const DECLARATION = /export const FOCUS_MANIFEST_TOP_LEVEL_FIELDS = \[(.*?)\] as const;/s;
const PARSER_START = "export function parseFocusManifest(";

/** PURE. The names in the exported array literal, in source order. Throws when the declaration is missing --
 *  a renamed or deleted constant must break this checker, not silently empty it. */
export function declaredFields(source: string): string[] {
  const match = DECLARATION.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(`could not find the FOCUS_MANIFEST_TOP_LEVEL_FIELDS declaration in ${FOCUS_MANIFEST_SOURCE}`);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!);
}

/** PURE. The `record.<key>` / `record["<key>"]` names read inside `parseFocusManifest`'s body.
 *
 *  The body is delimited by the next top-level `export ` after the signature: this file declares many parsers
 *  and reading past the boundary would pull in another function's field names. Throws when either the
 *  signature or any read is missing, for the reason in the header -- a checker that matches nothing must not
 *  report success. */
export function parserReadsAre(source: string): string[] {
  const start = source.indexOf(PARSER_START);
  if (start === -1) throw new Error(`could not find ${PARSER_START} in ${FOCUS_MANIFEST_SOURCE}`);
  const end = source.indexOf("\nexport ", start + PARSER_START.length);
  const body = end === -1 ? source.slice(start) : source.slice(start, end);
  const names = new Set<string>();
  for (const match of body.matchAll(/\brecord\.([A-Za-z_$][\w$]*)/g)) names.add(match[1]!);
  for (const match of body.matchAll(/\brecord\["([^"]+)"\]/g)) names.add(match[1]!);
  if (names.size === 0) {
    throw new Error("found no `record.<field>` reads in parseFocusManifest -- the access pattern this checker relies on has changed");
  }
  return [...names].sort();
}

export type FieldDrift = { declaredNotRead: string[]; readNotDeclared: string[] };

/** PURE. The two-way comparison. */
export function findFieldDrift(declared: readonly string[], read: readonly string[]): FieldDrift {
  const readSet = new Set(read);
  const declaredSet = new Set(declared);
  return {
    declaredNotRead: declared.filter((field) => !readSet.has(field)),
    readNotDeclared: read.filter((field) => !declaredSet.has(field)),
  };
}

/** PURE. The failure text, naming each field and what its specific breakage looks like to an operator. */
export function describeFieldDrift(drift: FieldDrift): string {
  const lines = ["", `FOCUS_MANIFEST_TOP_LEVEL_FIELDS no longer matches what parseFocusManifest reads (${FOCUS_MANIFEST_SOURCE}):`, ""];
  if (drift.declaredNotRead.length > 0) {
    lines.push("  DECLARED but never read -- the parser accepts these and silently ignores them, so an operator");
    lines.push("  who sets one gets no warning and no effect:");
    for (const field of drift.declaredNotRead) lines.push(`    • ${field}`);
    lines.push("", "  Either read the field in parseFocusManifest, or drop it from the list (and consider");
    lines.push("  RETIRED_FOCUS_MANIFEST_FIELDS if operators may already have it in a manifest).", "");
  }
  if (drift.readNotDeclared.length > 0) {
    lines.push("  READ but not declared -- the parser consumes these while warning \"unknown top-level field\"");
    lines.push("  about them, and config-lint omits them from the recognized count:");
    for (const field of drift.readNotDeclared) lines.push(`    • ${field}`);
    lines.push("", "  Add each to FOCUS_MANIFEST_TOP_LEVEL_FIELDS.", "");
  }
  return lines.join("\n");
}

/* v8 ignore start -- the self-execution guard; every pure branch above is driven directly in tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = readFileSync(FOCUS_MANIFEST_SOURCE, "utf8");
  const declared = declaredFields(source);
  const read = parserReadsAre(source);
  const drift = findFieldDrift(declared, read);
  if (drift.declaredNotRead.length === 0 && drift.readNotDeclared.length === 0) {
    process.stdout.write(`focus-manifest-fields: ${declared.length} top-level field(s) declared and read; no drift.\n`);
    process.exit(0);
  }
  process.stderr.write(describeFieldDrift(drift));
  process.exit(1);
}
/* v8 ignore stop */
