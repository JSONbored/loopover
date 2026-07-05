import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseMinerGoalSpecContent } from "../../packages/gittensory-engine/src/miner-goal-spec";

const repoRoot = process.cwd();
const schemaPath = join(repoRoot, "packages/gittensory-miner/schema/miner-goal-spec.schema.json");
const docPath = join(repoRoot, "packages/gittensory-miner/docs/miner-goal-spec.md");
const examplePath = join(repoRoot, ".gittensory-miner.yml.example");

const SPEC_FIELDS = [
  "minerEnabled",
  "wantedPaths",
  "blockedPaths",
  "preferredLabels",
  "blockedLabels",
  "maxConcurrentClaims",
  "issueDiscoveryPolicy",
] as const;

describe("miner goal spec docs (#2300)", () => {
  it("documents every MinerGoalSpec field and the relationship to .gittensory.yml", () => {
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toContain("Relationship to `.gittensory.yml`");
    expect(doc).toContain("wantedPaths");
    expect(doc).toContain("blockedPaths");
    for (const field of SPEC_FIELDS) {
      expect(doc).toContain(field);
    }
  });

  it("ships a JSON Schema draft 2020-12 with the MinerGoalSpec properties", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
      $schema: string;
      properties: Record<string, unknown>;
    };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    for (const field of SPEC_FIELDS) {
      expect(schema.properties).toHaveProperty(field);
    }
  });

  it("parses the root example file through the engine parser", () => {
    const example = readFileSync(examplePath, "utf8");
    const parsed = parseMinerGoalSpecContent(example);
    expect(parsed.present).toBe(true);
    expect(parsed.spec).toMatchObject({
      minerEnabled: true,
      wantedPaths: ["src/**"],
      blockedPaths: ["vendor/**", ".github/workflows/**"],
      preferredLabels: ["bug", "enhancement"],
      blockedLabels: ["wontfix", "duplicate"],
      maxConcurrentClaims: 1,
      issueDiscoveryPolicy: "neutral",
    });
    expect(parsed.warnings).toEqual([]);
  });
});
