import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ANALYZER_DESCRIPTORS, ANALYZER_NAMES } from "../dist/analyzers/registry.js";
import { reesProfileMetadata } from "../dist/scheduler.js";

test("generated analyzer metadata matches the runtime registry and profiles", () => {
  const metadata = JSON.parse(readFileSync("analyzer-metadata.json", "utf8")) as {
    schemaVersion: number;
    defaultProfile: string;
    profiles: Array<{ name: string; default: boolean; costClasses: string[] }>;
    analyzers: Array<{
      name: string;
      title: string;
      category: string;
      cost: string;
      defaultEnabled: boolean;
      profiles: string[];
      requires: string[];
      limits: Record<string, number>;
      docs: Record<string, string>;
    }>;
  };

  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.defaultProfile, "balanced");
  assert.deepEqual(
    metadata.profiles.map((profile) => profile.name),
    reesProfileMetadata().map((profile) => profile.name),
  );
  assert.deepEqual(
    metadata.analyzers.map((analyzer) => analyzer.name),
    ANALYZER_NAMES,
  );

  for (const descriptor of ANALYZER_DESCRIPTORS) {
    const generated = metadata.analyzers.find((analyzer) => analyzer.name === descriptor.name);
    assert.ok(generated, `missing generated metadata for ${descriptor.name}`);
    assert.equal(generated.title, descriptor.title);
    assert.equal(generated.category, descriptor.category);
    assert.equal(generated.cost, descriptor.cost);
    assert.equal(generated.defaultEnabled, descriptor.defaultEnabled);
    assert.deepEqual(generated.requires, descriptor.requires);
    assert.deepEqual(generated.limits, descriptor.limits ?? {});
    assert.equal(generated.docs.summary, descriptor.docs.summary);
    assert.ok(generated.profiles.includes("balanced"));
  }
});
