// APR (auto-provisioned repo) transfer-to-customer initiation (#7638, decision #7590). An APR repo is created
// under a loopover-controlled GitHub org (#7637) and can later be transferred, on explicit customer request, to
// the customer's own account via GitHub's standard repository-transfer flow.
//
// Initiation (#7638) lives here; the customer-facing request gate (#7742) does too. Detecting when a pending
// transfer is accepted or expires (#7741) remains out of scope. No provisioning or repo-creation logic lives
// here. Transfer is NEVER offered or nudged proactively in v1 — request-only, and only once a TRUSTED
// server-side idea-completion signal (#7591) says the task-graph is done. Callers must NEVER supply that
// boolean over the wire; {@link loadAprIdeaCompletion} is the sole source, and it fail-closes until #7664
// persists a completion record.

import { upsertRepositorySettings } from "../db/repositories";
import { createInstallationToken } from "../github/app";
import { githubHeaders, timeoutFetch } from "../github/client";
import { loadAprIdeaCompletion, type AprIdeaCompletionLookup } from "./apr-idea-completion";
// `Env` is the ambient Cloudflare Worker binding interface (worker-configuration.d.ts) — a global, not imported.

export type { AprIdeaCompletionLookup, AprIdeaCompletionLookupInput } from "./apr-idea-completion";
export { loadAprIdeaCompletion } from "./apr-idea-completion";

/**
 * Result of initiating an APR repo transfer.
 *
 * IMPORTANT: `initiated: true` means GitHub ACCEPTED the transfer request, NOT that the transfer is complete.
 * GitHub's transfer flow is asynchronous and acceptance-gated — the recipient must accept via a confirmation
 * email within a time window — so the repo does not actually move when this call returns. Anything built on top
 * of this must treat a successful result as "transfer pending", never "transfer done".
 */
export type AprRepoTransferResult =
  | { initiated: true; status: number; newFullName: string | null }
  | { initiated: false; status: number; error: string };

/**
 * #7742 policy gate: a transfer may be requested only after the idea's completion signal (#7591) is true.
 * Plan/payment tiers are deliberately NOT consulted — this stays clear of the billing track. Pure: no IO.
 * The boolean MUST come from {@link loadAprIdeaCompletion} (or a test double of it), never from a client body.
 */
export type AprRepoTransferRequestEligibility =
  | { allowed: true }
  | { allowed: false; reason: "idea_not_complete" };

export type RequestAprRepoTransferInput = {
  installationId: number;
  repoFullName: string;
  newOwner: string;
  ideaId?: string | undefined;
};

/**
 * Outcome of a customer-initiated transfer request (#7742).
 *
 * - `rejected` — the completion gate blocked the call; GitHub was never contacted.
 * - `initiated` / `failed` — the gate passed and {@link initiateAprRepoTransfer} ran; `initiated` still means
 *   GitHub accepted a *pending* transfer (see {@link AprRepoTransferResult}), never "transfer done".
 */
export type RequestAprRepoTransferResult =
  | { status: "rejected"; reason: "idea_not_complete" }
  | { status: "initiated"; transfer: Extract<AprRepoTransferResult, { initiated: true }> }
  | { status: "failed"; transfer: Extract<AprRepoTransferResult, { initiated: false }> };

/** Decide whether a customer may request an APR repo transfer right now (#7742). Pure and deterministic. */
export function evaluateAprRepoTransferRequestEligibility(input: {
  ideaComplete: boolean;
}): AprRepoTransferRequestEligibility {
  if (input.ideaComplete !== true) return { allowed: false, reason: "idea_not_complete" };
  return { allowed: true };
}

/**
 * Initiate a transfer of `repoFullName` (a loopover-org APR repo, `owner/name`) to the GitHub account `newOwner`,
 * using the App installation token — the same token source as APR repo creation (#7637).
 *
 * Calls GitHub's `POST /repos/{owner}/{repo}/transfer` with `new_owner`. Returns the initiation outcome WITHOUT
 * throwing on an API error (a non-existent target account, or missing admin access to the repo, come back as a
 * structured `{ initiated: false }` result), so callers get a total function they can branch on. A successful
 * result models the transfer as INITIATED, not complete — see {@link AprRepoTransferResult}.
 *
 * Prefer {@link requestAprRepoTransfer} for the customer-facing path — it applies the #7742 completion gate
 * before calling this. Direct callers are for tests / internal seams that already enforced the gate.
 */
export async function initiateAprRepoTransfer(
  env: Env,
  installationId: number,
  repoFullName: string,
  newOwner: string,
): Promise<AprRepoTransferResult> {
  const token = await createInstallationToken(env, installationId);
  const response = await timeoutFetch(`https://api.github.com/repos/${repoFullName}/transfer`, {
    method: "POST",
    headers: githubHeaders({ token, json: true }),
    body: JSON.stringify({ new_owner: newOwner }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { initiated: false, status: response.status, error: detail.slice(0, 200) || `transfer request failed (${response.status})` };
  }
  // GitHub returns 202 Accepted with the repository object; `full_name` reflects the pending destination path.
  const payload = (await response.json().catch(() => null)) as { full_name?: string } | null;
  return { initiated: true, status: response.status, newFullName: payload?.full_name ?? null };
}

/**
 * Customer-facing "request transfer" action (#7742): resolve idea completion via a trusted server lookup
 * ({@link loadAprIdeaCompletion}), gate on that result, then call {@link initiateAprRepoTransfer}. Never
 * initiates when incomplete — and nothing in this module (or its REST mirror) auto-offers or nudges a transfer,
 * or accepts a client-supplied completion boolean.
 */
export async function requestAprRepoTransfer(
  env: Env,
  input: RequestAprRepoTransferInput,
  options: {
    initiate?: (
      env: Env,
      installationId: number,
      repoFullName: string,
      newOwner: string,
    ) => Promise<AprRepoTransferResult>;
    loadCompletion?: AprIdeaCompletionLookup;
    /** #7741 deliverable 2 seam: how to freeze AMS dispatch once a transfer is pending. Injectable for tests. */
    pauseDispatch?: (env: Env, repoFullName: string) => Promise<void>;
  } = {},
): Promise<RequestAprRepoTransferResult> {
  const loadCompletion = options.loadCompletion ?? loadAprIdeaCompletion;
  const { ideaComplete } = await loadCompletion(env, { repoFullName: input.repoFullName, ideaId: input.ideaId });
  const eligibility = evaluateAprRepoTransferRequestEligibility({ ideaComplete });
  if (!eligibility.allowed) return { status: "rejected", reason: eligibility.reason };

  const initiate = options.initiate ?? initiateAprRepoTransfer;
  const transfer = await initiate(env, input.installationId, input.repoFullName, input.newOwner);
  if (transfer.initiated) {
    // #7741 deliverable 2: a pending transfer is acceptance-gated and asynchronous, so freeze AMS dispatch for
    // the source repo the instant GitHub accepts the request — reusing the EXISTING per-repo `agentPaused`
    // kill-switch, not a new mechanism. The scheduled poll ({@link pollPendingAprRepoTransfers}) resumes it once
    // the transfer is accepted-and-still-installed, or expires/declines.
    const pauseDispatch = options.pauseDispatch ?? ((e, r) => setAprRepoDispatchPaused(e, r, true));
    await pauseDispatch(env, input.repoFullName);
    return { status: "initiated", transfer };
  }
  return { status: "failed", transfer };
}

// ---------------------------------------------------------------------------------------------------------------
// #7741: detect whether a PENDING transfer was accepted, declined, or expired, and reconcile the per-repo pause.
//
// GitHub repo transfers are asynchronous + acceptance-gated (see {@link AprRepoTransferResult}), so a
// scheduled poll — NOT a webhook (design ratified in #7741) — reconciles each pending transfer. All IO (the
// GitHub probe, the clock, the pending-transfer store, the pause toggle) is INJECTED so the detection/expiry
// logic is unit-testable without the live cron; the cron itself only wires these real dependencies together.
// ---------------------------------------------------------------------------------------------------------------

/**
 * A pending APR repo transfer the scheduled poll must resolve (#7741). Persisting these rows is a separate
 * concern (#7664 completion/record store); this module only needs what it takes to probe GitHub and time out.
 */
export type PendingAprRepoTransfer = {
  /** The loopover-org path (`owner/name`) the transfer was initiated FROM. */
  repoFullName: string;
  /** The GitHub account the repo is moving TO. */
  newOwner: string;
  /** Installation whose App token can read the repo — the same token source as initiation. */
  installationId: number;
  /** Epoch-ms when {@link initiateAprRepoTransfer} accepted the pending transfer. */
  initiatedAt: number;
};

/** What a single GitHub repo-probe reveals about a pending transfer (#7741). */
export type AprRepoTransferProbe =
  | { state: "resolved_under_target" } // the repo now resolves under `newOwner` — accepted.
  | { state: "access_departed" } // the App's access 404s, consistent with ownership having moved — accepted-and-departed.
  | { state: "pending" }; // still under the original owner (or a transient error) — keep waiting.

/** Outcomes of a pending transfer (#7741). Everything except `pending` is terminal. */
export type AprRepoTransferOutcome = "accepted" | "accepted_departed" | "expired" | "pending";
export type TerminalAprRepoTransferOutcome = Exclude<AprRepoTransferOutcome, "pending">;

/** A pending transfer that neither resolves nor departs within this window (from initiation) is expired (#7741). */
export const APR_REPO_TRANSFER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Default-OFF flag (#7741): flag-OFF, the cron enqueues no poll job, so the worker is byte-identical to today. */
export function isAprRepoTransferPollEnabled(env: { LOOPOVER_APR_TRANSFER_POLL?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_APR_TRANSFER_POLL ?? "").trim());
}

/**
 * Decide a pending transfer's outcome from a repo probe + elapsed time (#7741). Pure and deterministic.
 * A resolved/departed probe is terminal immediately; otherwise the transfer stays pending until it has been
 * outstanding for `expiryMs` (default {@link APR_REPO_TRANSFER_EXPIRY_MS}), at which point it is expired.
 */
export function classifyAprRepoTransferOutcome(input: {
  probe: AprRepoTransferProbe;
  initiatedAt: number;
  now: number;
  expiryMs?: number;
}): AprRepoTransferOutcome {
  if (input.probe.state === "resolved_under_target") return "accepted";
  if (input.probe.state === "access_departed") return "accepted_departed";
  const expiryMs = input.expiryMs ?? APR_REPO_TRANSFER_EXPIRY_MS;
  if (input.now - input.initiatedAt >= expiryMs) return "expired";
  return "pending";
}

/**
 * Probe GitHub for the current state of a pending transfer (#7741): read the repo at its ORIGINAL path with the
 * App installation token (same token source as initiation). GitHub redirects a completed transfer to its new
 * location, so a 2xx whose owner is now `newOwner` means accepted; a 404 means the App lost access because
 * ownership moved (accepted-and-departed); anything else (still under the original owner, or a transient error)
 * is treated as still pending so the next poll retries. Never throws.
 */
export async function probeAprRepoTransfer(
  env: Env,
  transfer: Pick<PendingAprRepoTransfer, "repoFullName" | "newOwner" | "installationId">,
): Promise<AprRepoTransferProbe> {
  const token = await createInstallationToken(env, transfer.installationId);
  const response = await timeoutFetch(`https://api.github.com/repos/${transfer.repoFullName}`, {
    headers: githubHeaders({ token }),
  });
  if (response.status === 404) return { state: "access_departed" };
  if (!response.ok) return { state: "pending" };
  const body = (await response.json().catch(() => null)) as { owner?: { login?: string } } | null;
  const owner = body?.owner?.login;
  if (owner && owner.toLowerCase() === transfer.newOwner.toLowerCase()) return { state: "resolved_under_target" };
  return { state: "pending" };
}

/**
 * Pause or resume AMS dispatch for a repo by toggling the EXISTING per-repo `agentPaused` kill-switch (#7741
 * deliverable 2) — no new pause mechanism. Freezes dispatch while a transfer is pending; releases it once the
 * transfer resolves or expires.
 */
export async function setAprRepoDispatchPaused(env: Env, repoFullName: string, paused: boolean): Promise<void> {
  await upsertRepositorySettings(env, { repoFullName, agentPaused: paused });
}

/**
 * Load the transfers still awaiting acceptance (#7741). Fail-empty until the pending-transfer record store
 * (#7664) lands: today there is nothing to persist a pending row to, so — exactly like
 * {@link loadAprIdeaCompletion} — this returns none and the poll no-ops. Swap the body (keep the signature)
 * once #7664 persists rows and every caller picks it up.
 */
export async function loadPendingAprRepoTransfers(_env: Env): Promise<PendingAprRepoTransfer[]> {
  return [];
}

/**
 * Record a resolved transfer's terminal outcome (#7741). No-op until the pending-transfer record store (#7664)
 * lands — mirrors {@link loadPendingAprRepoTransfers}. Kept as an injectable seam so the poll's terminal branch
 * is exercised and swapping in real persistence needs no call-site change.
 */
export async function recordAprRepoTransferOutcome(
  _env: Env,
  _transfer: PendingAprRepoTransfer,
  _outcome: TerminalAprRepoTransferOutcome,
): Promise<void> {
  // Intentionally empty until #7664 persists a pending-transfer record to update.
}

/** Injected dependencies for {@link pollPendingAprRepoTransfers}. Every seam is provided so it is cron-free testable. */
export type AprRepoTransferPollDeps = {
  listPending: (env: Env) => Promise<PendingAprRepoTransfer[]>;
  probe: (env: Env, transfer: PendingAprRepoTransfer) => Promise<AprRepoTransferProbe>;
  now: () => number;
  markResolved: (env: Env, transfer: PendingAprRepoTransfer, outcome: TerminalAprRepoTransferOutcome) => Promise<void>;
  setDispatchPaused: (env: Env, repoFullName: string, paused: boolean) => Promise<void>;
  expiryMs?: number;
};

/** Per-transfer result of one poll pass (#7741). */
export type AprRepoTransferPollResult = { repoFullName: string; outcome: AprRepoTransferOutcome };

/**
 * Resolve every pending APR repo transfer in one poll pass (#7741 deliverables 1+2). For each pending transfer:
 * probe GitHub, classify the outcome, and reconcile the per-repo pause —
 *  - `pending`: keep AMS dispatch frozen (idempotent re-assert) and leave the record pending;
 *  - `accepted` (App still installed) or `expired`/declined (the repo never left): record it and RESUME dispatch;
 *  - `accepted_departed` (App lost access — ownership moved away): record it but leave dispatch alone — there is
 *    nothing left to resume.
 * All IO is injected, so the detection/expiry/pause logic is unit-testable without the live cron.
 */
export async function pollPendingAprRepoTransfers(
  env: Env,
  deps: AprRepoTransferPollDeps,
): Promise<AprRepoTransferPollResult[]> {
  const pending = await deps.listPending(env);
  const now = deps.now();
  const results: AprRepoTransferPollResult[] = [];
  for (const transfer of pending) {
    const probe = await deps.probe(env, transfer);
    const outcome = classifyAprRepoTransferOutcome({
      probe,
      initiatedAt: transfer.initiatedAt,
      now,
      ...(deps.expiryMs !== undefined ? { expiryMs: deps.expiryMs } : {}),
    });
    if (outcome === "pending") {
      await deps.setDispatchPaused(env, transfer.repoFullName, true);
    } else {
      await deps.markResolved(env, transfer, outcome);
      if (outcome !== "accepted_departed") await deps.setDispatchPaused(env, transfer.repoFullName, false);
    }
    results.push({ repoFullName: transfer.repoFullName, outcome });
  }
  return results;
}
