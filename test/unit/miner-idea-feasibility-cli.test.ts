import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  parseIdeaFeasibilityArgs,
  runIdeaFeasibilityCli,
} from "../../packages/loopover-miner/lib/idea-feasibility-cli.js";
import type { FeasibilityGateResult } from "@loopover/engine";
import { runCapture } from "./support/miner-cli-harness";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseIdeaFeasibilityArgs (#5671)", () => {
  it("parses the two required positional discriminants with resolvable-target defaults", () => {
    expect(parseIdeaFeasibilityArgs(["unclaimed", "none"])).toEqual({
      claimStatus: "unclaimed",
      duplicateClusterRisk: "none",
      targetResolvable: true,
      acceptanceHints: [],
      json: false,
    });
  });

  it("parses --not-resolvable, repeated --hint, and --json", () => {
    expect(
      parseIdeaFeasibilityArgs(["claimed", "medium", "--not-resolvable", "--hint", "retries on 5xx", "--hint", "keeps API stable", "--json"]),
    ).toEqual({
      claimStatus: "claimed",
      duplicateClusterRisk: "medium",
      targetResolvable: false,
      acceptanceHints: ["retries on 5xx", "keeps API stable"],
      json: true,
    });
  });

  it("requires exactly two positional arguments", () => {
    expect(parseIdeaFeasibilityArgs([])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner idea-feasibility"),
    });
    expect(parseIdeaFeasibilityArgs(["unclaimed"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner idea-feasibility"),
    });
    expect(parseIdeaFeasibilityArgs(["unclaimed", "none", "extra"])).toEqual({
      error: expect.stringContaining("Usage: loopover-miner idea-feasibility"),
    });
  });

  it("rejects an unrecognized claimStatus or duplicateClusterRisk", () => {
    expect(parseIdeaFeasibilityArgs(["bogus", "none"])).toEqual({
      error: "claimStatus must be one of: unclaimed, claimed, solved, unknown.",
    });
    expect(parseIdeaFeasibilityArgs(["unclaimed", "bogus"])).toEqual({
      error: "duplicateClusterRisk must be one of: none, low, medium, high.",
    });
  });

  it("rejects unknown options", () => {
    expect(parseIdeaFeasibilityArgs(["unclaimed", "none", "--verbose"])).toEqual({
      error: "Unknown option: --verbose",
    });
  });

  it("rejects --hint with no following value (end of args)", () => {
    expect(parseIdeaFeasibilityArgs(["unclaimed", "none", "--hint"])).toEqual({
      error: "--hint requires a value.",
    });
  });

  it("rejects --hint whose value looks like another flag", () => {
    expect(parseIdeaFeasibilityArgs(["unclaimed", "none", "--hint", "--json"])).toEqual({
      error: "--hint requires a value.",
    });
  });
});

describe("runIdeaFeasibilityCli (#5671)", () => {
  it("proceeds to compute for a resolvable idea with an objective success signal", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runIdeaFeasibilityCli(["unclaimed", "none", "--hint", "uploads retry on 5xx"])).toBe(0);
    expect(log).toHaveBeenCalledWith("proceed: Go: no blocking feasibility signal detected.");
  });

  it("rejects an idea with no objective success signal (issueStatus invalid) as JSON", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runIdeaFeasibilityCli(["unclaimed", "none", "--json"])).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload).toEqual({
      disposition: "reject",
      verdict: "avoid",
      issueStatus: "invalid",
      reasons: ["issue_lifecycle_invalid"],
      summary: "Avoid: issue_lifecycle_invalid.",
    });
  });

  it("flags an idea whose target repo does not resolve (target_not_found, issueStatus missing)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runIdeaFeasibilityCli(["unclaimed", "none", "--not-resolvable", "--hint", "do a thing", "--json"])).toBe(0);
    const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(payload.disposition).toBe("flag");
    expect(payload.verdict).toBe("raise");
    expect(payload.issueStatus).toBe("missing");
    expect(payload.reasons).toContain("target_not_found");
  });

  it("prints a usage error to stderr and exits 2 for invalid arguments", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runIdeaFeasibilityCli(["bogus", "none"])).toBe(2);
    expect(error).toHaveBeenCalledWith("claimStatus must be one of: unclaimed, claimed, solved, unknown.");
  });

  it("emits a parseable JSON error object when --json accompanies a bad argument", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(runIdeaFeasibilityCli(["bogus", "none", "--json"])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: "claimStatus must be one of: unclaimed, claimed, solved, unknown.",
    });
  });

  it("accepts an injected buildFeasibilityVerdict for isolation from the real composer", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fakeVerdict = vi.fn((): FeasibilityGateResult => ({
      verdict: "go",
      avoidReasons: [],
      raiseReasons: [],
      summary: "fake verdict",
    }));
    expect(
      runIdeaFeasibilityCli(["unclaimed", "none", "--hint", "x"], { buildFeasibilityVerdict: fakeVerdict }),
    ).toBe(0);
    expect(fakeVerdict).toHaveBeenCalledWith({
      found: true,
      claimStatus: "unclaimed",
      duplicateClusterRisk: "none",
      issueStatus: "ready",
    });
    expect(log).toHaveBeenCalledWith("proceed: fake verdict");
  });
});

describe("loopover-miner idea-feasibility CLI entrypoint (#5671)", () => {
  it("lists the idea-feasibility command in --help", () => {
    const output = runCapture(["--help", "--no-update-check"]);
    expect(output).toContain("loopover-miner idea-feasibility");
  });

  it("computes a real disposition end-to-end through the compiled engine dependency", () => {
    const output = runCapture(["idea-feasibility", "unclaimed", "high", "--hint", "uploads retry on 5xx"]);
    expect(output.trim()).toBe("reject: Avoid: duplicate_cluster_high.");
  });

  it("exits with a usage error for a missing positional argument", () => {
    const output = runCapture(["idea-feasibility", "unclaimed"]);
    expect(output).toContain("Usage: loopover-miner idea-feasibility");
  });
});
