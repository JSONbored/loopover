// Tests for AmsPolicySpec file discovery (#8863). The tolerant parser itself is covered by
// ams-policy-spec-parser.test.ts; this covers only the discovery order. Pure —
// the existence check is injected, so no filesystem is touched. Runs against compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverAmsPolicySpecPath, AMS_POLICY_SPEC_FILENAMES } from "../dist/index.js";

test("AMS_POLICY_SPEC_FILENAMES lists the documented discovery order", () => {
  assert.deepEqual([...AMS_POLICY_SPEC_FILENAMES], [
    ".loopover-ams.yml",
    ".github/loopover-ams.yml",
    ".loopover-ams.json",
    ".github/loopover-ams.json",
  ]);
});

test("discoverAmsPolicySpecPath: returns the first existing candidate, first match wins", () => {
  assert.equal(discoverAmsPolicySpecPath(() => true), ".loopover-ams.yml");
  // repo-root yml missing but the .github yml present → that one is chosen
  assert.equal(
    discoverAmsPolicySpecPath((p) => p !== ".loopover-ams.yml"),
    ".github/loopover-ams.yml",
  );
  // only a JSON variant present
  assert.equal(discoverAmsPolicySpecPath((p) => p === ".loopover-ams.json"), ".loopover-ams.json");
});

test("discoverAmsPolicySpecPath: short-circuits — stops probing once a candidate matches", () => {
  const probed: string[] = [];
  const result = discoverAmsPolicySpecPath((p) => {
    probed.push(p);
    return p === ".github/loopover-ams.yml"; // the 2nd candidate matches
  });
  assert.equal(result, ".github/loopover-ams.yml");
  // only the first two candidates are probed; the later .json variants are never reached
  assert.deepEqual(probed, [".loopover-ams.yml", ".github/loopover-ams.yml"]);
});

test("discoverAmsPolicySpecPath: returns null when no candidate exists, and never probes unlisted paths", () => {
  const probed: string[] = [];
  const result = discoverAmsPolicySpecPath((p) => {
    probed.push(p);
    return false;
  });
  assert.equal(result, null);
  assert.deepEqual(probed, [...AMS_POLICY_SPEC_FILENAMES]); // exactly the listed candidates, in order
});
