import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  parsePairwiseScoreArgs,
  renderPairwiseScoreTable,
  runCalibrationCli,
  runPairwiseScore,
} from "../../packages/gittensory-miner/lib/pairwise-calibration-cli.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner pairwise calibration CLI (#3013)", () => {
  it("parsePairwiseScoreArgs validates argv and input shape", () => {
    expect(
      parsePairwiseScoreArgs([
        "--input",
        JSON.stringify({
          objectiveAnchor: 0.55,
          samples: [{ attempts: [{ replayFirst: "replay_better", revealedFirst: "revealed_better" }] }],
        }),
        "--json",
      ]),
    ).toEqual({
      json: true,
      input: {
        objectiveAnchor: 0.55,
        samples: [{ attempts: [{ replayFirst: "replay_better", revealedFirst: "revealed_better" }] }],
      },
    });
    expect(parsePairwiseScoreArgs(["--input", "[]"])).toEqual({
      error: expect.stringContaining("Usage:"),
    });
    expect(
      parsePairwiseScoreArgs([
        "--input",
        JSON.stringify({ objectiveAnchor: 0.5 }),
      ]),
    ).toEqual({
      error: "Pairwise calibration input must include a samples array.",
    });
  });

  it("parsePairwiseScoreArgs reads JSON from an @file path", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-pairwise-cli-"));
    roots.push(root);
    const file = join(root, "input.json");
    writeFileSync(
      file,
      JSON.stringify({
        objectiveAnchor: 0.4,
        samples: [{ attempts: [{ replayFirst: "tie", revealedFirst: "tie" }] }],
      }),
    );
    expect(parsePairwiseScoreArgs(["--input", `@${file}`])).toEqual({
      json: false,
      input: {
        objectiveAnchor: 0.4,
        samples: [{ attempts: [{ replayFirst: "tie", revealedFirst: "tie" }] }],
      },
    });
  });

  it("parsePairwiseScoreArgs rejects @file paths that traverse outside the cwd", () => {
    expect(parsePairwiseScoreArgs(["--input", "@../../etc/passwd"])).toEqual({
      error: expect.stringMatching(/\.\. segments/u),
    });
  });

  it("renderPairwiseScoreTable summarizes composite and instability metrics", () => {
    const table = renderPairwiseScoreTable({
      compositeScore: 0.775,
      objectiveAnchorScore: 0.55,
      pairwiseJudgeScore: 1,
      metrics: {
        stableSamples: 1,
        totalSamples: 1,
        orderInstabilityRate: 0,
      },
    });
    expect(table).toContain("composite score: 0.775");
    expect(table).toContain("pairwise judge: 1");
    expect(table).toContain("stable samples: 1/1");
  });

  it("runPairwiseScore prints table and JSON output", async () => {
    const input = {
      objectiveAnchor: 0.55,
      samples: [{ attempts: [{ replayFirst: "replay_better", revealedFirst: "revealed_better" }] }],
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runPairwiseScore(["--input", JSON.stringify(input)])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("composite score:");

    log.mockClear();
    expect(await runPairwiseScore(["--input", JSON.stringify(input), "--json"])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.compositeScore).toBeGreaterThan(0);
    expect(parsed.metrics.stableSamples).toBe(1);
  });

  it("runCalibrationCli dispatches pairwise score and rejects unknown subcommands", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCalibrationCli("pairwise", "score", ["--input", "not-json"])).toBe(2);
    expect(await runCalibrationCli("gate-verdict", "score", [])).toBe(2);
    expect(String(err.mock.calls.at(-1)?.[0])).toContain("Unknown calibration subcommand");
  });
});
