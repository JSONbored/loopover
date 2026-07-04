import { describe, expect, it } from "vitest";
import { lintManifestText } from "../../src/selfhost/config-lint";
import { MAX_FOCUS_MANIFEST_BYTES } from "../../src/signals/focus-manifest";

describe("lintManifestText (#2079)", () => {
  it("passes a valid manifest with one recognized field", () => {
    expect(lintManifestText("wantedPaths:\n  - src/\n")).toEqual({
      ok: true,
      warnings: [],
      recognizedFields: ["wantedPaths"],
      summary: "Manifest parsed 1 recognized field.",
    });
  });

  it("reports every recognized focus field without echoing values", () => {
    const result = lintManifestText(`
wantedPaths: [src/private-policy/]
preferredLabels: [operator-only]
linkedIssuePolicy: required
testExpectations: [unit coverage]
issueDiscoveryPolicy: discouraged
maintainerNotes: [private maintainer note]
publicNotes: [keep reviews focused]
gate:
  enabled: false
settings:
  commentMode: all_prs
review:
  profile: chill
features:
  rag: true
contentLane:
  entryFileGlob: data/*.json
  collectionField: records
`);

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.summary).toBe("Manifest parsed 12 recognized fields.");
    expect(result.recognizedFields).toEqual([
      "wantedPaths",
      "preferredLabels",
      "linkedIssuePolicy",
      "testExpectations",
      "issueDiscoveryPolicy",
      "maintainerNotes",
      "publicNotes",
      "gate",
      "settings",
      "review",
      "features",
      "contentLane",
    ]);
    expect(JSON.stringify(result)).not.toContain("private maintainer note");
    expect(JSON.stringify(result)).not.toContain("operator-only");
  });

  it("flags legacy blockedPaths with a migration-specific warning, not the generic unknown-field message", () => {
    const result = lintManifestText("wantedPaths: [src/]\nblockedPaths: [dist/]\n");

    expect(result.ok).toBe(false);
    expect(result.recognizedFields).toEqual(["wantedPaths"]);
    expect(result.warnings).toEqual(["blockedPaths is retired; use settings.hardGuardrailGlobs for path holds."]);
  });

  it("flags legacy blockedPaths AND an unrelated unknown field with separate, distinct warnings", () => {
    const result = lintManifestText("wantedPaths: [src/]\nblockedPaths: [dist/]\nunknownSecretKey: [x]\n");

    expect(result.warnings).toEqual([
      "blockedPaths is retired; use settings.hardGuardrailGlobs for path holds.",
      "Manifest contains unknown top-level field: unknownSecretKey.",
    ]);
  });

  it("flags empty or fieldless manifests as not ok", () => {
    expect(lintManifestText(undefined)).toEqual({
      ok: false,
      warnings: ["Manifest did not define any recognized focus fields."],
      recognizedFields: [],
      summary: "Manifest has 1 warning.",
    });

    const fieldless = lintManifestText("{}");
    expect(fieldless.ok).toBe(false);
    expect(fieldless.recognizedFields).toEqual([]);
    expect(fieldless.warnings).toEqual(["Manifest contained no recognized focus fields; falling back to deterministic signals."]);

    const scalar = lintManifestText("null");
    expect(scalar.ok).toBe(false);
    expect(scalar.recognizedFields).toEqual([]);
    expect(scalar.warnings).toEqual([
      "Manifest must be a mapping of fields; ignoring malformed manifest and falling back to deterministic signals.",
    ]);
  });

  it("reports explicit default-valued policy fields as recognized", () => {
    expect(lintManifestText("linkedIssuePolicy: optional\n")).toEqual({
      ok: true,
      warnings: [],
      recognizedFields: ["linkedIssuePolicy"],
      summary: "Manifest parsed 1 recognized field.",
    });

    expect(lintManifestText("issueDiscoveryPolicy: neutral\n")).toEqual({
      ok: true,
      warnings: [],
      recognizedFields: ["issueDiscoveryPolicy"],
      summary: "Manifest parsed 1 recognized field.",
    });
  });

  it("accepts source metadata without reporting it as a focus field", () => {
    expect(lintManifestText("source: repo_file\n")).toEqual({
      ok: false,
      warnings: ["Manifest contained no recognized focus fields; falling back to deterministic signals."],
      recognizedFields: [],
      summary: "Manifest has 1 warning.",
    });
  });

  it("surfaces malformed YAML without adding synthetic unknown-key warnings", () => {
    const result = lintManifestText("wantedPaths: [unterminated");

    expect(result.ok).toBe(false);
    expect(result.recognizedFields).toEqual([]);
    expect(result.warnings).toEqual(["Manifest content was not valid YAML; ignoring it and falling back to deterministic signals."]);
    expect(result.summary).toBe("Manifest has 1 warning.");
  });

  it("warns on unknown top-level fields by name only", () => {
    const result = lintManifestText(`
unknownSecretKey: super-secret-value
"": blank-field-name
"private path": /tmp/private
`);

    expect(result.ok).toBe(false);
    expect(result.recognizedFields).toEqual([]);
    expect(result.summary).toBe("Manifest has 2 warnings.");
    expect(result.warnings).toEqual([
      "Manifest contained no recognized focus fields; falling back to deterministic signals.",
      "Manifest contains unknown top-level fields: unknownSecretKey, <blank>, private_path.",
    ]);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    expect(JSON.stringify(result)).not.toContain("/tmp/private");
  });

  it("uses singular wording for one unknown top-level field", () => {
    const result = lintManifestText("wantedPaths: [src/]\nunknownSecretKey: super-secret-value\n");

    expect(result.ok).toBe(false);
    expect(result.recognizedFields).toEqual(["wantedPaths"]);
    expect(result.warnings).toEqual(["Manifest contains unknown top-level field: unknownSecretKey."]);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("checks unknown fields in YAML flow mappings that start like JSON", () => {
    const result = lintManifestText("{wantedPaths: [src/], unknownSecretKey: secret}");

    expect(result.ok).toBe(false);
    expect(result.recognizedFields).toEqual([]);
    expect(result.warnings).toEqual([
      "Manifest content was not valid JSON; ignoring it and falling back to deterministic signals.",
      "Manifest contains unknown top-level field: unknownSecretKey.",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("keeps known JSON manifests quiet and non-object JSON invalid", () => {
    expect(lintManifestText(JSON.stringify({ gate: { enabled: true } }))).toMatchObject({
      ok: true,
      warnings: [],
      recognizedFields: ["gate"],
    });

    const array = lintManifestText("[]");
    expect(array.ok).toBe(false);
    expect(array.warnings).toEqual(["Manifest must be a mapping of fields; ignoring malformed manifest and falling back to deterministic signals."]);
  });

  it("redacts supplied config values from parser warnings", () => {
    const result = lintManifestText(`
linkedIssuePolicy: sometimes
gate:
  enabled: true
  aiReview:
    provider: secret-provider
review:
  profile: secret-profile
`);

    expect(result.ok).toBe(false);
    expect(result.recognizedFields).toEqual(["linkedIssuePolicy", "gate", "review"]);
    expect(result.warnings.join("\n")).toContain("falling back to the default");
    expect(result.warnings.join("\n")).toContain("ignoring the supplied value");
    expect(JSON.stringify(result)).not.toContain("sometimes");
    expect(JSON.stringify(result)).not.toContain("secret-provider");
    expect(JSON.stringify(result)).not.toContain("secret-profile");
  });

  it("degrades oversize content without reparsing keys", () => {
    const asciiOversize = lintManifestText("a".repeat(MAX_FOCUS_MANIFEST_BYTES + 1));
    expect(asciiOversize.ok).toBe(false);
    expect(asciiOversize.warnings).toEqual([
      `Manifest content exceeded ${MAX_FOCUS_MANIFEST_BYTES} bytes; ignoring it and falling back to deterministic signals.`,
    ]);

    const utf8Oversize = lintManifestText("é".repeat(Math.floor(MAX_FOCUS_MANIFEST_BYTES / 2) + 1));
    expect(utf8Oversize.ok).toBe(false);
    expect(utf8Oversize.warnings).toEqual([
      `Manifest content exceeded ${MAX_FOCUS_MANIFEST_BYTES} bytes; ignoring it and falling back to deterministic signals.`,
    ]);
  });

  it("does not reparse padded oversize content after trimming (regression)", () => {
    const result = lintManifestText(
      `${" ".repeat(MAX_FOCUS_MANIFEST_BYTES + 1)}unknownSecretKey: super-secret-value\n`,
    );

    expect(result.ok).toBe(false);
    expect(result.recognizedFields).toEqual([]);
    expect(result.warnings).toEqual([
      `Manifest content exceeded ${MAX_FOCUS_MANIFEST_BYTES} bytes; ignoring it and falling back to deterministic signals.`,
    ]);
    expect(JSON.stringify(result)).not.toContain("unknownSecretKey");
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });
});
