// Frozen-repo snapshot builder, pure core (#9259, harness #9216, epic #8534).
//
// Scoring an arbitrary agent against realized history is only meaningful if the agent sees EXACTLY the
// repository state a maintainer saw at commit T and NOTHING that happened after it. A future-information
// leak silently inflates every score built on top — and it inflates them invisibly, because a leaked
// snapshot still produces perfectly well-formed numbers. That makes leak-proofing the deliverable of this
// module rather than a property of it, which is why the filtering is here, pure and exhaustively tested,
// instead of inline in a CLI where it would be untestable.
//
// ── WHAT IS INCLUDED, AND WHAT IS DELIBERATELY NOT ───────────────────────────────────────────────────
// INCLUDED, each filtered to its state as of `frozenAt`:
//   • openPullRequests — PRs created at or before T that were still open at T. Labels are filtered to
//     those applied at or before T; the body/title are the values as of T.
//   • openIssues — same rule.
//   • recentDecisions — gate decisions RECORDED at or before T. These are history the maintainer could
//     genuinely see, and they are what makes the task realistic rather than context-free.
//
// NOT INCLUDED, ever:
//   • Anything created after T. Not "filtered from the output" — never admitted, so a downstream bug
//     cannot reintroduce it.
//   • The OUTCOME of any included work unit. A snapshot carries the question, never the answer: an
//     open PR's eventual merge/close is exactly what the agent is being asked to predict, so a snapshot
//     that carried `state: "merged"` would not be a hard benchmark, it would be an answer key.
//   • Comments, labels, reviews, or status changes timestamped after T, even on an included record.
//
// ── THE BOUNDARY IS INCLUSIVE AT T ───────────────────────────────────────────────────────────────────
// An event AT exactly `frozenAt` is included: T is the instant the maintainer is standing at, so what
// happened at T is what they can see. Everything strictly after is the future. This is stated once, here,
// and implemented once, in `atOrBefore`, so no field can quietly disagree with another.
//
// Pure: no IO, no clock, no randomness. `scripts/frozen-repo-snapshot.ts` is the thin CLI that does the
// GitHub/DB reads and hands the raw records in. Checksum discipline mirrors `checksumCases` in
// backtest-corpus-export-core.ts exactly (canonicalize with sorted keys, JSON-stringify, sha256).

import { createHash } from "node:crypto";

export const FROZEN_REPO_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** A label with the instant it was APPLIED — the timestamp is what makes label filtering possible at all.
 *  A raw GitHub label carries no application time; the CLI derives it from the issue-events timeline. */
export type TimestampedLabel = { name: string; appliedAt: string };

/** One PR or issue as the CLI read it, with every time-varying field carrying its own timestamp. */
export type RawWorkUnitRecord = {
  /** `owner/repo#123`. */
  workUnitId: string;
  number: number;
  kind: "pull_request" | "issue";
  title: string;
  body: string;
  authorLogin: string;
  createdAt: string;
  /** When it was closed/merged, if it ever was. Present in the RAW record and deliberately dropped from
   *  the snapshot — see this module's header. Used only to decide open-at-T. */
  closedAt?: string | null | undefined;
  labels?: readonly TimestampedLabel[] | undefined;
  /** Changed file paths. A PR's file list is fixed at push time; the CLI supplies the list as of T. */
  changedPaths?: readonly string[] | undefined;
};

/** A past gate decision the maintainer could see at T. */
export type RawDecisionRecord = {
  workUnitId: string;
  action: string;
  reasonCode: string;
  decidedAt: string;
};

/** One work unit as it appears IN the snapshot. Note what is absent: no `closedAt`, no state, no outcome
 *  of any kind — the type itself refuses to carry the answer. */
export type FrozenWorkUnit = {
  workUnitId: string;
  number: number;
  kind: "pull_request" | "issue";
  title: string;
  body: string;
  authorLogin: string;
  createdAt: string;
  /** Label NAMES only, sorted — the application timestamps did their job during filtering and would
   *  otherwise be one more channel through which post-T information could travel. */
  labels: string[];
  changedPaths: string[];
};

export type FrozenDecision = { workUnitId: string; action: string; reasonCode: string; decidedAt: string };

export type FrozenRepoSnapshot = {
  schemaVersion: typeof FROZEN_REPO_SNAPSHOT_SCHEMA_VERSION;
  repoFullName: string;
  commitSha: string;
  frozenAt: string;
  openPullRequests: FrozenWorkUnit[];
  openIssues: FrozenWorkUnit[];
  recentDecisions: FrozenDecision[];
  /** sha256 over the canonicalized snapshot WITHOUT this field — so it commits to its own content and a
   *  third party can confirm two runs scored the same task. */
  snapshotChecksum: string;
};

/**
 * The single definition of "visible at T": at or before `frozenAt`, inclusive.
 *
 * An unparseable timestamp is NOT visible. That direction is deliberate and is the fail-safe one: a record
 * whose date cannot be read might be from after T, and admitting it would risk a leak, while excluding it
 * only costs a task some context. Every filter in this module routes through here, so the boundary cannot
 * drift between fields.
 */
export function atOrBefore(timestamp: string | null | undefined, frozenAt: string): boolean {
  if (!timestamp) return false;
  const at = Date.parse(timestamp);
  const cutoff = Date.parse(frozenAt);
  if (!Number.isFinite(at) || !Number.isFinite(cutoff)) return false;
  return at <= cutoff;
}

/** Was this unit still OPEN at T? Closed strictly after T means it was open at T; closed at or before T
 *  means it was already closed and is not part of the task. Never closed at all ⇒ open. */
export function wasOpenAt(record: RawWorkUnitRecord, frozenAt: string): boolean {
  if (!atOrBefore(record.createdAt, frozenAt)) return false; // not created yet at T
  if (!record.closedAt) return true;
  // Closed at or before T ⇒ not open at T. An unparseable closedAt is treated as "still open", which is
  // the safe direction here: it keeps a question in the task rather than leaking a resolution.
  const closedAt = Date.parse(record.closedAt);
  if (!Number.isFinite(closedAt)) return true;
  return closedAt > Date.parse(frozenAt);
}

/** Project one raw record onto its state at T. Labels applied after T are dropped; the outcome fields are
 *  not carried at all. Sorting makes the output canonical, which is what lets the checksum be stable. */
export function freezeWorkUnit(record: RawWorkUnitRecord, frozenAt: string): FrozenWorkUnit {
  const labels = (record.labels ?? [])
    .filter((label) => atOrBefore(label.appliedAt, frozenAt))
    .map((label) => label.name)
    .filter((name) => name.length > 0);
  return {
    workUnitId: record.workUnitId,
    number: record.number,
    kind: record.kind,
    title: record.title,
    body: record.body,
    authorLogin: record.authorLogin,
    createdAt: record.createdAt,
    labels: [...new Set(labels)].sort(),
    changedPaths: [...new Set(record.changedPaths ?? [])].sort(),
  };
}

/** Total-order fallback: compare the canonicalized JSON. Reached only when every named key ties, and it
 *  guarantees the sort is total no matter what fields the record type grows. */
function compareCanonical(a: object, b: object): number {
  const left = JSON.stringify(canonicalize(a as Record<string, unknown>));
  const right = JSON.stringify(canonicalize(b as Record<string, unknown>));
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sort key for every collection in a snapshot: the work-unit id, which is unique and stable. Sorting
 *  rather than preserving input order is what makes two builds from differently-ordered reads identical. */
function byWorkUnitId<T extends { workUnitId: string }>(a: T, b: T): number {
  return a.workUnitId < b.workUnitId ? -1 : a.workUnitId > b.workUnitId ? 1 : 0;
}

/** Canonicalize with sorted keys — mirrors backtest-corpus-export-core.ts's `canonicalizeCase`. Two-armed
 *  rather than the usual three: object keys are unique by definition, so an "equal keys" arm would be dead
 *  code that no test could ever reach. */
function canonicalize(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Deterministic SHA-256 over the canonicalized snapshot body (every field except the checksum itself).
 *
 * The committed fields are listed EXPLICITLY rather than spread from the argument. Spreading made this a
 * foot-gun: handing it a whole `FrozenRepoSnapshot` (the natural thing to do when re-verifying) silently
 * folded the existing `snapshotChecksum` into the preimage and returned a different, wrong digest with no
 * error. Naming the fields makes the function total over both shapes and makes an added field a compile
 * error here — which is the right place to notice that the commitment needs updating.
 */
export function checksumSnapshot(snapshot: Omit<FrozenRepoSnapshot, "snapshotChecksum">): string {
  const canonical = canonicalize({
    schemaVersion: snapshot.schemaVersion,
    repoFullName: snapshot.repoFullName,
    commitSha: snapshot.commitSha,
    frozenAt: snapshot.frozenAt,
    openPullRequests: snapshot.openPullRequests.map((unit) => canonicalize(unit as unknown as Record<string, unknown>)),
    openIssues: snapshot.openIssues.map((unit) => canonicalize(unit as unknown as Record<string, unknown>)),
    recentDecisions: snapshot.recentDecisions.map((decision) => canonicalize(decision as unknown as Record<string, unknown>)),
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Build a leak-proof snapshot of a repo at commit T.
 *
 * Every collection is filtered through {@link atOrBefore} and sorted, so the result is a pure function of
 * (records, frozenAt) — never of when the build ran, nor of the order the CLI happened to read records in.
 * That is the property the benchmark's reproducibility rests on, and it is asserted directly in the tests.
 */
export function buildFrozenRepoSnapshot(input: {
  repoFullName: string;
  commitSha: string;
  frozenAt: string;
  workUnits: readonly RawWorkUnitRecord[];
  decisions?: readonly RawDecisionRecord[] | undefined;
}): FrozenRepoSnapshot {
  const openAtT = input.workUnits.filter((record) => wasOpenAt(record, input.frozenAt));
  const openPullRequests = openAtT
    .filter((record) => record.kind === "pull_request")
    .map((record) => freezeWorkUnit(record, input.frozenAt))
    .sort(byWorkUnitId);
  const openIssues = openAtT
    .filter((record) => record.kind === "issue")
    .map((record) => freezeWorkUnit(record, input.frozenAt))
    .sort(byWorkUnitId);
  const recentDecisions = (input.decisions ?? [])
    .filter((decision) => atOrBefore(decision.decidedAt, input.frozenAt))
    .map((decision) => ({
      workUnitId: decision.workUnitId,
      action: decision.action,
      reasonCode: decision.reasonCode,
      decidedAt: decision.decidedAt,
    }))
    // Decisions can repeat per work unit, so the id alone is not a total order. The tie-break chain must
    // cover EVERY field, not just the obvious ones: two decisions differing only in `reasonCode` compared
    // equal under an earlier version of this sort, so their relative order followed input order and the
    // snapshot checksum moved when the CLI happened to read them the other way round -- which is exactly
    // the reproducibility property this module exists to guarantee. Comparing the canonical serialization
    // last makes the order total by construction, so adding a field to FrozenDecision cannot silently
    // reintroduce the same hole.
    .sort(
      (a, b) =>
        byWorkUnitId(a, b) ||
        (a.decidedAt < b.decidedAt ? -1 : a.decidedAt > b.decidedAt ? 1 : 0) ||
        (a.action < b.action ? -1 : a.action > b.action ? 1 : 0) ||
        compareCanonical(a, b),
    );

  const body: Omit<FrozenRepoSnapshot, "snapshotChecksum"> = {
    schemaVersion: FROZEN_REPO_SNAPSHOT_SCHEMA_VERSION,
    repoFullName: input.repoFullName,
    commitSha: input.commitSha,
    frozenAt: input.frozenAt,
    openPullRequests,
    openIssues,
    recentDecisions,
  };
  return { ...body, snapshotChecksum: checksumSnapshot(body) };
}

/** Recompute a snapshot's checksum and compare — the exact check a third party runs to confirm two runs
 *  scored the same task, exported so our tests exercise the SAME path rather than a parallel one. */
export function verifySnapshotChecksum(snapshot: FrozenRepoSnapshot): boolean {
  const { snapshotChecksum, ...body } = snapshot;
  return checksumSnapshot(body) === snapshotChecksum;
}

/**
 * Audit a built snapshot for future information — a belt-and-braces check over the builder's own output.
 *
 * The builder already excludes post-T data by construction; this re-derives the property independently, so
 * a future refactor that breaks the filtering fails loudly here instead of silently inflating scores. It
 * returns the offending paths rather than a bare boolean, because "which field leaked" is the only useful
 * form of that answer.
 */
export function auditSnapshotForLeaks(snapshot: FrozenRepoSnapshot): string[] {
  const leaks: string[] = [];
  const check = (collection: "openPullRequests" | "openIssues") => {
    for (const unit of snapshot[collection]) {
      if (!atOrBefore(unit.createdAt, snapshot.frozenAt)) leaks.push(`${collection}/${unit.workUnitId}: createdAt is after frozenAt`);
      // The snapshot type carries no outcome fields, but a hand-built or deserialized object could.
      for (const forbidden of ["closedAt", "mergedAt", "state", "merged"]) {
        if (forbidden in (unit as unknown as Record<string, unknown>)) leaks.push(`${collection}/${unit.workUnitId}: carries outcome field "${forbidden}"`);
      }
    }
  };
  check("openPullRequests");
  check("openIssues");
  for (const decision of snapshot.recentDecisions) {
    if (!atOrBefore(decision.decidedAt, snapshot.frozenAt)) leaks.push(`recentDecisions/${decision.workUnitId}: decidedAt is after frozenAt`);
  }
  return leaks;
}
