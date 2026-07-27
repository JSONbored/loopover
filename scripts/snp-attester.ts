// SEV-SNP attester (#9211) -- the IO-touching half of the attester seam, kept OUT of @loopover/engine so
// that package stays pure (no IO, no randomness, no clock). Pairs with createSampleAttester: same Attester
// interface, so switching a run from dev to real hardware is a config change, never a code change.
//
// Two collection paths, tried in order:
//   1. A Confidential Containers attestation agent over its local HTTP endpoint (the k3s/Kata/CoCo topology
//      this epic targets -- see #9213). Preferred, because the agent owns the VCEK/cert plumbing.
//   2. The guest device (/dev/sev-guest) via a helper binary, for a bare CVM with no agent.
//
// Neither path is reachable without SNP-capable hardware, which is exactly why the sample attester exists:
// this file's failure mode on ordinary hardware is a clean throw that assembleAttestationEnvelope converts
// into `{ ok: false }`, which decideAttestedRunOutcome then classifies as attestation_failed under a TEE
// claim (fail-closed) -- never a silent degrade.
import { spawnSync } from "node:child_process";

import type { Attester, AttestationCollection, AttestationCollectionRequest } from "@loopover/engine/calibration/attester";

/** Where a CoCo attestation agent listens inside the guest. Overridable for a non-default topology. */
export const DEFAULT_ATTESTATION_AGENT_URL = "http://127.0.0.1:8006/aa/evidence";

export type SnpAttesterOptions = {
  /** CoCo attestation-agent evidence endpoint. Set to null to skip the agent path entirely. */
  agentUrl?: string | null;
  /** Helper binary for the direct-device path, invoked as `<bin> <reportDataHex>` and expected to print the
   *  base64 report on stdout. Set to null to skip the device path. */
  reportBin?: string | null;
  /** Launch measurement, hex. Supplied by the deployment (recorded when the CoCo runtime class is stood up,
   *  #9213) rather than read here -- the guest cannot self-report a trustworthy measurement, and the verifier
   *  (#9212) checks it against the expected pinned image digest anyway. */
  measurement: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawnSync;
};

async function collectFromAgent(url: string, request: AttestationCollectionRequest, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`${url}?runtime_data=${encodeURIComponent(request.reportData)}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`attestation agent responded ${response.status}`);
  const body = (await response.json()) as { evidence?: unknown };
  if (typeof body.evidence !== "string" || body.evidence.length === 0) {
    throw new Error("attestation agent returned no evidence");
  }
  return body.evidence;
}

function collectFromDevice(bin: string, request: AttestationCollectionRequest, spawnImpl: typeof spawnSync): string {
  const result = spawnImpl(bin, [request.reportData], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`report helper exited ${result.status ?? "null"}: ${(result.stderr ?? "").trim() || "no stderr"}`);
  }
  const report = (result.stdout ?? "").trim();
  if (report.length === 0) throw new Error("report helper produced no output");
  return report;
}

/**
 * A real SEV-SNP {@link Attester}. Throws (rather than returning a degraded collection) when no path yields a
 * report: the caller's fail-closed classification is what decides whether that is fatal, and a half-formed
 * "collection" here would defeat it.
 */
export function createSnpAttester(options: SnpAttesterOptions): Attester {
  const agentUrl = options.agentUrl === undefined ? DEFAULT_ATTESTATION_AGENT_URL : options.agentUrl;
  const reportBin = options.reportBin === undefined ? null : options.reportBin;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const spawnImpl = options.spawnImpl ?? spawnSync;

  return {
    kind: "sev-snp",
    async collect(request: AttestationCollectionRequest): Promise<AttestationCollection> {
      const failures: string[] = [];

      if (agentUrl) {
        try {
          return {
            teeTechnology: "sev-snp",
            measurement: options.measurement,
            attestationReport: await collectFromAgent(agentUrl, request, fetchImpl),
          };
        } catch (error) {
          failures.push(`agent: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (reportBin) {
        try {
          return {
            teeTechnology: "sev-snp",
            measurement: options.measurement,
            attestationReport: collectFromDevice(reportBin, request, spawnImpl),
          };
        } catch (error) {
          failures.push(`device: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      throw new Error(failures.length > 0 ? failures.join("; ") : "no attestation path configured");
    },
  };
}
