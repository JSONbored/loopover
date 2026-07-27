import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMinerMcpServer } from "../../packages/loopover-miner/bin/loopover-miner-mcp";
import { initEventLedger } from "../../packages/loopover-miner/lib/event-ledger";
import { initPredictionLedger } from "../../packages/loopover-miner/lib/prediction-ledger";

// loopover_miner_get_calibration_report (#5821): read-only wrapper joining the prediction ledger with pr_outcome
// events via calibration-cli.js's existing toPredictionRecords/toOutcomeRecords mappers and calibration.js's
// buildCalibrationReport composer. Driven against REAL temp stores (not fakes) so the has-signal/no-signal
// assertions exercise the actual join, mirroring miner-mcp-governor-decisions.test.ts's approach.

type Content = { content: Array<{ type: string; text?: string }> };
type PredictionLedgerHandle = ReturnType<typeof initPredictionLedger>;
type EventLedgerHandle = ReturnType<typeof initEventLedger>;

const roots: string[] = [];
function tempPredictionLedger(): PredictionLedgerHandle {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-mcp-calibration-pred-"));
  roots.push(root);
  return initPredictionLedger(join(root, "prediction-ledger.sqlite3"));
}
function tempEventLedger(): EventLedgerHandle {
  const root = mkdtempSync(join(tmpdir(), "loopover-miner-mcp-calibration-event-"));
  roots.push(root);
  return initEventLedger(join(root, "event-ledger.sqlite3"));
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function toolText(result: Content): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a single text content block");
  }
  return first.text;
}

async function callCalibrationReport(
  predictionLedger: PredictionLedgerHandle,
  eventLedger: EventLedgerHandle,
): Promise<unknown> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "miner-mcp-calibration-test", version: "0.0.0" });
  await Promise.all([
    createMinerMcpServer({
      initPredictionLedger: () => predictionLedger,
      initEventLedger: () => eventLedger,
    }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const result = (await client.callTool({
    name: "loopover_miner_get_calibration_report",
    arguments: {},
  })) as Content;
  return JSON.parse(toolText(result));
}

describe("loopover_miner_get_calibration_report (#5821)", () => {
  it("returns hasSignal: false with no rows when neither store has data (calibration-cli.js's own no-signal branch)", async () => {
    const predictionLedger = tempPredictionLedger();
    const eventLedger = tempEventLedger();
    expect(await callCalibrationReport(predictionLedger, eventLedger)).toEqual({ hasSignal: false, rows: [] });
  });

  it("joins a decided prediction with its realized outcome into a per-project row (has-signal branch)", async () => {
    const predictionLedger = tempPredictionLedger();
    const eventLedger = tempEventLedger();
    predictionLedger.appendPrediction({
      repoFullName: "acme/widgets",
      targetId: 42,
      conclusion: "merge",
      pack: "default",
      engineVersion: "1.0.0",
    });
    eventLedger.appendEvent({
      type: "pr_outcome",
      repoFullName: "acme/widgets",
      payload: { prNumber: 42, decision: "merged" },
    });

    const report = (await callCalibrationReport(predictionLedger, eventLedger)) as {
      hasSignal: boolean;
      rows: Array<Record<string, unknown>>;
    };
    expect(report.hasSignal).toBe(true);
    expect(report.rows).toEqual([
      {
        project: "acme/widgets",
        wouldMerge: 1,
        mergeConfirmed: 1,
        mergeFalse: 0,
        wouldClose: 0,
        closeConfirmed: 0,
        closeFalse: 0,
        hold: 0,
        decided: 1,
        mergePrecision: 1,
        closePrecision: null,
      },
    ]);
  });

  it("does NOT count a prediction with no matching realized outcome yet (still pending)", async () => {
    const predictionLedger = tempPredictionLedger();
    const eventLedger = tempEventLedger();
    predictionLedger.appendPrediction({
      repoFullName: "acme/widgets",
      targetId: 7,
      conclusion: "merge",
      pack: "default",
      engineVersion: "1.0.0",
    });
    expect(await callCalibrationReport(predictionLedger, eventLedger)).toEqual({ hasSignal: false, rows: [] });
  });

  it("does not close an injected store — the caller retains ownership (mirrors the sibling tools' seam contract)", async () => {
    const predictionLedger = tempPredictionLedger();
    const eventLedger = tempEventLedger();
    await callCalibrationReport(predictionLedger, eventLedger);
    // If the tool had closed either injected store, this read would throw against a closed native handle.
    expect(() => predictionLedger.readPredictions()).not.toThrow();
    expect(() => eventLedger.readEvents()).not.toThrow();
  });
});
