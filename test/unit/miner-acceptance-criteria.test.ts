import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_CRITERIA_FILENAME,
  ACCEPTANCE_CRITERIA_VERSION,
  buildAcceptanceCriteria,
  serializeAcceptanceCriteria,
  shouldWriteAcceptanceCriteria,
  buildFeasibilityVerdict,
  type AcceptanceCriteria,
  type PromptPacket,
} from "../../packages/gittensory-engine/src/index";

const CLEAN_PACKET: PromptPacket = {
  taskBrief: "Fix the off-by-one in the pagination cursor.",
  feasibilityNotes: "Unclaimed, no dup cluster, issue ready.",
  retrievalContext: "cursor.ts handles the page window.",
  constraints: "No public API changes; add a unit test.",
};

const GO = buildFeasibilityVerdict({ claimStatus: "unclaimed", duplicateClusterRisk: "none", issueStatus: "ready" });
const RAISE = buildFeasibilityVerdict({ claimStatus: "claimed", duplicateClusterRisk: "none", issueStatus: "ready" });
const AVOID = buildFeasibilityVerdict({ claimStatus: "solved", duplicateClusterRisk: "none", issueStatus: "ready" });

describe("acceptance-criteria composer (#4271)", () => {
  it("re-exports the composer API from the engine barrel", () => {
    expect(typeof buildAcceptanceCriteria).toBe("function");
    expect(typeof serializeAcceptanceCriteria).toBe("function");
    expect(typeof shouldWriteAcceptanceCriteria).toBe("function");
    expect(ACCEPTANCE_CRITERIA_FILENAME).toBe("acceptance-criteria.json");
    expect(ACCEPTANCE_CRITERIA_VERSION).toBe(1);
  });

  it("composes a go-verdict document from both inputs and marks it writable", () => {
    const doc = buildAcceptanceCriteria({ promptPacket: CLEAN_PACKET, feasibility: GO });
    expect(doc.version).toBe(ACCEPTANCE_CRITERIA_VERSION);
    expect(doc.verdict).toBe("go");
    expect(doc.writable).toBe(true);
    expect(doc.taskBrief).toBe(CLEAN_PACKET.taskBrief);
    expect(doc.constraints).toBe(CLEAN_PACKET.constraints);
    expect(doc.feasibilityNotes).toBe(CLEAN_PACKET.feasibilityNotes);
    expect(doc.retrievalContext).toBe(CLEAN_PACKET.retrievalContext);
    expect(doc.feasibilitySummary).toBe(GO.summary);
    expect(doc.avoidReasons).toEqual([]);
    expect(doc.raiseReasons).toEqual([]);
  });

  it("delegates redaction to the prompt-packet scrubber (unsafe terms + local paths)", () => {
    const dirty: PromptPacket = {
      taskBrief: "Stop leaking the wallet hotkey in the payout log.",
      feasibilityNotes: "Notes live at /home/miner/notes.txt on the box.",
      retrievalContext: "Windows path C:\\Users\\miner\\ctx.md is fine to mention.",
      constraints: "Do not change the reward weighting.",
    };
    const doc = buildAcceptanceCriteria({ promptPacket: dirty, feasibility: GO });
    expect(doc.taskBrief).toBe("Stop leaking the [redacted] [redacted] in the [redacted] log.");
    expect(doc.feasibilityNotes).toBe("Notes live at <local-path> on the box.");
    expect(doc.retrievalContext).toBe("Windows path <local-path> is fine to mention.");
    expect(doc.constraints).toBe("Do not change the [redacted] weighting.");
  });

  it("marks a raise verdict non-writable and carries its raiseReasons", () => {
    const doc = buildAcceptanceCriteria({ promptPacket: CLEAN_PACKET, feasibility: RAISE });
    expect(doc.verdict).toBe("raise");
    expect(doc.writable).toBe(false);
    expect(doc.raiseReasons).toEqual(["claim_status_claimed"]);
    expect(doc.avoidReasons).toEqual([]);
  });

  it("marks an avoid verdict non-writable and carries its avoidReasons", () => {
    const doc = buildAcceptanceCriteria({ promptPacket: CLEAN_PACKET, feasibility: AVOID });
    expect(doc.verdict).toBe("avoid");
    expect(doc.writable).toBe(false);
    expect(doc.avoidReasons).toEqual(["claim_status_solved"]);
    expect(doc.raiseReasons).toEqual([]);
  });

  it("gates the write on a go verdict only", () => {
    expect(shouldWriteAcceptanceCriteria("go")).toBe(true);
    expect(shouldWriteAcceptanceCriteria("raise")).toBe(false);
    expect(shouldWriteAcceptanceCriteria("avoid")).toBe(false);
  });

  it("deep-freezes the built document so the success bar cannot be mutated mid-attempt", () => {
    const doc = buildAcceptanceCriteria({ promptPacket: CLEAN_PACKET, feasibility: AVOID });
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.avoidReasons)).toBe(true);
    expect(() => {
      (doc as { taskBrief: string }).taskBrief = "tampered";
    }).toThrow();
    expect(() => {
      (doc.avoidReasons as string[]).push("injected");
    }).toThrow();
  });

  it("serializes deterministically with a stable key order and trailing newline", () => {
    const doc = buildAcceptanceCriteria({ promptPacket: CLEAN_PACKET, feasibility: GO });
    const a = serializeAcceptanceCriteria(doc);
    const b = serializeAcceptanceCriteria(doc);
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    expect(a.startsWith('{\n  "version": 1,')).toBe(true);
    expect(JSON.parse(a)).toMatchObject({ verdict: "go", writable: true, taskBrief: CLEAN_PACKET.taskBrief });

    // Canonical order is independent of the input object's own key order.
    const shuffled: AcceptanceCriteria = {
      raiseReasons: [],
      avoidReasons: [],
      feasibilitySummary: GO.summary,
      retrievalContext: CLEAN_PACKET.retrievalContext,
      feasibilityNotes: CLEAN_PACKET.feasibilityNotes,
      constraints: CLEAN_PACKET.constraints,
      taskBrief: CLEAN_PACKET.taskBrief,
      writable: true,
      verdict: "go",
      version: ACCEPTANCE_CRITERIA_VERSION,
    };
    expect(serializeAcceptanceCriteria(shuffled)).toBe(a);
  });
});
