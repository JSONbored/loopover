import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diffFieldSets, extractRepoSettingsPreviewFieldNames, extractRepositorySettingsFieldNames, SETTINGS_PREVIEW_PATH, TYPES_PATH } from "../../scripts/check-openapi-settings-parity.js";
import { RepoSettingsPreviewSchema, RepositorySettingsSchema } from "../../src/openapi/schemas";

// #2556: RepositorySettingsSchema (hand-authored Zod) can silently drift from the RepositorySettings TS
// type -- this is the structural-diff guard closing that gap. ui:openapi:check only verified the generated
// spec matched the Zod schema, never that the schema matched the type the API actually serializes.
describe("OpenAPI settings-parity check (#2556)", () => {
  it("extracts every top-level field name from a RepositorySettings-shaped type block", () => {
    const source = [
      "export type RepositorySettings = {",
      "  repoFullName: string;",
      "  /** a doc comment with a trailing colon: like this */",
      "  qualityGateMinScore?: number | null | undefined;",
      "  aiReviewProvider?: \"anthropic\" | \"openai\" | null | undefined;",
      "};",
      "",
      "export type SomethingElse = { notAField: string };",
    ].join("\n");
    const fields = extractRepositorySettingsFieldNames(source);
    expect(fields).toEqual(new Set(["repoFullName", "qualityGateMinScore", "aiReviewProvider"]));
  });

  it("throws when the type start marker is missing", () => {
    expect(() => extractRepositorySettingsFieldNames("export type Unrelated = { a: string };")).toThrow(/Could not find/);
  });

  it("throws when the closing brace is missing", () => {
    expect(() => extractRepositorySettingsFieldNames("export type RepositorySettings = {\n  repoFullName: string;")).toThrow(/closing/);
  });

  it("diffFieldSets reports fields missing from the schema and fields extra in the schema", () => {
    const typeFields = new Set(["a", "b", "c"]);
    const schemaFields = new Set(["a", "c", "d"]);
    expect(diffFieldSets(typeFields, schemaFields)).toEqual({
      missingFromSchema: ["b"],
      extraInSchema: ["d"],
    });
  });

  it("diffFieldSets reports no differences for identical sets", () => {
    const fields = new Set(["a", "b"]);
    expect(diffFieldSets(fields, fields)).toEqual({ missingFromSchema: [], extraInSchema: [] });
  });

  it("the real RepositorySettings type and RepositorySettingsSchema are in parity (regression guard)", () => {
    const typeFields = extractRepositorySettingsFieldNames(readFileSync(TYPES_PATH, "utf8"));
    const schemaFields = new Set(Object.keys(RepositorySettingsSchema.shape));
    expect(diffFieldSets(typeFields, schemaFields)).toEqual({ missingFromSchema: [], extraInSchema: [] });
  });
  it("rejects contributor open caps above the enforcement sample budget", () => {
    expect(() => RepositorySettingsSchema.partial().parse({ contributorOpenPrCap: 101 })).toThrow();
    expect(() => RepositorySettingsSchema.partial().parse({ contributorOpenIssueCap: 101 })).toThrow();
    expect(RepositorySettingsSchema.partial().parse({ contributorOpenPrCap: 100, contributorOpenIssueCap: 100 })).toMatchObject({ contributorOpenPrCap: 100, contributorOpenIssueCap: 100 });
  });
});

// #7011: the header comment names RepoSettingsPreviewSchema too, but main() only guarded RepositorySettings.
// This block covers the added second check -- RepoSettingsPreviewSchema.settings against buildRepoSettingsPreview's
// return shape (the RepoSettingsPreview.settings type), mirroring the RepositorySettings coverage above.
describe("OpenAPI settings-preview parity check (#7011)", () => {
  it("extracts only the direct field names of the nested settings block, skipping nested and sibling fields", () => {
    const source = [
      "export type RepoSettingsPreview = {",
      "  repoFullName: string;",
      "  settings: {",
      "    publicSurface: RepositorySettings[\"publicSurface\"];",
      "    qualityGateMinScore?: number | null | undefined;",
      "    commandAuthorization: {",
      "      defaultAllowed: CommandAuthorizationRole[];",
      "      commandOverrides: Array<{ command: string; allowedRoles: CommandAuthorizationRole[] }>;",
      "    };",
      "  };",
      "  commandAuthorizationPreview: {",
      "    commandName: string;",
      "  };",
      "};",
    ].join("\n");
    const fields = extractRepoSettingsPreviewFieldNames(source);
    expect(fields).toEqual(new Set(["publicSurface", "qualityGateMinScore", "commandAuthorization"]));
  });

  it("throws when the RepoSettingsPreview type start marker is missing", () => {
    expect(() => extractRepoSettingsPreviewFieldNames("export type Unrelated = { settings: { a: string } };")).toThrow(/Could not find/);
  });

  it("throws when the settings block is missing from the type", () => {
    expect(() => extractRepoSettingsPreviewFieldNames("export type RepoSettingsPreview = {\n  repoFullName: string;\n};")).toThrow(/settings/);
  });

  it("throws when the settings block is never closed", () => {
    expect(() => extractRepoSettingsPreviewFieldNames("export type RepoSettingsPreview = {\n  settings: {\n    publicSurface: string;")).toThrow(/closing/);
  });

  it("the real RepoSettingsPreview type and RepoSettingsPreviewSchema.settings are in parity (regression guard)", () => {
    const previewFields = extractRepoSettingsPreviewFieldNames(readFileSync(SETTINGS_PREVIEW_PATH, "utf8"));
    const schemaFields = new Set(Object.keys(RepoSettingsPreviewSchema.shape.settings.shape));
    expect(diffFieldSets(previewFields, schemaFields)).toEqual({ missingFromSchema: [], extraInSchema: [] });
  });
});
