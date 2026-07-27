import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SAMPLE_ATTESTATION_MAGIC,
  assembleAttestationEnvelope,
  buildAttestationReportData,
  createSampleAttester,
  isSampleAttestationReport,
  validateAttestationEnvelope,
} from "../dist/index.js";

const BINDING = {
  corpusChecksum: "a1".repeat(32), // 64 hex
  headSha: "b2".repeat(20), // 40 hex
  baseSha: "c3".repeat(20), // 40 hex
  runId: "d4".repeat(16), // 32 hex
};
const RUNTIME_CLASS = "loopover-backtest-runner";

test("barrel: the public entrypoint re-exports the attester seam (#9211)", () => {
  assert.equal(typeof createSampleAttester, "function");
  assert.equal(typeof assembleAttestationEnvelope, "function");
  assert.equal(typeof isSampleAttestationReport, "function");
  assert.equal(typeof SAMPLE_ATTESTATION_MAGIC, "string");
});

test("the sample attester assembles an envelope the shipped validator accepts", async () => {
  const result = await assembleAttestationEnvelope(createSampleAttester(), BINDING, RUNTIME_CLASS);
  assert.ok(result.ok);
  assert.equal(validateAttestationEnvelope(result.envelope).valid, true);
  // The commitment is recomputed from the binding, never restated by the attester.
  assert.equal(result.envelope.reportData, buildAttestationReportData(BINDING));
  assert.deepEqual(result.envelope.verification, { status: "unverified" });
});

test("a sample-attested report stays identifiable as a dev artifact, not evidence", async () => {
  const result = await assembleAttestationEnvelope(createSampleAttester(), BINDING, RUNTIME_CLASS);
  assert.ok(result.ok);
  assert.equal(isSampleAttestationReport(result.envelope.attestationReport), true);
});
