import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFocusManifestValidation } from "../../src/services/focus-manifest-validation";
import { MAX_FOCUS_MANIFEST_BYTES } from "../../src/signals/focus-manifest";

const exampleManifest = readFileSync(join(process.cwd(), "config/examples/global.gittensory.yml"), "utf8");

describe("buildFocusManifestValidation (#2057)", () => {
  it("returns ok for a valid manifest with recognized fields", () => {
    const result = buildFocusManifestValidation({ content: "wantedPaths:\n  - src/\n" });
    expect(result.status).toBe("ok");
    expect(result.present).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.normalized).toMatchObject({ present: true, wantedPaths: ["src/"] });
    expect(JSON.stringify(result)).not.toMatch(/wallet|hotkey|reward estimate/i);
  });

  it("returns warn for a manifest with parser warnings but parseable content", () => {
    const result = buildFocusManifestValidation({ content: "gate:\n  pack: not-real\n  enabled: true\n" });
    expect(result.status).toBe("warn");
    expect(result.warnings.join(" ")).toMatch(/gate\.pack/i);
    expect(result.normalized.gate).toMatchObject({ enabled: true });
  });

  it("returns error for malformed YAML", () => {
    const result = buildFocusManifestValidation({ content: "wantedPaths: [\n" });
    expect(result.status).toBe("error");
    expect(result.present).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/not valid YAML/i);
  });

  it("returns error for malformed JSON", () => {
    const result = buildFocusManifestValidation({ content: "{ not: valid json" });
    expect(result.status).toBe("error");
    expect(result.warnings.join(" ")).toMatch(/not valid JSON/i);
  });

  it("returns warn for an empty manifest with no recognized fields", () => {
    const result = buildFocusManifestValidation({ content: "  \n" });
    expect(result.status).toBe("warn");
    expect(result.present).toBe(false);
    expect(result.normalized).toMatchObject({ present: false });
  });

  it("returns error when content exceeds the manifest byte cap", () => {
    const oversized = "x".repeat(MAX_FOCUS_MANIFEST_BYTES + 1);
    const result = buildFocusManifestValidation({ content: oversized });
    expect(result.status).toBe("error");
    expect(result.warnings.join(" ")).toMatch(/exceeded/i);
  });

  it("omits private maintainerNotes from normalized output", () => {
    const result = buildFocusManifestValidation({
      content: "maintainerNotes:\n  - secret maintainer-only context\npublicNotes:\n  - keep reviews focused\n",
    });
    expect(result.normalized).not.toHaveProperty("maintainerNotes");
    expect(result.normalized.publicNotes).toEqual(["keep reviews focused"]);
    expect(JSON.stringify(result)).not.toContain("secret maintainer-only context");
  });

  it("normalizes a real example manifest without echoing private maintainer notes", () => {
    const result = buildFocusManifestValidation({ content: exampleManifest });
    expect(result.status).toBe("ok");
    expect(result.present).toBe(true);
    expect(result.normalized.gate).toMatchObject({ enabled: true });
    expect(result.normalized).not.toHaveProperty("maintainerNotes");
  });

  it("keeps clean text byte-identical through normalization for a simple manifest", () => {
    const content = "linkedIssuePolicy: required\ntestExpectations:\n  - npm test\n";
    const result = buildFocusManifestValidation({ content });
    expect(result.status).toBe("ok");
    expect(result.normalized).toMatchObject({
      linkedIssuePolicy: "required",
      testExpectations: ["npm test"],
    });
  });

  it("normalizes every optional manifest section and honors a custom source", () => {
    const result = buildFocusManifestValidation({
      source: "api_record",
      content: `
preferredLabels: [help wanted]
issueDiscoveryPolicy: encouraged
settings:
  commentMode: all_prs
review:
  profile: chill
features:
  rag: true
contentLane:
  entryFileGlob: data/*.json
  collectionField: records
repoDocGeneration:
  enabled: true
  scope: [agents]
reviewRecap:
  enabled: true
  cadenceDays: 14
maintainerRecap:
  enabled: true
  cadence: daily
  channel: discord
`,
    });
    expect(result.status).toBe("ok");
    expect(result.normalized).toMatchObject({
      source: "api_record",
      preferredLabels: ["help wanted"],
      issueDiscoveryPolicy: "encouraged",
      settings: { commentMode: "all_prs" },
      review: { profile: "chill" },
      features: { rag: true },
      contentLane: { entryFileGlob: "data/*.json", collectionField: "records" },
      repoDocGeneration: { enabled: true, scope: ["agents"] },
      reviewRecap: { enabled: true, cadenceDays: 14 },
      maintainerRecap: { enabled: true, cadence: "daily", channel: "discord" },
    });
  });

  it("omits maintainerRecap from the normalized output when it is not configured", () => {
    const result = buildFocusManifestValidation({ content: "wantedPaths: [src/]\n" });
    expect(result.normalized).not.toHaveProperty("maintainerRecap");
  });

  it("returns error when manifest content is not a mapping", () => {
    const result = buildFocusManifestValidation({ content: "[1, 2, 3]" });
    expect(result.status).toBe("error");
    expect(result.warnings.join(" ")).toMatch(/must be a mapping/i);
  });
});
