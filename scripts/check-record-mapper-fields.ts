#!/usr/bin/env node
// #10270: a DB column that is written, declared on the record, and read via `record.field` -- but never
// populated by the row→record mapper.
//
// The instance that prompted this: `visual_capture_unobtainable_sha`. `markPullRequestVisualCaptureUnobtainable`
// wrote it, `PullRequestRecord` declared it, `processors.ts` read it at two sites to decide
// `captureUnobtainable` -- and `mapPullRequestRow` never mapped it. So the read was permanently `undefined`,
// #9881's "this repo has no preview pipeline, degrade the close" path never fired once, and contributor PRs
// kept being closed over evidence they could not produce. One row on the Orb carried the mark; zero degrade
// events in 30 days.
//
// Nothing caught it, and nothing could have:
//
//   • TSC cannot: the field is optional (`?:`), so "never populated" and "populated with undefined" are the
//     same type. Making it required would catch it, but the engine keeps a structurally-parallel
//     `PullRequestRecord` that would then have to gain the field too -- coupling two types that are
//     independent on purpose. The type system is the wrong tool here; this is.
//   • A test cannot, cheaply: every assertion about the field passes vacuously. A test reading it back gets
//     `undefined`, which is indistinguishable from "not set yet" unless the test asserts against the COLUMN.
//
// WHAT THIS CHECKS, and why the predicate is narrow. "Every column must appear in the mapper" is the obvious
// rule and it is wrong: of the 11 unmapped `pull_requests` columns, 10 are legitimate (JSON columns mapped
// under a parsed name, the primary key, columns read through dedicated selects or aggregates). A checker that
// fired on all ten would be muted within a week. The predicate that isolates the real bug is the conjunction:
//
//     declared on the record type
//       AND backed by a column on the mapper's OWN table
//       AND read via `record.field`
//       AND absent from the mapper
//
// A field nobody reads off the record is not a bug. A field the mapper populates is not a bug. And a field
// with no column behind it is not a bug either -- `PullRequestRecord.changedFiles` is populated by callers
// that already resolved the diff, and its only same-named column belongs to a DIFFERENT table
// (`recentMergedPullRequests`). Dropping that fourth conjunct makes this checker report it, which is the
// false positive that would get the whole thing muted. Only the intersection of all four is a real defect,
// and on this tree that intersection is exactly the one instance.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One record type, its mapper, and the sources that read fields off it. */
type RecordSurface = {
  /** Human name, used in the failure message. */
  name: string;
  /** File declaring the TS record type. */
  typeFile: string;
  /** The `export type <X> = {` / `export interface <X> {` block to read field declarations from. */
  typeName: string;
  /** File containing the row→record mapper. */
  mapperFile: string;
  /** The `schema.ts` table the mapper reads its row from. A record field with no column here is
   *  caller-populated, not row-backed, so its absence from the mapper is correct. */
  schemaFile: string;
  /** The `export const <X> = sqliteTable(` binding for that table. */
  schemaTable: string;
  /** A string unique to the mapper's object literal, used to locate it. */
  mapperAnchor: string;
  /** Files whose `<binding>.<field>` reads count as "someone reads this off the record". */
  readerFiles: readonly string[];
  /** Bindings that hold a record of this type in the reader files (e.g. `pr.headSha`). */
  readerBindings: readonly string[];
};

const SURFACES: readonly RecordSurface[] = [
  {
    name: "PullRequestRecord",
    typeFile: "src/types.ts",
    typeName: "PullRequestRecord",
    mapperFile: "src/db/repositories.ts",
    mapperAnchor: "screenshotTablePresenceSatisfied: parseJson<",
    schemaFile: "src/db/schema.ts",
    schemaTable: "pullRequests",
    readerFiles: ["src/queue/processors.ts"],
    readerBindings: ["pr", "pullRequest", "storedPr"],
  },
];

export type Violation = { surface: string; field: string };

/** Field names declared on `typeName`'s object body. */
export function declaredFields(source: string, typeName: string): string[] {
  const start = source.search(new RegExp(`export (?:type ${typeName} = \\{|interface ${typeName} \\{)`));
  if (start === -1) return [];
  // The declaration ends at the first line that is a closing brace in column 0 (`};` or `}`), which is how
  // every record type in this repo is formatted.
  const rest = source.slice(start);
  const end = rest.search(/\n\}[;]?\n/);
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...new Set([...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]!))];
}

/** Field names the mapper's object literal populates. */
export function mappedFields(source: string, anchor: string): string[] {
  const at = source.indexOf(anchor);
  if (at === -1) return [];
  const open = source.lastIndexOf("return {", at);
  if (open === -1) return [];
  const close = source.indexOf("\n  };", at);
  const body = source.slice(open, close === -1 ? source.length : close);
  return [...new Set([...body.matchAll(/^\s{4}(\w+):/gm)].map((match) => match[1]!))];
}

/** The TS-side column names declared on `tableName`'s Drizzle table body. */
export function tableColumns(source: string, tableName: string): string[] {
  const start = source.indexOf(`export const ${tableName} = `);
  if (start === -1) return [];
  const rest = source.slice(start);
  const end = rest.search(/\n\)/);
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...new Set([...body.matchAll(/^\s{4}(\w+):\s*\w+\(/gm)].map((match) => match[1]!))];
}

/** Fields read as `<binding>.<field>` anywhere in `sources`. */
export function fieldsReadOffRecord(sources: readonly string[], bindings: readonly string[]): Set<string> {
  const read = new Set<string>();
  const pattern = new RegExp(`\\b(?:${bindings.join("|")})\\??\\.(\\w+)`, "g");
  for (const source of sources) {
    for (const match of source.matchAll(pattern)) read.add(match[1]!);
  }
  return read;
}

/** Declared AND read off the record AND not mapped — see the header for why all three conjuncts are needed. */
export function findViolations(
  surface: RecordSurface,
  files: { type: string; mapper: string; schema: string; readers: readonly string[] },
): Violation[] {
  const declared = declaredFields(files.type, surface.typeName);
  const mapped = new Set(mappedFields(files.mapper, surface.mapperAnchor));
  const columns = new Set(tableColumns(files.schema, surface.schemaTable));
  const read = fieldsReadOffRecord(files.readers, surface.readerBindings);
  return declared
    .filter((field) => columns.has(field) && read.has(field) && !mapped.has(field))
    .map((field) => ({ surface: surface.name, field }));
}

function main(): void {
  const violations: Violation[] = [];
  for (const surface of SURFACES) {
    violations.push(
      ...findViolations(surface, {
        type: readFileSync(surface.typeFile, "utf8"),
        mapper: readFileSync(surface.mapperFile, "utf8"),
        schema: readFileSync(surface.schemaFile, "utf8"),
        readers: surface.readerFiles.map((file) => readFileSync(file, "utf8")),
      }),
    );
  }
  if (violations.length === 0) {
    console.log(`check-record-mapper-fields: every declared-and-read record field is populated by its mapper.`);
    return;
  }
  process.stderr.write(`check-record-mapper-fields: ${violations.length} field(s) are declared, read, and never mapped (#10270):\n\n`);
  for (const violation of violations) process.stderr.write(`  ${violation.surface}.${violation.field}\n`);
  process.stderr.write(
    "\nEach of these reads `undefined` at every call site, forever, with no compiler error and no failing\n" +
      "test -- the field is optional, so 'never populated' and 'populated with undefined' are the same type.\n" +
      "That is how #9881's capture-unobtainable degrade sat dead in production while its column was being\n" +
      "written. Map the field in the row->record mapper beside its neighbours.\n",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
