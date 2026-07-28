// Maintainer action-space schema + proposal validator (#9260, harness #9216, epic #8534).
//
// The frozen-repo benchmark's task format: a candidate agent looks at a repo frozen at commit T and proposes
// the action it expects the maintainer to take on each work unit within the task's horizon. Without a CLOSED,
// validated action space, two agents' outputs are not comparable and the scorer has nothing stable to score
// against — so the action set here is closed by construction (an unrecognized action is a validation ERROR,
// never a silently-ignored or zero-scored entry), per-action parameters are typed (parameters that do not
// apply to an action are rejected as unknown keys), and abstention is FIRST-CLASS: declining to predict a
// work unit is recorded and feeds the coverage metric in #9215's scoring semantics, so a precise-but-narrow
// agent stays distinguishable from a broad-but-noisy one.
//
// The prediction horizon is deliberately NOT a proposal field: it is part of the TASK (`BenchmarkTask`,
// fixed per benchmark), so an agent cannot pick a horizon that flatters its answer. A proposal echoes the
// task's identity (`benchmarkId` + `snapshotRef` + `workUnitId`) so a submission cannot be replayed against
// a different snapshot or benchmark.
//
// Same purity contract and validator shape as `validateAttestationEnvelope` in ./attestation-envelope.ts —
// pure, never throws for ordinarily-invalid input, one error per failing field path, unknown keys rejected
// rather than ignored. Public (engine barrel) so a candidate agent author validates locally before
// submitting, against the exact code the harness runs.

/** The closed maintainer action set. Closed, not extensible-by-string: the scorer's ground-truth classes
 *  (#9261's realized-history outcomes) are exactly these, so an open set would let an agent emit classes the
 *  scorer cannot compare. */
export type BenchmarkActionKind = "merge" | "close" | "request_changes" | "label" | "hold";

/** Why a close is predicted — the class, not free text, because realized history grades the CLASS. Aligned
 *  with the reason families the gate itself distinguishes; a benchmark bump to this list is a schemaVersion
 *  bump, never an in-place widening. */
export type BenchmarkCloseReasonClass = "defective" | "duplicate" | "spam" | "stale" | "out_of_scope";

/** One proposed maintainer action with its typed, per-action parameters. `merge` and `hold` carry none. */
export type BenchmarkAction =
  | { kind: "merge" }
  | { kind: "hold" }
  | { kind: "close"; reasonClass: BenchmarkCloseReasonClass }
  | { kind: "request_changes"; blockingConcern: string }
  | { kind: "label"; labels: string[] };

/** An agent's answer for ONE work unit: either a concrete action, or a first-class abstention. */
export type BenchmarkPrediction = { kind: "abstain" } | { kind: "act"; action: BenchmarkAction };

/** The task side of the contract: what the harness publishes for agents to answer. The horizon lives HERE —
 *  "the action the maintainer takes within `horizonDays` of the snapshot's frozen instant" — never on the
 *  proposal, so every agent answers the same question. */
export type BenchmarkTask = {
  schemaVersion: 1;
  benchmarkId: string;
  /** Content-addressed reference to the frozen snapshot (#9259's builder output) — 64 lowercase hex. */
  snapshotRef: string;
  /** The work unit inside the snapshot, e.g. "owner/repo#123". */
  workUnitId: string;
  /** Fixed per benchmark; a proposal is scored against what the maintainer actually did within this many
   *  days of the frozen instant (#9261's reversal-aware outcome rules). */
  horizonDays: number;
  /** The snapshot's frozen instant, ISO-8601 — the horizon's t=0. */
  frozenAt: string;
};

/** One agent's proposal for one work unit. Echoes the task identity so it cannot be replayed elsewhere. */
export type BenchmarkProposal = {
  schemaVersion: 1;
  benchmarkId: string;
  snapshotRef: string;
  workUnitId: string;
  /** WHO proposes — opaque to LoopOver, exactly like EvalScoreRecord.subject (#9215 §1): an SS58 address, a
   *  pubkey, whatever the consumer keys on. Identity policy stays entirely subnet-side. */
  subject: { kind: "agent"; id: string };
  prediction: BenchmarkPrediction;
};

const ACTION_KINDS: readonly string[] = ["merge", "close", "request_changes", "label", "hold"];
const CLOSE_REASON_CLASSES: readonly string[] = ["defective", "duplicate", "spam", "stale", "out_of_scope"];
const BENCHMARK_ID_MAX = 128;
const WORK_UNIT_ID_MAX = 256;
const SUBJECT_ID_MAX = 256;
const BLOCKING_CONCERN_MAX = 500;
const LABELS_MAX = 20;
const LABEL_MAX = 100;
const HORIZON_DAYS_MAX = 365;
const SNAPSHOT_REF = /^[0-9a-f]{64}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const TASK_KEYS: readonly string[] = ["schemaVersion", "benchmarkId", "snapshotRef", "workUnitId", "horizonDays", "frozenAt"];
const PROPOSAL_KEYS: readonly string[] = ["schemaVersion", "benchmarkId", "snapshotRef", "workUnitId", "subject", "prediction"];
const SUBJECT_KEYS: readonly string[] = ["kind", "id"];
/** Exactly the keys each action kind may carry — the mechanism behind "parameters that do not apply to the
 *  action are a validation error": `{kind: "merge", labels: [...]}` fails on `labels: unexpected key`. */
const ACTION_KEYS: Record<BenchmarkActionKind, readonly string[]> = {
  merge: ["kind"],
  hold: ["kind"],
  close: ["kind", "reasonClass"],
  request_changes: ["kind", "blockingConcern"],
  label: ["kind", "labels"],
};

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The identity fields the task and the proposal SHARE — one implementation so they cannot drift. */
function validateTaskIdentity(record: Record<string, unknown>, errors: string[]): void {
  const benchmarkId = record["benchmarkId"];
  if (!nonEmptyString(benchmarkId) || benchmarkId.length > BENCHMARK_ID_MAX) {
    errors.push(`benchmarkId: expected a non-empty string of at most ${BENCHMARK_ID_MAX} characters`);
  }
  const snapshotRef = record["snapshotRef"];
  if (typeof snapshotRef !== "string" || !SNAPSHOT_REF.test(snapshotRef)) {
    errors.push("snapshotRef: expected 64 lowercase hex characters");
  }
  const workUnitId = record["workUnitId"];
  if (!nonEmptyString(workUnitId) || workUnitId.length > WORK_UNIT_ID_MAX) {
    errors.push(`workUnitId: expected a non-empty string of at most ${WORK_UNIT_ID_MAX} characters`);
  }
}

function validateAction(value: unknown, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push("prediction.action: expected an object");
    return;
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !ACTION_KINDS.includes(kind)) {
    errors.push(`prediction.action.kind: expected one of ${ACTION_KINDS.join(", ")}`);
    return;
  }
  const allowed = ACTION_KEYS[kind as BenchmarkActionKind];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`prediction.action.${key}: unexpected key for action "${kind}"`);
  }
  if (kind === "close") {
    const reasonClass = value["reasonClass"];
    if (typeof reasonClass !== "string" || !CLOSE_REASON_CLASSES.includes(reasonClass)) {
      errors.push(`prediction.action.reasonClass: expected one of ${CLOSE_REASON_CLASSES.join(", ")}`);
    }
  }
  if (kind === "request_changes") {
    const blockingConcern = value["blockingConcern"];
    if (!nonEmptyString(blockingConcern) || blockingConcern.trim().length === 0 || blockingConcern.length > BLOCKING_CONCERN_MAX) {
      errors.push(`prediction.action.blockingConcern: expected a non-blank string of at most ${BLOCKING_CONCERN_MAX} characters`);
    }
  }
  if (kind === "label") {
    const labels = value["labels"];
    if (!Array.isArray(labels) || labels.length === 0 || labels.length > LABELS_MAX) {
      errors.push(`prediction.action.labels: expected 1-${LABELS_MAX} labels`);
      return;
    }
    const seen = new Set<string>();
    for (let index = 0; index < labels.length; index += 1) {
      const label: unknown = labels[index];
      if (!nonEmptyString(label) || label.trim().length === 0 || label.length > LABEL_MAX) {
        errors.push(`prediction.action.labels[${index}]: expected a non-blank string of at most ${LABEL_MAX} characters`);
        continue;
      }
      if (seen.has(label)) errors.push(`prediction.action.labels[${index}]: duplicate label "${label}"`);
      seen.add(label);
    }
  }
}

function validatePrediction(value: unknown, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push("prediction: expected an object");
    return;
  }
  const kind = value["kind"];
  if (kind !== "abstain" && kind !== "act") {
    errors.push('prediction.kind: expected "abstain" or "act"');
    return;
  }
  const allowed = kind === "abstain" ? ["kind"] : ["kind", "action"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`prediction.${key}: unexpected key`);
  }
  if (kind === "act") validateAction(value["action"], errors);
}

/**
 * Structurally validate an unknown value as a {@link BenchmarkTask}. Same contract as
 * {@link validateBenchmarkProposal} below (and `validateAttestationEnvelope` before both): pure, never
 * throws, one error per failing field path, unknown keys rejected.
 */
export function validateBenchmarkTask(value: unknown): { valid: true; task: BenchmarkTask } | { valid: false; errors: string[] } {
  if (!isPlainObject(value)) return { valid: false, errors: ["task: expected an object"] };
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!TASK_KEYS.includes(key)) errors.push(`${key}: unexpected key`);
  }
  if (value["schemaVersion"] !== 1) errors.push("schemaVersion: expected the literal 1");
  validateTaskIdentity(value, errors);
  const horizonDays = value["horizonDays"];
  if (typeof horizonDays !== "number" || !Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > HORIZON_DAYS_MAX) {
    errors.push(`horizonDays: expected an integer in [1, ${HORIZON_DAYS_MAX}]`);
  }
  const frozenAt = value["frozenAt"];
  if (!nonEmptyString(frozenAt) || !ISO_DATETIME.test(frozenAt) || Number.isNaN(Date.parse(frozenAt))) {
    errors.push("frozenAt: expected an ISO-8601 datetime string");
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, task: value as BenchmarkTask };
}

/**
 * Structurally validate an unknown value as a {@link BenchmarkProposal} — the exact acceptance boundary any
 * candidate agent's output crosses. Never throws for ANY input; every rejection names the failing field
 * path, so an agent author can fix their emitter from the error list alone. Extra keys are rejected rather
 * than ignored: a parameter that does not apply to the chosen action (or a field this schema version does
 * not define) must fail loudly, never be silently dropped into an answer the scorer grades differently than
 * the agent intended.
 */
export function validateBenchmarkProposal(
  value: unknown,
): { valid: true; proposal: BenchmarkProposal } | { valid: false; errors: string[] } {
  if (!isPlainObject(value)) return { valid: false, errors: ["proposal: expected an object"] };
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!PROPOSAL_KEYS.includes(key)) errors.push(`${key}: unexpected key`);
  }
  if (value["schemaVersion"] !== 1) errors.push("schemaVersion: expected the literal 1");
  validateTaskIdentity(value, errors);

  const subject = value["subject"];
  if (!isPlainObject(subject)) {
    errors.push("subject: expected an object");
  } else {
    for (const key of Object.keys(subject)) {
      if (!SUBJECT_KEYS.includes(key)) errors.push(`subject.${key}: unexpected key`);
    }
    if (subject["kind"] !== "agent") errors.push('subject.kind: expected "agent"');
    const id = subject["id"];
    if (!nonEmptyString(id) || id.length > SUBJECT_ID_MAX) {
      errors.push(`subject.id: expected a non-empty string of at most ${SUBJECT_ID_MAX} characters`);
    }
  }

  validatePrediction(value["prediction"], errors);

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, proposal: value as BenchmarkProposal };
}
