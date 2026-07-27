import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAttestationReportData, validateAttestationEnvelope } from "../dist/index.js";

const BASE = {
  schemaVersion: 1,
  teeTechnology: "sev-snp",
  runtimeClass: "loopover-backtest-runner",
  measurement: "a".repeat(64),
  reportData: "b".repeat(128),
  runId: "d4".repeat(16),
  attestationReport: "QUJD",
  verification: { status: "unverified" },
};

// #9140 worked example, asserted verbatim (also published in buildAttestationReportData's own doc comment as
// the spec a non-JS verifier reimplements against).
const CORPUS_CHECKSUM = "a1".repeat(32); // 64 hex
const HEAD_SHA = "b2".repeat(20); // 40 hex
const BASE_SHA = "c3".repeat(20); // 40 hex
const RUN_ID = "d4".repeat(16); // 32 hex
const EXPECTED_REPORT_DATA =
  "3309f8c4eadab7422c8b5ba378a12d52b5676f601faa4dcbac213bae93f5ae7e" +
  "1d88ffa7d3cf1f07e5cf64b62016f3e688ad473286f2f613886b6ac02d00541d";

test("barrel: the public entrypoint re-exports the attestation-envelope primitives (#8541)", () => {
  assert.equal(typeof buildAttestationReportData, "function");
  assert.equal(typeof validateAttestationEnvelope, "function");
});

test("buildAttestationReportData: the published test vector (#9140) — sha256(binding) || sha256(runId), 128 hex chars", () => {
  const reportData = buildAttestationReportData({ corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID });
  assert.equal(reportData, EXPECTED_REPORT_DATA);
  assert.equal(reportData.length, 128);
});

test("buildAttestationReportData: injective over the (corpusChecksum, headSha, baseSha, runId) quadruple", () => {
  const base = { corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID };
  const variants = [
    base,
    { ...base, corpusChecksum: "a2".repeat(32) },
    { ...base, headSha: "b3".repeat(20) },
    { ...base, baseSha: "c4".repeat(20) },
    { ...base, runId: "d5".repeat(16) },
    // A different git-sha WIDTH (64-hex SHA-256 git object ids) must still be a distinct commitment.
    { ...base, headSha: "b2".repeat(32) },
  ];
  const digests = variants.map((binding) => buildAttestationReportData(binding));
  assert.equal(new Set(digests).size, digests.length, "every varied input must produce a distinct reportData");
});

test("buildAttestationReportData: the freshness half is independently addressable — only runId moves the second 64 hex chars", () => {
  const base = { corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID };
  const baseReportData = buildAttestationReportData(base);
  const freshRun = buildAttestationReportData({ ...base, runId: "d5".repeat(16) });
  assert.equal(freshRun.slice(0, 64), baseReportData.slice(0, 64), "the binding half is unaffected by a run-id change");
  assert.notEqual(freshRun.slice(64), baseReportData.slice(64), "the freshness half MUST change so a stale report cannot be replayed for a new run");

  const rebound = buildAttestationReportData({ ...base, corpusChecksum: "a2".repeat(32) });
  assert.notEqual(rebound.slice(0, 64), baseReportData.slice(0, 64), "the binding half moves when the corpus/shas change");
  assert.equal(rebound.slice(64), baseReportData.slice(64), "the freshness half is unaffected by a binding-only change");
});

test("buildAttestationReportData: throws (never silently mis-commits) on a malformed input shape", () => {
  const base = { corpusChecksum: CORPUS_CHECKSUM, headSha: HEAD_SHA, baseSha: BASE_SHA, runId: RUN_ID };
  assert.throws(() => buildAttestationReportData({ ...base, corpusChecksum: "abc123" }), /corpusChecksum/);
  assert.throws(() => buildAttestationReportData({ ...base, corpusChecksum: `${CORPUS_CHECKSUM.slice(0, 63)}:` }), /corpusChecksum/);
  assert.throws(() => buildAttestationReportData({ ...base, headSha: "not-hex-and-wrong-length" }), /headSha/);
  assert.throws(() => buildAttestationReportData({ ...base, baseSha: "" }), /baseSha/);
  assert.throws(() => buildAttestationReportData({ ...base, runId: "UPPER" }), /runId/);
  assert.throws(() => buildAttestationReportData({ ...base, runId: "" }), /runId/);
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
  for (const bad of [
    null,
    undefined,
    42,
    "envelope",
    [],
    { ...BASE, schemaVersion: 2 },
    { ...BASE, reportData: "b".repeat(63) }, // #9140: pre-fix width (32 bytes) is now rejected
    { ...BASE, reportData: "b".repeat(127) },
    { ...BASE, rogue: 1 },
  ]) {
    const result = validateAttestationEnvelope(bad);
    assert.equal(result.valid, false);
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
  }
});

// #9140: the freshness envelope field — must be present, hex-shaped, and bounded like `measurement`.
test("validateAttestationEnvelope: runId is required, hex, and bounded 1-128 chars", () => {
  assert.equal(validateAttestationEnvelope({ ...BASE, runId: undefined }).valid, false);
  const missing = { schemaVersion: BASE.schemaVersion, teeTechnology: BASE.teeTechnology, runtimeClass: BASE.runtimeClass, measurement: BASE.measurement, reportData: BASE.reportData, attestationReport: BASE.attestationReport, verification: BASE.verification };
  assert.equal(validateAttestationEnvelope(missing).valid, false);
  assert.equal(validateAttestationEnvelope({ ...BASE, runId: "NOTHEX" }).valid, false);
  assert.equal(validateAttestationEnvelope({ ...BASE, runId: "" }).valid, false);
  assert.equal(validateAttestationEnvelope({ ...BASE, runId: "a".repeat(129) }).valid, false);
  assert.equal(validateAttestationEnvelope({ ...BASE, runId: "a" }).valid, true);
});

// #9140: the old regex accepted any run of base64-alphabet characters regardless of length, including widths
// that are not valid base64 under any padding rule (e.g. 5 characters can never be a whole base64 payload).
test("validateAttestationEnvelope: attestationReport must be valid base64 — length a multiple of 4", () => {
  assert.equal(validateAttestationEnvelope({ ...BASE, attestationReport: "QUJDQ" }).valid, false); // 5 chars
  assert.equal(validateAttestationEnvelope({ ...BASE, attestationReport: "QUJDQQ" }).valid, false); // 6 chars, no padding
  assert.equal(validateAttestationEnvelope({ ...BASE, attestationReport: "QUJDQQ==" }).valid, true); // properly padded
  assert.equal(validateAttestationEnvelope({ ...BASE, attestationReport: "QUJD" }).valid, true); // exact multiple of 4
});
