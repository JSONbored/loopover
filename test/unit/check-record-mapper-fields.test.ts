import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declaredFields, fieldsReadOffRecord, findViolations, mappedFields, tableColumns } from "../../scripts/check-record-mapper-fields";

// #10270: the checker's value is entirely in which cases it fires on. A version that missed the real bug is
// useless; a version that fired on the ten legitimate unmapped columns would be muted inside a week. So each
// case below is written as the tree-shape that produces it, and the false-positive cases matter as much as the
// true one.

const SURFACE = {
  name: "PullRequestRecord",
  typeFile: "src/types.ts",
  typeName: "PullRequestRecord",
  mapperFile: "src/db/repositories.ts",
  mapperAnchor: "screenshotTablePresenceSatisfied: parseJson<",
  schemaFile: "src/db/schema.ts",
  schemaTable: "pullRequests",
  readerFiles: ["src/queue/processors.ts"],
  readerBindings: ["pr", "pullRequest", "storedPr"],
} as const;

const TYPE = `
export type PullRequestRecord = {
  headSha?: string | null | undefined;
  visualCaptureSatisfiedSha?: string | null | undefined;
  visualCaptureUnobtainableSha?: string | null | undefined;
  changedFiles?: string[] | undefined;
};

export type IssueRecord = {
  unrelated: string;
};
`;

const SCHEMA = `
export const pullRequests = sqliteTable(
  "pull_requests",
  {
    headSha: text("head_sha"),
    visualCaptureSatisfiedSha: text("visual_capture_satisfied_sha"),
    visualCaptureUnobtainableSha: text("visual_capture_unobtainable_sha"),
  },
);

export const recentMergedPullRequests = sqliteTable(
  "recent_merged_pull_requests",
  {
    changedFilesJson: text("changed_files_json"),
  },
);
`;

const mapper = (fields: readonly string[]) => `
function mapPullRequestRow(row: Row) {
  return {
${fields.map((field) => `    ${field}: row.${field},`).join("\n")}
    screenshotTablePresenceSatisfied: parseJson<null>(row.screenshotTablePresenceSatisfiedJson, null),
  };
}
`;

const READER = `
  const a = pr.headSha;
  const b = pr.visualCaptureSatisfiedSha;
  const c = Boolean(pr.headSha) && pr.visualCaptureUnobtainableSha === pr.headSha;
  const d = pr.changedFiles;
`;

const run = (fields: readonly string[], type = TYPE, reader = READER) =>
  findViolations(SURFACE, { type, mapper: mapper(fields), schema: SCHEMA, readers: [reader] });

describe("check-record-mapper-fields (#10270)", () => {
  it("fires on the real bug: declared, column-backed, read, and unmapped", () => {
    expect(run(["headSha", "visualCaptureSatisfiedSha"])).toEqual([{ surface: "PullRequestRecord", field: "visualCaptureUnobtainableSha" }]);
  });

  it("is silent once the field is mapped", () => {
    expect(run(["headSha", "visualCaptureSatisfiedSha", "visualCaptureUnobtainableSha"])).toEqual([]);
  });

  it("does NOT fire on a caller-populated field whose only same-named column belongs to another table", () => {
    // `changedFiles` is read off the record and never mapped, and that is correct -- callers that already
    // resolved the diff set it. Dropping the column-backed conjunct reports it, and this checker would then be
    // muted for the one case it exists to catch.
    const violations = run(["headSha", "visualCaptureSatisfiedSha", "visualCaptureUnobtainableSha"]);
    expect(violations.map((violation) => violation.field)).not.toContain("changedFiles");
  });

  it("does NOT fire on a column-backed field nobody reads off the record", () => {
    // Ten of the eleven unmapped pull_requests columns are this shape. A rule of "every column must be mapped"
    // would report all of them.
    expect(run(["visualCaptureSatisfiedSha", "visualCaptureUnobtainableSha"], TYPE, "const x = 1;")).toEqual([]);
  });

  it("does NOT fire on a declared field with no column behind it at all", () => {
    const typeOnly = TYPE.replace("  changedFiles?: string[] | undefined;", "  computedElsewhere?: string | undefined;");
    expect(run(["headSha", "visualCaptureSatisfiedSha", "visualCaptureUnobtainableSha"], typeOnly, "const y = pr.computedElsewhere;")).toEqual([]);
  });

  it("passes on the real tree", () => {
    expect(
      findViolations(SURFACE, {
        type: readFileSync(SURFACE.typeFile, "utf8"),
        mapper: readFileSync(SURFACE.mapperFile, "utf8"),
        schema: readFileSync(SURFACE.schemaFile, "utf8"),
        readers: SURFACE.readerFiles.map((file) => readFileSync(file, "utf8")),
      }),
    ).toEqual([]);
  });

  describe("helpers", () => {
    it("declaredFields reads only the named type's own body", () => {
      const fields = declaredFields(TYPE, "PullRequestRecord");
      expect(fields).toContain("visualCaptureUnobtainableSha");
      expect(fields).not.toContain("unrelated");
      expect(declaredFields(TYPE, "NoSuchRecord")).toEqual([]);
    });

    it("declaredFields handles an interface declaration and an unterminated body", () => {
      expect(declaredFields("export interface Thing {\n  a?: string;\n}\n", "Thing")).toEqual(["a"]);
      expect(declaredFields("export type Thing = {\n  a?: string;", "Thing")).toEqual(["a"]);
    });

    it("mappedFields reads the mapper's object literal, and returns nothing without an anchor", () => {
      expect(mappedFields(mapper(["headSha"]), SURFACE.mapperAnchor)).toEqual(["headSha", "screenshotTablePresenceSatisfied"]);
      expect(mappedFields(mapper(["headSha"]), "no-such-anchor")).toEqual([]);
      expect(mappedFields("screenshotTablePresenceSatisfied: parseJson<", SURFACE.mapperAnchor)).toEqual([]);
    });

    it("mappedFields runs to end-of-source when the literal is unterminated", () => {
      expect(mappedFields("return {\n    a: row.a,\n    screenshotTablePresenceSatisfied: parseJson<", SURFACE.mapperAnchor)).toEqual(["a", "screenshotTablePresenceSatisfied"]);
    });

    it("tableColumns reads one table's columns, and returns nothing for an unknown table", () => {
      expect(tableColumns(SCHEMA, "pullRequests")).toEqual(["headSha", "visualCaptureSatisfiedSha", "visualCaptureUnobtainableSha"]);
      expect(tableColumns(SCHEMA, "recentMergedPullRequests")).toEqual(["changedFilesJson"]);
      expect(tableColumns(SCHEMA, "noSuchTable")).toEqual([]);
    });

    it("tableColumns runs to end-of-source when the table body is unterminated", () => {
      expect(tableColumns('export const t = sqliteTable(\n  "t",\n  {\n    a: text("a"),', "t")).toEqual(["a"]);
    });

    it("fieldsReadOffRecord picks up optional-chained reads and ignores other bindings", () => {
      const read = fieldsReadOffRecord(["const a = pr?.headSha; const b = other.notARecordField;"], ["pr"]);
      expect([...read]).toEqual(["headSha"]);
    });
  });
});
