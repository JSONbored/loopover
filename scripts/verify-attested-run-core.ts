// Orchestrating verification core (#9212, epic #8534): "did this exact code run on this exact corpus inside
// genuine SNP hardware" -- answerable by a third party who trusts nothing but AMD's own published root keys
// and the code in this file. Pure with respect to IO (the CLI reads files/network, this module only takes
// already-loaded bytes and PEM strings) so every failure class below is independently, deterministically
// testable with real cryptography (see this file's companion test suite -- a synthetic-but-genuine 3-tier
// PKI, never a mocked "verification" that can't actually fail).
//
// SECURITY-CRITICAL ORDERING: nothing the report itself claims (its TCB fields, its measurement, its
// report_data) is trusted until BOTH the certificate chain is trusted AND the report's own signature has
// verified against that chain's VCEK. Checking any report content first would mean a forged report with a
// fabricated (but plausible-looking) measurement could pass checks 6-8 below by coincidence, before ever
// being rejected for the invalid signature that actually damns it.
import { buildAttestationReportData } from "@loopover/engine/calibration/attestation-envelope";
import { isSampleAttestationReport } from "@loopover/engine/calibration/attester";
import type { AttestationEnvelope } from "@loopover/engine/calibration/attestation-envelope";
import { X509Certificate, verify as cryptoVerify } from "node:crypto";

import { encodeOid, findExtensionValue, parseDer, readSmallDerInteger } from "./verify-attested-run-der";
import { parseSnpReport, type SnpTcbVersion } from "./verify-attested-run-report";

export type VerificationFailureClass =
  | "sample_attestation"
  | "envelope_invalid"
  | "malformed_report"
  | "chain_untrusted"
  | "signature_invalid"
  | "tcb_mismatch"
  | "measurement_mismatch"
  | "report_data_mismatch";

export type VerificationResult =
  | { verified: true }
  | { verified: false; failureClass: VerificationFailureClass; reason: string };

export type VerifyAttestedRunInput = {
  envelope: AttestationEnvelope;
  /** Raw SNP report bytes, i.e. `Buffer.from(envelope.attestationReport, "base64")` -- decoding is the
   *  CLI's job so this module never has to guess an encoding. */
  rawReportBytes: Uint8Array;
  vcekCertPem: string;
  askCertPem: string;
  arkCertPem: string;
  /** The operator's own vendored, trusted root -- compared byte-for-byte (not merely "is self-signed") against
   *  `arkCertPem`, so a caller can never be tricked by an attacker-supplied self-signed "ARK" that isn't
   *  actually AMD's. */
  pinnedArkCertPem: string;
  /** Hex, from the tenant/operator's own manifest -- what the launch measurement is expected to be. */
  expectedMeasurementHex: string;
  corpusChecksum: string;
  headSha: string;
  baseSha: string;
  allowSample: boolean;
};

const AMD_SVN_OIDS = {
  bootloaderSpl: encodeOid([1, 3, 6, 1, 4, 1, 3704, 1, 3, 1]),
  teeSpl: encodeOid([1, 3, 6, 1, 4, 1, 3704, 1, 3, 2]),
  snpSpl: encodeOid([1, 3, 6, 1, 4, 1, 3704, 1, 3, 3]),
  microcodeSpl: encodeOid([1, 3, 6, 1, 4, 1, 3704, 1, 3, 8]),
} as const;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem
    .split("\n")
    .filter((line) => line.length > 0 && !line.includes("BEGIN") && !line.includes("END"))
    .join("");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/**
 * Read the four AMD KDS SVN OIDs (bootloader/TEE/SNP/microcode) off a VCEK certificate's raw DER, per
 * kds/kds.go's OID table in google/go-sev-guest. Any missing or malformed OID is a certificate this function
 * refuses to interpret -- it throws rather than substituting a default SVN, since a default here would mean
 * silently trusting an unattested claim.
 */
export function readVcekTcbFromCertificate(vcekCertDer: Uint8Array): SnpTcbVersion {
  const tree = parseDer(vcekCertDer);
  const readOne = (oid: Uint8Array, name: string): number => {
    const value = findExtensionValue(vcekCertDer, tree, oid);
    if (!value) throw new Error(`readVcekTcbFromCertificate: missing AMD SVN extension for ${name}`);
    return readSmallDerInteger(value);
  };
  return {
    bootloaderSpl: readOne(AMD_SVN_OIDS.bootloaderSpl, "bootloaderSpl"),
    teeSpl: readOne(AMD_SVN_OIDS.teeSpl, "teeSpl"),
    snpSpl: readOne(AMD_SVN_OIDS.snpSpl, "snpSpl"),
    microcodeSpl: readOne(AMD_SVN_OIDS.microcodeSpl, "microcodeSpl"),
  };
}

/** `error.message` for a real Error, `String(error)` for anything else a `catch` clause could technically
 *  hand back (a thrown string/object, however unusual in practice) -- isolated into its own function so both
 *  arms are independently unit-testable rather than only reachable through whatever a specific call site
 *  happens to throw today. */
export function formatCaughtError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tcbVersionsEqual(a: SnpTcbVersion, b: SnpTcbVersion): boolean {
  return a.bootloaderSpl === b.bootloaderSpl && a.teeSpl === b.teeSpl && a.snpSpl === b.snpSpl && a.microcodeSpl === b.microcodeSpl;
}

function formatTcb(tcb: SnpTcbVersion): string {
  return `bootloader=${tcb.bootloaderSpl} tee=${tcb.teeSpl} snp=${tcb.snpSpl} microcode=${tcb.microcodeSpl}`;
}

/**
 * Verify an attested run end to end. Never throws for an ordinarily-invalid input (a bad signature, a
 * mismatched measurement, an untrusted chain) -- those are all `{ verified: false, failureClass, reason }`.
 * Only a structurally impossible input (certificates that don't even parse as X.509, for instance) propagates
 * as a thrown error, since that is a caller-side bug (malformed PEM), not a fact about the attested run.
 */
export function verifyAttestedRun(input: VerifyAttestedRunInput): VerificationResult {
  if (!input.allowSample && isSampleAttestationReport(input.envelope.attestationReport)) {
    return {
      verified: false,
      failureClass: "sample_attestation",
      reason: "envelope is sample-attested (dev artifact, not evidence) -- pass --allow-sample to accept it anyway for local development",
    };
  }

  let report: ReturnType<typeof parseSnpReport>;
  try {
    report = parseSnpReport(input.rawReportBytes);
  } catch (error) {
    return { verified: false, failureClass: "malformed_report", reason: formatCaughtError(error) };
  }

  // Chain of trust: the operator's pinned root, byte-for-byte, is what "ARK" means here -- not merely
  // "some self-signed certificate". ARK -> ASK -> VCEK, each link a real signature check.
  const pinnedArkDer = pemToDer(input.pinnedArkCertPem);
  const suppliedArkDer = pemToDer(input.arkCertPem);
  if (toHex(pinnedArkDer) !== toHex(suppliedArkDer)) {
    return { verified: false, failureClass: "chain_untrusted", reason: "supplied ARK certificate does not match the pinned, vendored root" };
  }
  const ark = new X509Certificate(input.arkCertPem);
  const ask = new X509Certificate(input.askCertPem);
  const vcek = new X509Certificate(input.vcekCertPem);
  if (!ark.verify(ark.publicKey)) {
    return { verified: false, failureClass: "chain_untrusted", reason: "pinned ARK certificate does not verify against its own public key (not self-signed)" };
  }
  if (!ask.verify(ark.publicKey)) {
    return { verified: false, failureClass: "chain_untrusted", reason: "ASK certificate was not signed by the pinned ARK" };
  }
  if (!vcek.verify(ask.publicKey)) {
    return { verified: false, failureClass: "chain_untrusted", reason: "VCEK certificate was not signed by the verified ASK" };
  }

  // The report's own signature, checked against the now-trusted VCEK's public key -- nothing about the
  // report's CONTENT (below) is meaningful until this passes.
  const vcekPublicKeyPem = vcek.publicKey.export({ type: "spki", format: "pem" });
  const signatureValid = verifySnpSignature(report.signedBytes, report.signatureIeeeP1363, vcekPublicKeyPem);
  if (!signatureValid) {
    return { verified: false, failureClass: "signature_invalid", reason: "report signature does not verify against the trusted VCEK public key" };
  }

  const certTcb = readVcekTcbFromCertificate(pemToDer(input.vcekCertPem));
  if (!tcbVersionsEqual(certTcb, report.reportedTcb)) {
    return {
      verified: false,
      failureClass: "tcb_mismatch",
      reason: `report's reported_tcb (${formatTcb(report.reportedTcb)}) does not match the VCEK certificate's provisioned TCB (${formatTcb(certTcb)})`,
    };
  }

  const measurementHex = toHex(report.measurement);
  if (measurementHex !== input.expectedMeasurementHex.toLowerCase()) {
    return {
      verified: false,
      failureClass: "measurement_mismatch",
      reason: `report measurement ${measurementHex} does not match the expected pinned digest ${input.expectedMeasurementHex.toLowerCase()}`,
    };
  }

  const expectedReportData = buildAttestationReportData({
    corpusChecksum: input.corpusChecksum,
    headSha: input.headSha,
    baseSha: input.baseSha,
    runId: input.envelope.runId,
  });
  if (toHex(report.reportData) !== expectedReportData) {
    return {
      verified: false,
      failureClass: "report_data_mismatch",
      reason: "report_data re-derived from the envelope's claimed corpus checksum, SHAs, and runId does not match the report's own report_data field",
    };
  }

  return { verified: true };
}

/** Real ECDSA-P384-SHA384 verification, isolated into its own function purely so the core orchestration
 *  above reads as a flat sequence of named checks. */
function verifySnpSignature(signedBytes: Uint8Array, signatureIeeeP1363: Uint8Array, vcekPublicKeyPem: string | Buffer): boolean {
  return cryptoVerify("sha384", signedBytes, { key: vcekPublicKeyPem, dsaEncoding: "ieee-p1363" }, signatureIeeeP1363);
}
