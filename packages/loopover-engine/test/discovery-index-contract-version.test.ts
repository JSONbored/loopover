import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DISCOVERY_INDEX_CONTRACT_VERSION,
  normalizeDiscoveryIndexRequest,
  normalizeDiscoveryIndexResponse,
} from "../dist/index.js";

// #9615: a declared contract-version skew is surfaced through the tolerant parser's existing warnings
// channel on both wire directions, instead of being silently relabelled as this build's version.

test("normalizeDiscoveryIndexRequest surfaces a declared contract-version skew as a warning (#9615)", () => {
  const parsed = normalizeDiscoveryIndexRequest({ contractVersion: 99, repos: ["a/b"] });
  assert.ok(
    parsed.warnings.includes(
      `DiscoveryIndexRequest declared contractVersion 99; this build speaks ${DISCOVERY_INDEX_CONTRACT_VERSION}.`,
    ),
  );
  assert.equal(parsed.request.contractVersion, DISCOVERY_INDEX_CONTRACT_VERSION);
  assert.deepEqual(parsed.request.query.repos, ["a/b"]);
});

test("normalizeDiscoveryIndexResponse surfaces a declared contract-version skew as a warning (#9615)", () => {
  const parsed = normalizeDiscoveryIndexResponse({ contractVersion: 99, candidates: [] });
  assert.ok(
    parsed.warnings.includes(
      `DiscoveryIndexResponse declared contractVersion 99; this build speaks ${DISCOVERY_INDEX_CONTRACT_VERSION}.`,
    ),
  );
  assert.equal(parsed.response.contractVersion, DISCOVERY_INDEX_CONTRACT_VERSION);
});

test("version warnings stay silent for absent, non-number, and matching declarations (#9615)", () => {
  assert.deepEqual(normalizeDiscoveryIndexRequest({ repos: ["a/b"] }).warnings, []);
  assert.deepEqual(normalizeDiscoveryIndexRequest({ contractVersion: "1", repos: ["a/b"] }).warnings, []);
  assert.deepEqual(normalizeDiscoveryIndexRequest({ contractVersion: 1, repos: ["a/b"] }).warnings, []);
  assert.deepEqual(normalizeDiscoveryIndexResponse({ candidates: [] }).warnings, []);
  assert.deepEqual(normalizeDiscoveryIndexResponse({ contractVersion: "1", candidates: [] }).warnings, []);
  const matching = normalizeDiscoveryIndexResponse({
    contractVersion: 1,
    candidates: [{ repoFullName: "owner/repo", issueNumber: 1, title: "x" }],
  });
  assert.deepEqual(matching.warnings, []);
  assert.equal(matching.response.candidates[0]?.repoFullName, "owner/repo");
  // A non-mapping response takes the optional-chain's undefined arm and stays version-silent too.
  assert.deepEqual(normalizeDiscoveryIndexResponse(null).warnings, [
    "DiscoveryIndexResponse must be a mapping; falling back to an empty candidate list.",
  ]);
});
