// #578: visual-review webhook intake. Mirrors the submission-gate flow — a consumed PR webhook is
// inspected, and an ELIGIBLE + repo-ENABLED visual-change candidate is recorded in D1 and enqueued onto
// the existing jobs queue (which already has a dead-letter queue). Detection of *which* PRs actually
// change the UI (affected-route mapping) is #579; this scaffold enqueues every non-draft PR
// open/sync/reopen on an opted-in repo and lets the downstream pipeline decide.
import { recordAuditEvent } from "../db/repositories";
import { getInstallationId } from "../github/app";
import type { GitHubWebhookPayload, JobMessage } from "../types";
import { errorMessage } from "../utils/json";
import { VISUAL_REVIEW_PR_ACTIONS } from "./constants";
import { isVisualReviewEnabled, upsertVisualReviewTarget } from "./targets";

/**
 * If this webhook is an eligible visual-change PR event for an opted-in repo, record a `queued` review
 * target and enqueue a `visual-review` job. Returns true when a job was enqueued. Fully fail-safe: any
 * error is swallowed and audited so a visual-review failure never breaks submission-gate webhook
 * processing (the visual surface is strictly additive and owner-led).
 */
export async function maybeEnqueueVisualReview(env: Env, deliveryId: string, payload: GitHubWebhookPayload): Promise<boolean> {
  const repoFullName = payload.repository?.full_name;
  const pr = payload.pull_request;
  if (!repoFullName || !pr) return false;
  const action = payload.action ?? "";
  if (!VISUAL_REVIEW_PR_ACTIONS.has(action)) return false;
  if (pr.draft === true || pr.isDraft === true) return false;
  const headSha = pr.head?.sha;
  if (!headSha) return false;

  try {
    if (!(await isVisualReviewEnabled(env, repoFullName))) return false;

    const installationId = getInstallationId(payload);
    await upsertVisualReviewTarget(env, {
      repoFullName,
      pullNumber: pr.number,
      headSha,
      baseSha: pr.base?.ref ?? null,
      installationId: installationId ?? null,
      deliveryId,
    });

    const message: JobMessage = {
      type: "visual-review",
      requestedBy: "webhook",
      deliveryId,
      repoFullName,
      pullNumber: pr.number,
      headSha,
    };
    await env.JOBS.send(message);

    await recordAuditEvent(env, {
      eventType: "visual_review.enqueued",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "queued",
      detail: `visual review queued for ${repoFullName}#${pr.number} @ ${headSha.slice(0, 7)}`,
      metadata: { deliveryId, repoFullName, pullNumber: pr.number, headSha, action },
    });
    return true;
  } catch (error) {
    await recordAuditEvent(env, {
      eventType: "visual_review.enqueue_failed",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "error",
      detail: errorMessage(error),
      metadata: { deliveryId, repoFullName, pullNumber: pr.number },
    });
    return false;
  }
}
