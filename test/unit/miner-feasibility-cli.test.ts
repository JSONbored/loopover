import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  parseFeasibilityArgs,
  runFeasibilityCli,
} from "../../packages/gittensory-miner/lib/feasibility-cli.js";
import { runCapture } from "./support/miner-cli-harness";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseFeasibilityArgs (#4270)", () => {
  it("parses the three required positional discriminants", () => {
    expect(parseFeasibilityArgs(["unclaimed", "none", "ready"])).toEqual({
      claimStatus: "unclaimed",
      duplicateClusterRisk: "none",
      issueStatus: "ready",
      found: true,
      json: false,
    });
  });

  it("parses --not-found and --json", () => {
    expect(parseFeasibilityArgs(["claimed", "medium", "hold", "--not-found", "--json"])).toEqual({
      claimStatus: "claimed",
      duplicateClusterRisk: "medium",
      issueStatus: "hold",
      found: false,
      json: true,
    });
  });

  it("requires exactly three positional arguments", () => {
    expect(parseFeasibilityArgs([])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner feasibility"),
    });
    expect(parseFeasibilityArgs(["unclaimed", "none"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner feasibility"),
    });
    expect(parseFeasibilityArgs(["unclaimed", "none", "ready", "extra"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner feasibility"),
    });
  });

  it("rejects an unrecognized claimStatus, duplicateClusterRisk, or issueStatus", () => {
    expect(parseFeasibilityArgs(["bogus", "none", "ready"])).toEqual({
      error: "claimStatus must be one of: unclaimed, claimed, solved, unknown.",
    });
    expect(parseFeasibilityArgs(["unclaimed", "bogus", "ready"])).toEqual({
      error: "duplicateClusterRisk must be one of: none, low, medium, high.",
    });
    expect(parseFeasibilityArgs(["unclaimed", "none", "bogus"])).toEqual({
      error: "issueStatus must be one of: ready, needs_proof, hold, do_not_use, duplicate, invalid, missing.",
    });
  });

  it("rejects unknown options", () => {
    expect(parseFeasibilityArgs(["unclaimed", "none", "ready", "--verbose"])).toEqual({
      error: "Unknown option: --verbose",
    });
  });
});

describe("runFeasibilityCli (#4270)", () => {
  it("prints a go verdict and exits 0 for a clean input", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runFeasibilityCli(["unclaimed", "none", "ready"])).toBe(0);
    expect(log).toHaveBeenCalledWith("go: Go: no blocking feasibility signal detected.");
  });

  it("prints an avoid verdict as JSON with reasons", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runFeasibilityCli(["solved", "none", "ready", "--json"])).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload).toEqual({
      verdict: "avoid",
      avoidReasons: ["claim_status_solved"],
      raiseReasons: [],
      summary: "Avoid: claim_status_solved.",
    });
  });

  it("prints a raise verdict for an uncertain issue quality signal", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runFeasibilityCli(["unclaimed", "none", "needs_proof"])).toBe(0);
    expect(log).toHaveBeenCalledWith("raise: Raise: issue_quality_uncertain.");
  });

  it("--not-found raises target_not_found", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runFeasibilityCli(["unclaimed", "none", "ready", "--not-found", "--json"])).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.verdict).toBe("raise");
    expect(payload.raiseReasons).toEqual(["target_not_found"]);
  });

  it("prints a usage error and exits 2 for invalid arguments", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runFeasibilityCli(["bogus", "none", "ready"])).toBe(2);
    expect(error).toHaveBeenCalledWith("claimStatus must be one of: unclaimed, claimed, solved, unknown.");
  });

  it("accepts an injected buildFeasibilityVerdict for isolation from the real composer", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fakeVerdict = vi.fn(() => ({
      verdict: "go" as const,
      avoidReasons: [],
      raiseReasons: [],
      summary: "fake verdict",
    }));
    expect(runFeasibilityCli(["unclaimed", "none", "ready"], { buildFeasibilityVerdict: fakeVerdict })).toBe(0);
    expect(fakeVerdict).toHaveBeenCalledWith({
      found: true,
      claimStatus: "unclaimed",
      duplicateClusterRisk: "none",
      issueStatus: "ready",
    });
    expect(log).toHaveBeenCalledWith("go: fake verdict");
  });
});

describe("gittensory-miner feasibility CLI entrypoint (#4270)", () => {
  it("lists the feasibility command in --help", () => {
    const output = runCapture(["--help", "--no-update-check"]);
    expect(output).toContain("gittensory-miner feasibility");
  });

  it("computes a real verdict end-to-end through the compiled engine dependency", () => {
    const output = runCapture(["feasibility", "unclaimed", "high", "ready"]);
    expect(output.trim()).toBe("avoid: Avoid: duplicate_cluster_high.");
  });

  it("exits 2 with a usage error for a missing argument", () => {
    const output = runCapture(["feasibility", "unclaimed", "none"]);
    expect(output).toContain("Usage: gittensory-miner feasibility");
  });
});

