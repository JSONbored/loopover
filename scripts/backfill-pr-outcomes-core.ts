// Backfill missing pr_outcome rows (#8823) — PURE planning core.
//
// The webhook-only pr_outcome writer lost ground truth whenever a `pull_request.closed` delivery was never
// processed. Because the fleet export inner-joins gate_decision to pr_outcome, every affected PR fell out of
// calibration entirely — and since the losses skew toward the gate's MISTAKES (a superseded close is by
// definition a wrong close), their absence biased published accuracy upward.
//
// recordTerminalActionOutcome (src/review/outcomes-wire.ts) stops the bleeding going forward; this closes the
// historical hole. The completed terminal action in audit_events IS the ground truth: `agent.action.merge`
// means the bot merged it, `agent.action.close` means the bot closed it. Both are authoritative — GitHub
// rejects a merge the actor may not perform, and a completed close is the repository's realized decision.
//
// PURE: decides WHAT to write from rows the caller supplies. The thin IO wrapper reads/writes the ledger.

/** A completed terminal action, as read from audit_events. */
export type TerminalActionRow = {
  targetKey: string; // "owner/repo#123"
  eventType: string; // agent.action.merge | agent.action.close
  createdAt: string;
};

export type BackfillPlanEntry = {
  targetKey: string;
  project: string;
  pullNumber: number;
  decision: "merged" | "closed";
  createdAt: string;
};

export type BackfillPlan = {
  entries: BackfillPlanEntry[];
  skipped: { alreadyRecorded: number; unparseable: number; unknownAction: number };
};

/** Split "owner/repo#123" into its parts; null when the shape isn't exactly that. */
export function parseTargetKey(targetKey: string): { project: string; pullNumber: number } | null {
  const hash = targetKey.lastIndexOf("#");
  if (hash <= 0 || hash === targetKey.length - 1) return null;
  const project = targetKey.slice(0, hash);
  // Reject the legacy `project:pull_request:owner/repo#123` shape outright: those rows predate the
  // convergence cutover and the fleet export deliberately excludes them (source != 'gittensory-native').
  if (!/^[^/:\s]+\/[^/:\s]+$/.test(project)) return null;
  const pullNumber = Number(targetKey.slice(hash + 1));
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) return null;
  return { project, pullNumber };
}

/**
 * Plan the backfill: one pr_outcome per terminal-action target that has none.
 *
 * When a target somehow carries BOTH a merge and a close action (a close that later got superseded and
 * re-merged under the same number is not possible on GitHub, but a retry storm could record both), the
 * LATEST action wins — it is the one whose effect survived.
 */
export function planPrOutcomeBackfill(actions: TerminalActionRow[], alreadyRecorded: ReadonlySet<string>): BackfillPlan {
  const skipped = { alreadyRecorded: 0, unparseable: 0, unknownAction: 0 };
  const latest = new Map<string, BackfillPlanEntry>();

  for (const action of actions) {
    const decision = action.eventType === "agent.action.merge" ? "merged" : action.eventType === "agent.action.close" ? "closed" : null;
    if (decision === null) {
      skipped.unknownAction += 1;
      continue;
    }
    if (alreadyRecorded.has(action.targetKey)) {
      skipped.alreadyRecorded += 1;
      continue;
    }
    const parsed = parseTargetKey(action.targetKey);
    if (parsed === null) {
      skipped.unparseable += 1;
      continue;
    }
    const existing = latest.get(action.targetKey);
    if (existing !== undefined && existing.createdAt >= action.createdAt) continue;
    latest.set(action.targetKey, { targetKey: action.targetKey, project: parsed.project, pullNumber: parsed.pullNumber, decision, createdAt: action.createdAt });
  }

  // Deterministic order so a dry run and the real run report identically.
  const entries = [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.targetKey.localeCompare(b.targetKey));
  return { entries, skipped };
}
