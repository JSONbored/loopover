// #9541 (deliverable 1): the one prologue every `@loopover <verb>` PR-command handler runs.
//
// Six handlers in src/queue/processors.ts opened with a byte-identical eleven-step sequence — parse, name
// guard, classify, skip-if-unclassifiable, target key, redelivery guard, load PR + settings, skip-if-no-PR,
// authorize, record-and-stop-if-denied — copy-pasted six times, 30 to 300 lines apart inside a 16,000-line
// file. That distance is the whole problem: a guard added to the instances someone greps for, with the next
// one far enough away that it does not read as a second site.
//
// It is not hypothetical. #9312 added the redelivery guard to five of the six and missed `resolve`, which then
// wrote duplicate permanent review-memory suppression rows on every queue retry until #9561 caught it. The
// same week, #9562 found the two PR-panel twins missing it for a *paid model call*. Owning the sequence once
// is what stops the seventh handler repeating it.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not own the *response* to each step — only the sequence and its
// stopping conditions. Each handler still supplies its own audit event names and skip recorder, because those
// strings are the handler's public contract (`github_app.finding_resolved_skipped` and friends are queried by
// operators and asserted in tests). Centralising them would be a behaviour change wearing a refactor's
// clothes, and #9541 requirement 1 is explicit that this must be behaviour-preserving.
import type { GitHubWebhookPayload } from "../types";
import type { LoopOverActionCommandName, LoopOverMentionCommand, LoopOverMentionCommandName } from "../github/commands";
import type { PullRequestRecord, RepositorySettings } from "../types";

/** What the caller must tell the prologue about its own command. */
export interface PrCommandPrologueSpec {
  /** The verb this handler owns. A comment naming any other verb is not ours — the handler returns false. */
  commandName: LoopOverActionCommandName;
  /**
   * The audit event this command writes on success. The redelivery guard keys on it, so it must be the event
   * the handler ACTUALLY records — keying on an event a paused/dry-run pass never writes leaves exactly the
   * replays that already cost money unguarded (the lesson from the dispatcher's two-event guard in #9563).
   */
  completedEventType: string;
  /**
   * `authorizePrActionActor`'s miner-status lookup is opt-in per command: it costs a live API call, and a
   * command whose policy cannot match `confirmed_miner` has no reason to pay it. Passing `false` where the
   * policy DOES allow confirmed miners silently denies them, since no other role would match.
   */
  needsMinerDetection: boolean;
  /**
   * Stop with a `pr_not_open` skip when the PR is no longer open (#9020/#9311).
   *
   * A named policy rather than a general escape hatch: the commands that spend real money — AI generation,
   * a branch commit — must not do so on a closed or merged PR, and the two PR-panel twins carry the identical
   * guard. Commands that only read or annotate (pause, resume, explain) deliberately still work on a closed
   * PR, so this is opt-in.
   */
  requireOpenPr?: boolean;
  /** Records this command's own skip event. Owned by the handler — the event names are its public contract. */
  recordSkip: (reason: string, context: PrCommandSkipContext) => Promise<void>;
  /** Records this command's own denial. Separate from `recordSkip`: denials carry the authorization reason. */
  recordDenied: (context: PrCommandDeniedContext) => Promise<void>;
}

/** The not-ok arm of `classifyPrCommandRequest`: no PR to act on, only enough context to record the skip. */
export interface UnclassifiedRequest {
  ok: false;
  reason?: string;
  repoFullName?: string | null;
  actor?: string | null;
  targetKey?: string | null;
}

export interface PrCommandSkipContext {
  repoFullName: string | null;
  targetKey: string | null;
  actor: string | null;
}

export interface PrCommandDeniedContext {
  repoFullName: string;
  targetKey: string;
  actor: string;
  reason: string;
  actorKind: string;
  settings: RepositorySettings;
}

/**
 * The outcome of the prologue, as a discriminated union rather than a nullable result.
 *
 * `notMine` and `handled` are deliberately distinct even though a handler acts on both by returning: `notMine`
 * means "this comment is some other command's, keep dispatching" (return false) and `handled` means "this was
 * ours and is finished" (return true). Collapsing them into one falsy result is how a command silently stops
 * reaching its siblings.
 */
export type PrCommandPrologueOutcome<TRequest, TAuthorization> =
  | { status: "notMine" }
  | { status: "handled" }
  | {
      status: "ready";
      req: TRequest;
      targetKey: string;
      pr: PullRequestRecord;
      settings: RepositorySettings;
      authorization: TAuthorization;
      /** The parsed command, so a handler can read its trailing argument without re-parsing the body. */
      command: LoopOverMentionCommand;
    };

/** The IO the prologue performs, injected so the seam is directly testable without a webhook or a database. */
export interface PrCommandPrologueDeps<TRequest, TAuthorization> {
  parseCommand: (body: string | null | undefined) => LoopOverMentionCommand | null;
  classifyRequest: (payload: GitHubWebhookPayload) => TRequest | UnclassifiedRequest;
  hasSeenDelivery: (actor: string, eventType: string, targetKey: string, deliveryId: string) => Promise<boolean>;
  loadPullRequest: (repoFullName: string, prNumber: number) => Promise<PullRequestRecord | null>;
  loadSettings: (repoFullName: string) => Promise<RepositorySettings>;
  authorize: (input: { req: TRequest; settings: RepositorySettings; pr: PullRequestRecord; needsMinerDetection: boolean }) => Promise<{ authorization: TAuthorization & { authorized: boolean; reason: string; actorKind: string } }>;
}

/**
 * The classified-request shape the prologue needs. Handlers' own request types are supersets of this.
 *
 * `targetKey` and `reason` are optional because they live on the NOT-ok arm of `classifyPrCommandRequest`'s
 * union — an ok request carries a real repo and PR instead, and the prologue derives the target key from
 * those. Requiring them here would make the ok arm structurally incompatible.
 */
interface ClassifiedRequest {
  ok: true;
  actor: string;
  repoFullName: string;
  targetKey?: string | null;
  reason?: string;
  installationId: number;
  pr: { number: number };
}

/**
 * Runs the shared prologue and reports where it stopped.
 *
 * Ordering is load-bearing and matches the six hand-written copies exactly, including two details that look
 * incidental and are not:
 *
 *   - the redelivery guard runs BEFORE the PR/settings load, so a replay costs no database reads; and
 *   - `targetKey` is computed from the classified request rather than the payload, because the unclassifiable
 *     path has to report a skip against `req.targetKey`, which may legitimately be null.
 */
export async function runPrCommandPrologue<TRequest extends ClassifiedRequest, TAuthorization>(
  payload: GitHubWebhookPayload,
  deliveryId: string,
  spec: PrCommandPrologueSpec,
  deps: PrCommandPrologueDeps<TRequest, TAuthorization>,
): Promise<PrCommandPrologueOutcome<TRequest, TAuthorization>> {
  const command = deps.parseCommand(payload.comment?.body);
  if (!command || command.name !== spec.commandName) return { status: "notMine" };

  const req = deps.classifyRequest(payload);
  if (!req.ok) {
    await spec.recordSkip(req.reason ?? "unclassified", { repoFullName: req.repoFullName ?? null, targetKey: req.targetKey ?? null, actor: req.actor ?? null });
    return { status: "handled" };
  }

  const targetKey = `${req.repoFullName}#${req.pr.number}`;

  // Before the loads on purpose: a redelivered webhook should cost nothing, and the original delivery already
  // did this work under this same deliveryId.
  if (await deps.hasSeenDelivery(req.actor, spec.completedEventType, targetKey, deliveryId)) return { status: "handled" };

  const [pr, settings] = await Promise.all([deps.loadPullRequest(req.repoFullName, req.pr.number), deps.loadSettings(req.repoFullName)]);
  if (!pr) {
    await spec.recordSkip("cached_pr_missing", { repoFullName: req.repoFullName, targetKey, actor: req.actor });
    return { status: "handled" };
  }

  if (spec.requireOpenPr === true && pr.state !== "open") {
    await spec.recordSkip("pr_not_open", { repoFullName: req.repoFullName, targetKey, actor: req.actor });
    return { status: "handled" };
  }

  const { authorization } = await deps.authorize({ req, settings, pr, needsMinerDetection: spec.needsMinerDetection });
  if (!authorization.authorized) {
    await spec.recordDenied({
      repoFullName: req.repoFullName,
      targetKey,
      actor: req.actor,
      reason: authorization.reason,
      actorKind: authorization.actorKind,
      settings,
    });
    return { status: "handled" };
  }

  return { status: "ready", req, targetKey, pr, settings, authorization, command };
}
