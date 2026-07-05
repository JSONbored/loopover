// Units for the EOL-check analyzer's Dockerfile FROM version-pin extraction. Own file (not
// enrichment.test.ts) so concurrent analyzer PRs don't collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVersionPins } from "../dist/analyzers/eol-check.js";

const dockerfile = (from: string) => ({
  path: "Dockerfile",
  patch: `@@ -1,1 +1,2 @@\n FROM builder AS base\n+${from}`,
});

test("extractVersionPins: maps database/cache base images to their endoflife.date slugs", () => {
  // The official image name differs from the endoflife.date slug for postgres (postgresql)
  // and mongo (mongodb), so these are genuine mappings, not just new keys.
  const cases: Array<[string, string, string]> = [
    ["FROM postgres:14", "postgresql", "14"],
    ["FROM mysql:8.0", "mysql", "8.0"],
    ["FROM mariadb:11", "mariadb", "11"],
    ["FROM redis:7", "redis", "7"],
    ["FROM mongo:5", "mongodb", "5"],
  ];
  for (const [from, product, version] of cases) {
    const pins = extractVersionPins([dockerfile(from)]);
    const pin = pins.find((p) => p.product === product);
    assert.ok(pin, `expected a ${product} pin from "${from}"`);
    assert.equal(pin!.version, version);
  }
});

test("extractVersionPins: still ignores an unknown base image", () => {
  assert.deepEqual(extractVersionPins([dockerfile("FROM totallyunknownimage:1.2")]), []);
});
