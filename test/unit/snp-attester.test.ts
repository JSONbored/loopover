import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ATTESTATION_AGENT_URL, createSnpAttester } from "../../scripts/snp-attester.js";

const REQUEST = { reportData: "b".repeat(128), runtimeClass: "loopover-backtest-runner" };
const MEASUREMENT = "a".repeat(64);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function spawnResult(over: Partial<{ status: number | null; stdout: string; stderr: string }> = {}) {
  return { status: 0, stdout: "", stderr: "", ...over } as ReturnType<typeof import("node:child_process").spawnSync>;
}

describe("createSnpAttester", () => {
  it("collects from the attestation agent, binding reportData into the request URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ evidence: "QUJD" }));
    const attester = createSnpAttester({ measurement: MEASUREMENT, fetchImpl: fetchImpl as unknown as typeof fetch });

    const collection = await attester.collect(REQUEST);

    expect(attester.kind).toBe("sev-snp");
    expect(collection).toEqual({ teeTechnology: "sev-snp", measurement: MEASUREMENT, attestationReport: "QUJD" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${DEFAULT_ATTESTATION_AGENT_URL}?runtime_data=${REQUEST.reportData}`);
  });

  it("falls back to the device helper when the agent path fails, and reports both failures if it also fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    const spawnImpl = vi.fn().mockReturnValue(spawnResult({ stdout: "REPORT64\n" }));
    const attester = createSnpAttester({
      measurement: MEASUREMENT,
      reportBin: "/usr/bin/snp-report",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawnSync,
    });

    const collection = await attester.collect(REQUEST);
    expect(collection.attestationReport).toBe("REPORT64");
    expect(spawnImpl).toHaveBeenCalledWith("/usr/bin/snp-report", [REQUEST.reportData], { encoding: "utf8" });
  });

  it("throws with every attempted path's reason when no path yields a report", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const spawnImpl = vi.fn().mockReturnValue(spawnResult({ status: 1, stderr: "no /dev/sev-guest\n" }));
    const attester = createSnpAttester({
      measurement: MEASUREMENT,
      reportBin: "/usr/bin/snp-report",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawnSync,
    });

    await expect(attester.collect(REQUEST)).rejects.toThrow(
      "agent: ECONNREFUSED; device: report helper exited 1: no /dev/sev-guest",
    );
  });

  it("throws a distinct error when both paths are disabled -- a misconfiguration, not a hardware absence", async () => {
    const attester = createSnpAttester({ measurement: MEASUREMENT, agentUrl: null, reportBin: null });
    await expect(attester.collect(REQUEST)).rejects.toThrow("no attestation path configured");
  });

  it("rejects an agent response that is ok but carries no usable evidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ evidence: "" }));
    const attester = createSnpAttester({
      measurement: MEASUREMENT,
      reportBin: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(attester.collect(REQUEST)).rejects.toThrow("agent: attestation agent returned no evidence");
  });

  it("rejects a non-string evidence field, and a device helper that exits 0 with no output", async () => {
    const badShape = createSnpAttester({
      measurement: MEASUREMENT,
      reportBin: null,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ evidence: 42 })) as unknown as typeof fetch,
    });
    await expect(badShape.collect(REQUEST)).rejects.toThrow("attestation agent returned no evidence");

    const emptyDevice = createSnpAttester({
      measurement: MEASUREMENT,
      agentUrl: null,
      reportBin: "/usr/bin/snp-report",
      spawnImpl: vi.fn().mockReturnValue(spawnResult({ stdout: "  " })) as unknown as typeof import("node:child_process").spawnSync,
    });
    await expect(emptyDevice.collect(REQUEST)).rejects.toThrow("device: report helper produced no output");
  });

  it("names a null exit status and an empty stderr explicitly (both nullish fallbacks)", async () => {
    const attester = createSnpAttester({
      measurement: MEASUREMENT,
      agentUrl: null,
      reportBin: "/usr/bin/snp-report",
      spawnImpl: vi
        .fn()
        .mockReturnValue({ status: null, stdout: undefined, stderr: undefined } as never) as unknown as typeof import("node:child_process").spawnSync,
    });
    await expect(attester.collect(REQUEST)).rejects.toThrow("device: report helper exited null: no stderr");
  });

  it("propagates a non-Error agent throw through the String() fallback arm", async () => {
    const attester = createSnpAttester({
      measurement: MEASUREMENT,
      reportBin: null,
      fetchImpl: vi.fn().mockRejectedValue("socket hang up") as unknown as typeof fetch,
    });
    await expect(attester.collect(REQUEST)).rejects.toThrow("agent: socket hang up");
  });

  it("propagates a non-Error device throw through its String() fallback arm too", async () => {
    const attester = createSnpAttester({
      measurement: MEASUREMENT,
      agentUrl: null,
      reportBin: "/usr/bin/snp-report",
      spawnImpl: vi.fn().mockImplementation(() => {
        throw "spawn exploded";
      }) as unknown as typeof import("node:child_process").spawnSync,
    });
    await expect(attester.collect(REQUEST)).rejects.toThrow("device: spawn exploded");
  });
});
