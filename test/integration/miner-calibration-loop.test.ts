/**
 * End-to-end regression for the Phase 7 calibration wiring (#4248): the full chain the closed #3014 claimed but
 * never connected — the deterministic replay scorer (replay-objective-anchor.js, #3012) → the engine's combine
 * contract (computePhase7CalibrationLoop, #3014) → a persisted, queryable ledger row. Per-module edge cases stay in
 * test/unit/miner-calibration-run.test.ts and packages/loopover-engine/test/phase7-calibration-loop.test.ts; this
 * file pins the composed chain against a REAL engine combine and a REAL temp-file event ledger.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Resolve the engine PACKAGE import inside calibration-run.js to the in-repo source, so the runner's default
// (non-injected) combine runs the real computePhase7CalibrationLoop rather than a stub.
vi.mock("@loopover/engine", async () => import("../../packages/loopover-engine/src/index"));

import {
  MINER_CALIBRATION_SNAPSHOT_EVENT,
  readCalibrationSnapshots,
  runHistoricalReplayCalibrationCycle,
} from "../../packages/loopover-miner/lib/calibration-run";
import { filterLedgerEvents, runLedgerList } from "../../packages/loopover-miner/lib/event-ledger-cli";
import { initEventLedger } from "../../packages/loopover-miner/lib/event-ledger";

const roots: string[] = [];

function tempLedgerPath() {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-calibration-"));
  roots.push(root);
  return join(root, "event-ledger.sqlite3");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("miner Phase 7 calibration loop (#4248)", () => {
  it("scores a replay run, combines it with pr_outcome in the real engine, and persists a queryable snapshot", () => {
    const ledger = initEventLedger(tempLedgerPath());
    try {
      const out = runHistoricalReplayCalibrationCycle(
        {
          config: { miner: { calibration: { phase7LoopEnabled: true, prOutcomeMinDecided: 1 } } },
          // pr_outcome confusion matrix → 8/10 correct → 0.8 accuracy.
          prOutcome: { mergeConfirmed: 8, mergeFalse: 2, closeConfirmed: 0, closeFalse: 0 },
          replayRun: {
            // A fully-overlapping feature task → objective-anchor score 1.0.
            replayResults: [
              {
                replayPlan: { pathsTouched: ["src/x/a.ts"], title: "feat: cache invalidation" },
                revealedHistory: [{ pathsTouched: ["src/x/b.ts"], title: "feat: cache fix" }],
              },
            ],
            replayRunId: "replay-run-2026-07-09",
            observedAt: "2026-07-09T00:00:00.000Z",
            harnessStatus: "healthy",
          },
          now: "2026-07-10T00:00:00.000Z",
          repoFullName: "acme/widgets",
        },
        { eventLedger: ledger },
      );

      // The historical_replay accuracy came from the SCORER (1.0), not a hardcoded value, and combined 0.5/0.5 with
      // the 0.8 pr_outcome signal → 0.9, clearing the default 0.70 autonomy threshold with both sources present.
      expect(out.result.bySource.historical_replay.accuracy).toBe(1);
      expect(out.result.bySource.historical_replay.replayRunId).toBe("replay-run-2026-07-09");
      expect(out.result.bySource.pr_outcome.accuracy).toBe(0.8);
      expect(out.result.combinedAccuracy).toBe(0.9);
      expect(out.result.autonomyIncreasePermitted).toBe(true);
      expect(out.recorded).not.toBeNull();

      // Persisted row is readable back through the typed reader from a FRESH connection to the same file.
      const reopened = initEventLedger(ledger.dbPath);
      try {
        const snapshots = readCalibrationSnapshots(reopened, { repoFullName: "acme/widgets" });
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]).toMatchObject({
          combinedAccuracy: 0.9,
          autonomyIncreasePermitted: true,
          replayHarnessStatus: "healthy",
          replayRunId: "replay-run-2026-07-09",
          replaySampleSize: 1,
          repoFullName: "acme/widgets",
        });

        // Deliverable: the snapshot is queryable via the EXISTING `loopover-miner ledger list --type` tooling.
        const typed = filterLedgerEvents(reopened.readEvents(), { type: MINER_CALIBRATION_SNAPSHOT_EVENT });
        expect(typed).toHaveLength(1);

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const exitCode = runLedgerList(["--type", MINER_CALIBRATION_SNAPSHOT_EVENT, "--json"], {
          initEventLedger: () => reopened,
        });
        expect(exitCode).toBe(0);
        const printed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as { events: Array<{ type: string }> };
        expect(printed.events).toHaveLength(1);
        expect(printed.events[0]?.type).toBe(MINER_CALIBRATION_SNAPSHOT_EVENT);
      } finally {
        reopened.close();
      }
    } finally {
      ledger.close();
    }
  });

  it("holds fail-closed and still persists the snapshot when the replay harness is degraded", () => {
    const ledger = initEventLedger(tempLedgerPath());
    try {
      const out = runHistoricalReplayCalibrationCycle(
        {
          config: { miner: { calibration: { phase7LoopEnabled: true, prOutcomeMinDecided: 1 } } },
          prOutcome: { mergeConfirmed: 9, mergeFalse: 1, closeConfirmed: 0, closeFalse: 0 },
          replayRun: {
            replayResults: [
              {
                replayPlan: { pathsTouched: ["src/x/a.ts"], title: "feat: x" },
                revealedHistory: [{ pathsTouched: ["src/x/b.ts"], title: "feat: y" }],
              },
            ],
            replayRunId: "replay-degraded",
            observedAt: "2026-07-09T00:00:00.000Z",
            harnessStatus: "degraded",
          },
          now: "2026-07-10T00:00:00.000Z",
        },
        { eventLedger: ledger },
      );

      // A degraded harness is a fail-closed hold: no autonomy increase, and historical_replay is rejected even
      // though pr_outcome had signal — so the combined metric never contributes to an increase.
      expect(out.result.autonomyIncreasePermitted).toBe(false);
      expect(out.result.replayHarnessHold).toBe(true);
      expect(out.snapshot.replayHarnessStatus).toBe("degraded");
      expect(out.recorded).not.toBeNull();
      expect(readCalibrationSnapshots(ledger)).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });
});
