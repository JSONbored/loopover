import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAttestationReportData, validateAttestationEnvelope } from "../dist/index.js";

const BASE = {
  schemaVersion: 1,
  teeTechnology: "sev-snp",
  runtimeClass: "loopover-backtest-runner",
  measurement: "a".repeat(64),
  reportData: "b".repeat(64),
  attestationReport: "QUJD",
  verification: { status: "unverified" },
};

test("barrel: the public entrypoint re-exports the attestation-envelope primitives (#8541)", () => {
  assert.equal(typeof buildAttestationReportData, "function");
  assert.equal(typeof validateAttestationEnvelope, "function");
});

test("buildAttestationReportData pins the corpusChecksum:headSha:baseSha binding (#8541)", () => {
  assert.equal(
    buildAttestationReportData({ corpusChecksum: "abc123", headSha: "head456", baseSha: "base789" }),
    "fcc875115df49bf143b18fc8a8071e9a946858407fabf61e59ef1607d1cfb140",
  );
});

test("validateAttestationEnvelope accepts a well-formed envelope and each verification variant (#8541)", () => {
  assert.equal(validateAttestationEnvelope(BASE).valid, true);
  assert.equal(
    validateAttestationEnvelope({ ...BASE, verification: { status: "verified", verifierId: "v1", verifiedAt: "2026-07-25T00:00:00.000Z" } }).valid,
    true,
  );
  assert.equal(
    validateAttestationEnvelope({
      ...BASE,
      verification: { status: "failed", verifierId: "v1", verifiedAt: "2026-07-25T00:00:00.000Z", reason: "signature mismatch" },
    }).valid,
    true,
  );
});

test("validateAttestationEnvelope rejects structurally invalid input without throwing (#8541)", () => {
  for (const bad of [null, undefined, 42, "envelope", [], { ...BASE, schemaVersion: 2 }, { ...BASE, reportData: "b".repeat(63) }, { ...BASE, rogue: 1 }]) {
    const result = validateAttestationEnvelope(bad);
    assert.equal(result.valid, false);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
  }
});
