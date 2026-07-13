// Per-contributor gate-decision history (#2349, PR 1 of a multi-PR epic) -- the data substrate a future
// personalized gate-prediction confidence adjustment would read. `review_audit` (migrations/0049) is
// DELIBERATELY actor-login-free for privacy (it feeds the anonymized cross-instance orb-collector export
// path); this is a SEPARATE, LOCAL-ONLY table populated from the exact same call sites as
// recordNativeGateDecision (src/review/parity-wire.ts), structurally a sibling of review_audit but keyed by
// login. See migrations/0126_contributor_gate_history.sql for the full design rationale.
//
// DESIGN NOTE -- READ BEFORE ADDING A CONSUMER: this table (and anything derived from it) must NEVER be
// rendered on any public surface -- a PR comment, a check-run body, an MCP tool response, a public dashboard,
// or any other contributor-facing output. src/signals/redaction.ts exists specifically to prevent aggregate
// per-actor accuracy/trust signals from leaking publicly; an eventual confidence-adjustment reader of this
// table must only ever feed the INTERNAL predicted-gate verdict computation, and only strictly downstream of
// that verdict's blocker determination (a personalization adjustment must never be able to flip a hard
// blocker off -- it may only narrow/widen an advisory confidence band). That consumer does not exist yet;
// this PR only writes the data.
//
// THIS TABLE IS NEVER EXPORTED. It must not be wired into exportOrbBatch (src/selfhost/orb-collector.ts) or
// any other cross-instance/fleet telemetry path -- that is the exact leak review_audit's own "no actor
// logins" design deliberately avoids, and this table exists precisely so review_audit doesn't have to.

import type { GateAction } from "./parity";
import { isParityAuditEnabled } from "./parity-wire";
import { isSelfHostedReviewRuntime } from "../selfhost/review-runtime";
import { errorMessage, nowIso } from "../utils/json";

/** The minimal env shape the recorder needs -- mirrors parity-wire.ts's own ParityRecorderEnv exactly, since
 *  this records under the identical self-hosted/parity-flag gate (see recordContributorGateDecision's doc
 *  comment for why: this is additive telemetry alongside recordNativeGateDecision, not a separate feature
 *  with its own on/off knob). */
type ContributorCalibrationEnv = {
  DB: D1Database;
  LOOPOVER_REVIEW_PARITY_AUDIT?: string | undefined;
  SELFHOST_TRANSIENT_CACHE?: NonNullable<Env["SELFHOST_TRANSIENT_CACHE"]>;
};

/**
 * Record one gittensory-native gate decision into `contributor_gate_history`, keyed by the PR author's login.
 *
 * Gated identically to {@link recordNativeGateDecision} in parity-wire.ts (same self-hosted-always-records /
 * cloud-flag-gated contract) so this is always safe to call alongside it without a separate on/off knob to
 * keep in sync. Best-effort: a write failure is swallowed (telemetry must never break gate finalization). A
 * missing/empty login records nothing -- there is no meaningful per-actor row to write without one (a deleted
 * account, a bot author with no resolvable login, etc.).
 */
export async function recordContributorGateDecision(
  env: ContributorCalibrationEnv,
  input: { login: string | null | undefined; project: string; pullNumber: number; headSha: string | null | undefined; decision: GateAction },
): Promise<void> {
  if (!isSelfHostedReviewRuntime(env) && !isParityAuditEnabled(env)) return;
  const login = input.login?.trim();
  if (!login) return;
  const project = input.project.slice(0, 200);
  const targetId = `${project}#${input.pullNumber}`;
  const source = "gittensory-native";
  try {
    // Deterministic id per (login, source, project, pr, sha) -- mirrors recordNativeGateDecision's own
    // per-commit dedup: a re-run at the SAME commit replaces its prior row, a new commit gets its own.
    await env.DB.prepare(
      `INSERT INTO contributor_gate_history (id, login, source, project, target_id, decision, head_sha, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`,
    )
      .bind(`contrib:${login}:${source}:${targetId}@${input.headSha ?? "none"}`, login, source, project, targetId, input.decision, input.headSha ?? null, nowIso())
      .run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "contributor_gate_history_record_error", project, pr: input.pullNumber, message: errorMessage(error).slice(0, 200) }));
  }
}
