import { sanitizePromptPacketField, type PromptPacket } from "../prompt-packet.js";
import type { FeasibilityGateResult, FeasibilityVerdict } from "../feasibility.js";

// Acceptance-criteria composer (#4271). Before a coding-agent driver (#4262's interface; #4266/#4267's
// implementations) starts editing, the miner pins down — immutably, so the agent cannot quietly redefine its own
// success bar mid-attempt — what "done" means for this attempt. This module is the pure composition step: it folds
// the two already-shipped Phase 2 primitives — the sanitized `PromptPacket` (prompt-packet.ts, the analyze→coding-
// agent "boundary membrane") and the `FeasibilityGateResult` go/raise/avoid verdict (feasibility.ts) — into one
// document. Producing the document is this module's job; actually writing it into the attempt's worktree is the
// worktree primitive's (#4269), and handing it to the driver is the driver interface's (#4262) — neither is here,
// so this stays pure and side-effect-free like the rest of gittensory-engine.
//
// DECISIONS this file makes (per the issue's open questions):
// - Serialization format: JSON, not markdown. The acceptance criteria are an immutable, checksum-verifiable success
//   bar consumed by tooling (a self-review step must be able to prove the target did not move across iterations), so
//   a deterministic, canonically-ordered JSON document beats prose. `serializeAcceptanceCriteria` emits stable-key-
//   order JSON with a trailing newline so a checksum recorded alongside stays byte-stable.
// - Filename: a single fixed name, `ACCEPTANCE_CRITERIA_FILENAME`.
// - Immutability: the built document is deep-frozen (`Object.freeze`, arrays copied+frozen) so it cannot be mutated
//   in-memory for the lifetime of the attempt; the byte-stable serialization is what a caller checksums on disk.
// - Written only on `go`: a `raise`/`avoid` verdict means the attempt should not start, so no criteria file is
//   written. The builder still returns a document (with `writable: false`) so a caller can log *why* it was skipped;
//   `shouldWriteAcceptanceCriteria` is the gate for the write itself.
//
// Redaction is delegated to `sanitizePromptPacketField` rather than re-implemented: this document is exactly as
// exposed to a prompt-injectable coding-agent session as the prompt packet, so it gets the same scrub (idempotent
// on already-sanitized packet text).

/** Fixed on-disk filename for the per-attempt acceptance-criteria document written into the attempt worktree. */
export const ACCEPTANCE_CRITERIA_FILENAME = "acceptance-criteria.json";

/** Schema version of the serialized document; bump on any field-shape change. */
export const ACCEPTANCE_CRITERIA_VERSION = 1;

/** Inputs to the composer: the sanitized prompt packet and the feasibility verdict for this attempt. */
export type AcceptanceCriteriaInput = {
  promptPacket: PromptPacket;
  feasibility: FeasibilityGateResult;
};

/** The composed, immutable per-attempt success bar. All fields are read-only; the document is frozen once built. */
export type AcceptanceCriteria = {
  readonly version: number;
  readonly verdict: FeasibilityVerdict;
  /** Whether this attempt is authorized to start (and therefore the file should be written): `verdict === "go"`. */
  readonly writable: boolean;
  readonly taskBrief: string;
  readonly constraints: string;
  readonly feasibilityNotes: string;
  readonly retrievalContext: string;
  readonly feasibilitySummary: string;
  readonly avoidReasons: readonly string[];
  readonly raiseReasons: readonly string[];
};

/**
 * Only a `go` feasibility verdict authorizes the attempt to start, so only `go` gets an acceptance-criteria file
 * written to the worktree. `raise`/`avoid` should be handled upstream (the attempt does not begin) — this predicate
 * is the single source of truth for that gate.
 */
export function shouldWriteAcceptanceCriteria(verdict: FeasibilityVerdict): boolean {
  return verdict === "go";
}

/**
 * Pure builder: compose a {@link PromptPacket} and a {@link FeasibilityGateResult} into one immutable
 * acceptance-criteria document. Text fields are re-sanitized with {@link sanitizePromptPacketField} (idempotent),
 * and the returned document is deep-frozen so it cannot be mutated for the lifetime of the attempt.
 */
export function buildAcceptanceCriteria(input: AcceptanceCriteriaInput): AcceptanceCriteria {
  const { promptPacket, feasibility } = input;
  return Object.freeze({
    version: ACCEPTANCE_CRITERIA_VERSION,
    verdict: feasibility.verdict,
    writable: shouldWriteAcceptanceCriteria(feasibility.verdict),
    taskBrief: sanitizePromptPacketField(promptPacket.taskBrief),
    constraints: sanitizePromptPacketField(promptPacket.constraints),
    feasibilityNotes: sanitizePromptPacketField(promptPacket.feasibilityNotes),
    retrievalContext: sanitizePromptPacketField(promptPacket.retrievalContext),
    feasibilitySummary: feasibility.summary,
    avoidReasons: Object.freeze([...feasibility.avoidReasons]),
    raiseReasons: Object.freeze([...feasibility.raiseReasons]),
  });
}

/**
 * Deterministic canonical JSON serialization of a built document: fixed key order (independent of the input
 * object's own key order) plus a trailing newline, so a checksum recorded alongside the file stays byte-stable
 * across processes. `JSON.parse` round-trips it back to the same field values.
 */
export function serializeAcceptanceCriteria(doc: AcceptanceCriteria): string {
  const ordered = {
    version: doc.version,
    verdict: doc.verdict,
    writable: doc.writable,
    taskBrief: doc.taskBrief,
    constraints: doc.constraints,
    feasibilityNotes: doc.feasibilityNotes,
    retrievalContext: doc.retrievalContext,
    feasibilitySummary: doc.feasibilitySummary,
    avoidReasons: [...doc.avoidReasons],
    raiseReasons: [...doc.raiseReasons],
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
