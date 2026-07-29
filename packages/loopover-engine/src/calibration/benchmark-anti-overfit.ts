// Anti-overfit controls for the public benchmark (#9263, harness #9216, epic #8534).
//
// A public leaderboard creates a direct incentive to overfit, and an overfit agent is worse than useless: it
// looks best exactly when it generalizes worst. The internal backtest gate already enforces this discipline;
// this module applies the same controls to EXTERNAL submissions, plus the ones only an adversarial public
// benchmark needs. Every knob below is one an adversary optimizes against, so each carries its reasoning
// rather than a bare value.
//
// ── DECISION 1: SPLIT GRANULARITY IS THE REPO, NOT THE WORK UNIT ──────────────────────────────────────
// The split reuses `splitBacktestCorpus` verbatim (requirement 1 — no second split mechanism), but the key
// it splits on is the REPO, so every work unit belonging to a repo lands in the same slice. Work-unit-level
// splitting leaks badly: two PRs in the same repo share a maintainer, a review culture, a CI setup and often
// the same files, so an agent that saw repo A's visible PRs has effectively seen the answer pattern for repo
// A's held-out PRs. Splitting per repo is what makes "held out" mean "generalizes to a repo it has never
// seen" — which is the property actually worth measuring, and the one #9216 requirement 3 names.
//
// ── DECISION 2: HELD-OUT SCORES ARE NOT PUBLISHED PER SUBMISSION ─────────────────────────────────────
// A leaderboard that reports a held-out score on every attempt converts the held-out set into a visible set
// within a few dozen submissions: each score is an oracle query, and differencing successive scores recovers
// per-unit membership. Held-out results publish on a fixed cadence or at evaluation close, never on demand;
// `heldOutPublicationDecision` is the single place that rule is decided, and #9265's emitter is where it is
// enforced, so a leaderboard cannot leak membership by accident.
//
// ── DECISION 3: SUBMISSION CAP PER (AGENT, WINDOW) ───────────────────────────────────────────────────
// Unbounded resubmission against a fixed corpus is gradient descent on the test set by brute force — with
// enough attempts a random-search agent tops the board having learned nothing. The cap is per (agent,
// benchmark window) rather than global or per-day: a per-day cap just spreads the same brute force over more
// days, and a global cap would punish an agent that keeps competing across rotations.
//
// ── DECISION 4: ROTATION RETIRES A WINDOW, IT DOES NOT EXTEND IT ─────────────────────────────────────
// A benchmark public for a year is not a test set any more — it is training data with extra steps. A window
// has a fixed evaluation close; after it, the snapshot is RETIRED and a fresh one takes over. Retired
// windows stay published for historical comparison but stop being the scoring basis, which is exactly the
// distinction that keeps an old leaderboard honest instead of quietly authoritative.
//
// Same purity contract as the rest of this module family: no IO, no randomness, no wall-clock reads — the
// caller supplies `now` wherever a time comparison is needed, so every decision here is reproducible.

import type { BacktestCase } from "./backtest-corpus.js";
import { splitBacktestCorpus } from "./backtest-split.js";

/** Default share of REPOS (not work units — see decision 1) withheld from the visible slice. */
export const DEFAULT_HELD_OUT_FRACTION = 0.25;

/** Default submissions permitted per (agent, benchmark window). See decision 3 for why the cap is scoped
 *  this way; the value itself is deliberately generous enough for honest iteration and far too small for
 *  brute-force search over a fixed corpus. */
export const DEFAULT_SUBMISSION_CAP = 20;

export type BenchmarkSplitPolicy = {
  /** Unguessable without knowing it; identical across runs. Never published while a window is open. */
  splitSeed: string;
  heldOutFraction: number;
};

export type BenchmarkWorkUnitRef = {
  workUnitId: string;
  /** `owner/repo` — the split key (decision 1). */
  repoFullName: string;
};

/**
 * Partition work units into visible and held-out slices at REPO granularity, through the shared
 * `splitBacktestCorpus` primitive.
 *
 * The reuse is literal: one synthetic case per distinct repo, with the repo in the `targetKey` slot, so the
 * assignment digest is byte-identically the one the internal backtest split already computes. A repo's
 * assignment therefore depends only on (seed, benchmarkId, repo) — never on corpus size or ordering — so a
 * benchmark that grows over time never reshuffles which repos were already held out.
 */
export function splitBenchmarkWorkUnits(
  benchmarkId: string,
  workUnits: readonly BenchmarkWorkUnitRef[],
  policy: BenchmarkSplitPolicy,
): { visible: BenchmarkWorkUnitRef[]; heldOut: BenchmarkWorkUnitRef[]; heldOutRepoCount: number; visibleRepoCount: number } {
  const repos = [...new Set(workUnits.map((unit) => unit.repoFullName))];
  const repoCases: BacktestCase[] = repos.map((repoFullName) => ({
    ruleId: benchmarkId,
    targetKey: repoFullName,
    outcome: "repo",
    label: "confirmed",
    firedAt: "",
    decidedAt: "",
  }));
  const split = splitBacktestCorpus(repoCases, policy.heldOutFraction, policy.splitSeed);
  const heldOutRepos = new Set(split.heldOut.map((repoCase) => repoCase.targetKey));
  const visible: BenchmarkWorkUnitRef[] = [];
  const heldOut: BenchmarkWorkUnitRef[] = [];
  for (const unit of workUnits) {
    if (heldOutRepos.has(unit.repoFullName)) heldOut.push(unit);
    else visible.push(unit);
  }
  return { visible, heldOut, heldOutRepoCount: heldOutRepos.size, visibleRepoCount: repos.length - heldOutRepos.size };
}

export type BenchmarkWindow = {
  benchmarkId: string;
  snapshotRef: string;
  opensAt: string;
  /** Inclusive evaluation close. After this the window is RETIRED (decision 4), not extended. */
  closesAt: string;
  /** Held-out scores may also publish periodically before close; 0/absent means "at close only". */
  heldOutPublishEveryDays?: number | undefined;
};

export type BenchmarkWindowState = "pending" | "open" | "retired";

/** Where `now` sits relative to a window. A retired window stays readable for historical comparison but is
 *  no longer a scoring basis — the caller enforces that by refusing submissions (below). */
export function benchmarkWindowState(window: BenchmarkWindow, now: string): BenchmarkWindowState {
  const at = Date.parse(now);
  if (at < Date.parse(window.opensAt)) return "pending";
  return at > Date.parse(window.closesAt) ? "retired" : "open";
}

export type SubmissionDecision =
  | { accepted: true; submissionIndex: number; remaining: number }
  | { accepted: false; reason: "window_not_open" | "window_retired" | "cap_reached"; remaining: number };

/**
 * Decide whether one more submission from this agent is admissible.
 *
 * PURE and total: it never throws for ordinarily-invalid input, and the refusal reason is NAMED so a
 * submitter learns which control stopped them (a cap they can wait out, versus a window that will never
 * reopen) rather than seeing an opaque rejection.
 */
export function decideSubmission(input: {
  window: BenchmarkWindow;
  now: string;
  /** Submissions this agent has already made against THIS window. */
  priorSubmissions: number;
  cap?: number | undefined;
}): SubmissionDecision {
  const cap = input.cap ?? DEFAULT_SUBMISSION_CAP;
  const remaining = Math.max(0, cap - input.priorSubmissions);
  const state = benchmarkWindowState(input.window, input.now);
  if (state === "pending") return { accepted: false, reason: "window_not_open", remaining };
  if (state === "retired") return { accepted: false, reason: "window_retired", remaining };
  if (remaining <= 0) return { accepted: false, reason: "cap_reached", remaining: 0 };
  return { accepted: true, submissionIndex: input.priorSubmissions + 1, remaining: remaining - 1 };
}

export type HeldOutPublicationDecision =
  | { publish: true; reason: "evaluation_closed" | "scheduled_cadence" }
  | { publish: false; reason: "window_open_between_cadences" | "window_not_open" };

/**
 * Decide whether held-out scores may be published right now (decision 2).
 *
 * At or after close, always — the window is over and there is nothing left to leak into. Before close, only
 * on the configured cadence boundary, counted in whole periods since `opensAt`, so the publication instants
 * are a fixed public schedule rather than something a submitter can trigger by submitting.
 */
export function heldOutPublicationDecision(window: BenchmarkWindow, now: string): HeldOutPublicationDecision {
  const state = benchmarkWindowState(window, now);
  if (state === "pending") return { publish: false, reason: "window_not_open" };
  if (state === "retired") return { publish: true, reason: "evaluation_closed" };
  const everyDays = window.heldOutPublishEveryDays ?? 0;
  if (everyDays <= 0) return { publish: false, reason: "window_open_between_cadences" };
  const elapsedMs = Date.parse(now) - Date.parse(window.opensAt);
  const periodMs = everyDays * 24 * 60 * 60 * 1000;
  // A boundary instant publishes; anything strictly between boundaries does not.
  return elapsedMs > 0 && elapsedMs % periodMs === 0
    ? { publish: true, reason: "scheduled_cadence" }
    : { publish: false, reason: "window_open_between_cadences" };
}

/** What a leaderboard is allowed to show for one submission while its window is open. */
export type PublishableScores<T> = {
  visible: T;
  /** Present ONLY when {@link heldOutPublicationDecision} allowed it. `null` is the honest "not published
   *  yet", and carries no count, no fraction and no per-unit membership — anything derived from the
   *  held-out slice is an oracle query, so the shape itself refuses to answer one. */
  heldOut: T | null;
  heldOutPublication: HeldOutPublicationDecision;
};

/**
 * Gate a scored pair through the publication policy.
 *
 * The held-out score is DROPPED, not merely hidden behind a flag: a caller cannot forget to check the flag
 * and serialize a field that is present in memory. That is the difference between a policy and a habit.
 */
export function gateHeldOutPublication<T>(
  window: BenchmarkWindow,
  now: string,
  scores: { visible: T; heldOut: T },
): PublishableScores<T> {
  const decision = heldOutPublicationDecision(window, now);
  return {
    visible: scores.visible,
    heldOut: decision.publish ? scores.heldOut : null,
    heldOutPublication: decision,
  };
}
