export type ParsedPairwiseScoreArgs =
  | {
      json: boolean;
      input: {
        objectiveAnchor?: number | undefined;
        samples: readonly unknown[];
        weights?: { objectiveAnchor?: number | undefined; pairwiseJudge?: number | undefined } | undefined;
      };
    }
  | { error: string };

export function parsePairwiseScoreArgs(args: string[]): ParsedPairwiseScoreArgs;

export function renderPairwiseScoreTable(result: {
  compositeScore: number;
  objectiveAnchorScore: number;
  pairwiseJudgeScore: number | null;
  metrics: {
    stableSamples: number;
    totalSamples: number;
    orderInstabilityRate: number;
  };
}): string;

export function runPairwiseScore(
  args: string[],
  options?: {
    computePairwiseCalibrationScore?: typeof import("@jsonbored/gittensory-engine").computePairwiseCalibrationScore;
  },
): number;

export function runCalibrationCli(
  subcommand: string | undefined,
  nested: string | undefined,
  args: string[],
  options?: {
    computePairwiseCalibrationScore?: typeof import("@jsonbored/gittensory-engine").computePairwiseCalibrationScore;
  },
): number;
