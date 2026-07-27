#!/usr/bin/env node
// Envelope verifier CLI (#9212, epic #8534) -- "did this exact code run on this exact corpus inside genuine
// SNP hardware", answerable by anyone, without contacting us. Thin IO wrapper: reads the envelope, the
// operator's expected-values file, and the certificate chain (vendored by default, or fetched from AMD's KDS
// with --fetch-vcek), decodes/parses them, and delegates every real decision to verify-attested-run-core.ts's
// pure verifyAttestedRun.
//
//   npx tsx scripts/verify-attested-run.ts \
//     --envelope envelope.json --expected expected.json \
//     [--vcek-cert vcek.pem] [--fetch-vcek] [--product milan|genoa] \
//     [--ask-cert ask.pem] [--ark-cert ark.pem] [--allow-sample]
//
// envelope.json: the published AttestationEnvelope (schemaVersion, teeTechnology, runtimeClass, measurement,
//   reportData, runId, attestationReport (base64), verification) -- exactly the shape
//   assembleAttestationEnvelope produces. Where it comes from (a public API, a file a maintainer sent you) is
//   out of this CLI's scope; see epic #8534's #9186 (unified tenant verification contract) for how a
//   deployment is meant to publish one.
//
// expected.json: the caller's OWN pinned expectations -- { "measurement": "<hex>", "corpusChecksum": "<hex>",
//   "headSha": "<hex>", "baseSha": "<hex>" }. This is deliberately a separate file/concept from
//   scripts/replay-runner-image-manifest.json (#9214's image-reproducibility manifest) -- this one is about
//   what ONE run is expected to have produced, not about the image that produced it.
//
// --fetch-vcek performs a real network request to AMD's KDS (kdsintf.amd.com) using the chip ID and TCB SVNs
// read out of the report itself -- OFF by default, matching #9212's "no network by default" requirement; a
// verification that silently phones home would be a privacy/trust regression for a tool whose whole point is
// working without contacting anyone.
//
// Exit codes: 0 = verified. Non-zero, one per VerificationFailureClass (see verify-attested-run-core.ts):
//   1 sample_attestation, 2 envelope_invalid, 3 malformed_report, 4 chain_untrusted, 5 signature_invalid,
//   6 tcb_mismatch, 7 measurement_mismatch, 8 report_data_mismatch. 9 = usage/IO error (bad args, unreadable
//   file, network failure) -- distinct from every attestation-content failure above.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateAttestationEnvelope } from "@loopover/engine/calibration/attestation-envelope";

import { parseSnpReport } from "./verify-attested-run-report";
import { readVcekTcbFromCertificate, verifyAttestedRun, type VerificationFailureClass } from "./verify-attested-run-core";

const EXIT_CODE_BY_FAILURE_CLASS: Record<VerificationFailureClass, number> = {
  sample_attestation: 1,
  envelope_invalid: 2,
  malformed_report: 3,
  chain_untrusted: 4,
  signature_invalid: 5,
  tcb_mismatch: 6,
  measurement_mismatch: 7,
  report_data_mismatch: 8,
};
const EXIT_CODE_USAGE_ERROR = 9;

// Invoked from the repo root, like every other scripts/** CLI -- process.cwd() is the repo root by
// convention, not something this script re-derives from its own location.
const CERTS_DIR = join(process.cwd(), "scripts", "verify-attested-run", "certs");
const KDS_BASE_URL = "https://kdsintf.amd.com";

type Args = {
  envelopePath: string;
  expectedPath: string;
  vcekCertPath: string | null;
  fetchVcek: boolean;
  product: "milan" | "genoa";
  askCertPath: string | null;
  arkCertPath: string | null;
  allowSample: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index >= 0 ? (argv[index + 1] ?? null) : null;
  };
  const product = get("--product");
  return {
    envelopePath: get("--envelope") ?? "",
    expectedPath: get("--expected") ?? "",
    vcekCertPath: get("--vcek-cert"),
    fetchVcek: argv.includes("--fetch-vcek"),
    product: product === "genoa" ? "genoa" : "milan",
    askCertPath: get("--ask-cert"),
    arkCertPath: get("--ark-cert"),
    allowSample: argv.includes("--allow-sample"),
  };
}

type ExpectedValues = { measurement: string; corpusChecksum: string; headSha: string; baseSha: string };

function readExpectedValues(path: string): ExpectedValues {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ExpectedValues>;
  for (const field of ["measurement", "corpusChecksum", "headSha", "baseSha"] as const) {
    if (typeof parsed[field] !== "string" || parsed[field].length === 0) {
      throw new Error(`${path}: missing or empty required field "${field}"`);
    }
  }
  return parsed as ExpectedValues;
}

/** Fetch a VCEK certificate from AMD's KDS for the given chip ID and reported TCB, per kds/kds.go's URL
 *  template in google/go-sev-guest. Only ever called when the operator explicitly opts in via --fetch-vcek. */
async function fetchVcekFromKds(product: "milan" | "genoa", chipIdHex: string, tcb: { bootloaderSpl: number; teeSpl: number; snpSpl: number; microcodeSpl: number }): Promise<string> {
  const productPath = product === "milan" ? "Milan" : "Genoa";
  const url = `${KDS_BASE_URL}/vcek/v1/${productPath}/${chipIdHex}?blSPL=${tcb.bootloaderSpl}&teeSPL=${tcb.teeSpl}&snpSPL=${tcb.snpSpl}&ucodeSPL=${tcb.microcodeSpl}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`KDS request failed: ${response.status} ${response.statusText} (${url})`);
  const der = new Uint8Array(await response.arrayBuffer());
  const base64 = Buffer.from(der).toString("base64");
  const wrapped = (base64.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.envelopePath || !args.expectedPath) {
    process.stderr.write("verify-attested-run: --envelope and --expected are both required\n");
    process.exit(EXIT_CODE_USAGE_ERROR);
    return;
  }

  let rawEnvelopeJson: unknown;
  let expected: ExpectedValues;
  try {
    rawEnvelopeJson = JSON.parse(readFileSync(args.envelopePath, "utf8"));
    expected = readExpectedValues(args.expectedPath);
  } catch (error) {
    process.stderr.write(`verify-attested-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT_CODE_USAGE_ERROR);
    return;
  }

  const validation = validateAttestationEnvelope(rawEnvelopeJson);
  if (!validation.valid) {
    printResult({ verified: false, failureClass: "envelope_invalid", reason: validation.errors.join("; ") });
    process.exit(EXIT_CODE_BY_FAILURE_CLASS.envelope_invalid);
    return;
  }
  const envelope = validation.envelope;
  const rawReportBytes = new Uint8Array(Buffer.from(envelope.attestationReport, "base64"));

  const askCertPath = args.askCertPath ?? join(CERTS_DIR, `${args.product}-ask.pem`);
  const arkCertPath = args.arkCertPath ?? join(CERTS_DIR, `${args.product}-ark.pem`);
  let askCertPem: string;
  let arkCertPem: string;
  try {
    askCertPem = readFileSync(askCertPath, "utf8");
    arkCertPem = readFileSync(arkCertPath, "utf8");
  } catch (error) {
    process.stderr.write(`verify-attested-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT_CODE_USAGE_ERROR);
    return;
  }

  let vcekCertPem: string;
  try {
    if (args.vcekCertPath) {
      vcekCertPem = readFileSync(args.vcekCertPath, "utf8");
    } else if (args.fetchVcek) {
      const report = parseSnpReport(rawReportBytes);
      const chipIdHex = Buffer.from(report.chipId).toString("hex");
      vcekCertPem = await fetchVcekFromKds(args.product, chipIdHex, report.reportedTcb);
    } else {
      process.stderr.write("verify-attested-run: one of --vcek-cert <path> or --fetch-vcek is required\n");
      process.exit(EXIT_CODE_USAGE_ERROR);
      return;
    }
  } catch (error) {
    process.stderr.write(`verify-attested-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(EXIT_CODE_USAGE_ERROR);
    return;
  }

  const result = verifyAttestedRun({
    envelope,
    rawReportBytes,
    vcekCertPem,
    askCertPem,
    arkCertPem,
    pinnedArkCertPem: arkCertPem,
    expectedMeasurementHex: expected.measurement,
    corpusChecksum: expected.corpusChecksum,
    headSha: expected.headSha,
    baseSha: expected.baseSha,
    allowSample: args.allowSample,
  });

  printResult(result);
  process.exit(result.verified ? 0 : EXIT_CODE_BY_FAILURE_CLASS[result.failureClass]);
}

function printResult(result: { verified: true } | { verified: false; failureClass: VerificationFailureClass; reason: string }): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
