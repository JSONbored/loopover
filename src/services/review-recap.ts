// Maintainer review recap digest (#1963, Discord delivery only — Slack is a follow-up). A periodic AGGREGATE
// summary of recent review activity (merged/closed PR counts + gate precision), distinct from
// notify-discord.ts's PER-EVENT terminal-action notifier: this fires on a cadence, not once per PR outcome.
//
// Pure aggregation only — reuses already-computed stats instead of a new ledger: PR merged/closed counts come
// straight from the `pull_requests` table (listPullRequests), and gate precision reuses computeGateEval
// (src/review/parity.ts), which already scores the gate's `merge` predictions against the realized human
// outcome (pr_outcome). No raw trust/reward/scoring internals are read or surfaced here.
//
// SCOPE (this PR, #1963): the pure builder (buildReviewRecap) + a manually-triggerable Discord delivery path
// (generateAndSendReviewRecap, reusing resolveDiscordWebhook from notify-discord.ts — no second webhook
// resolution mechanism). The scheduled cron trigger (mirroring the weekly-value-report cron wiring in
// src/index.ts) is a clear, scoped follow-up — see the PR description.
import { listPullRequests, recordAuditEvent } from "../db/repositories";
import { computeGateEval } from "../review/parity";
import { resolveDiscordWebhook } from "./notify-discord";
import type { ReviewRecap } from "../types";
import { errorMessage, nowIso } from "../utils/json";
import { PUBLIC_LOCAL_PATH_SCRUB_PATTERN } from "../signals/redaction";

const DEFAULT_WINDOW_DAYS = 7;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;

/** Clamp an arbitrary window-days input to a sane range; non-finite/omitted falls back to the weekly default.
 *  Mirrors normalizeReportDays in weekly-value-report.ts (same clamp shape, different bounds/default). */
function normalizeWindowDays(value: number | null | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WINDOW_DAYS;
  return Math.max(MIN_WINDOW_DAYS, Math.min(MAX_WINDOW_DAYS, Math.round(numeric)));
}

/** Public-safe scrub for any free text pulled into the recap (defense in depth — repo full names and counts
 *  are the only inputs today, but this keeps the surface honest if a future field adds free text). */
function sanitizeRecapText(value: string): string {
  return value.replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<redacted-path>").slice(0, 240);
}

type ReviewRecapInputs = {
  repoFullName: string;
  generatedAt: string;
  windowDays?: number | null | undefined;
  pullRequests: Array<{
    mergedAt?: string | null | undefined;
    state: string;
    closedAt?: string | null | undefined;
    updatedAt?: string | null | undefined;
  }>;
  gateMergePrecision: number | null;
  gateDecided: number;
};

/** The best-available terminal timestamp for a closed-unmerged PR: `closedAt` when GitHub's payload carried
 *  one, else `updatedAt` (always populated on write — see toPullRequestRecordFromRow) as a fallback, since a
 *  closed PR's last update IS effectively its close time absent a dedicated column. Returns NaN (never
 *  counted as "in window") only when BOTH are missing/unparseable. */
function closedAtMs(pr: { closedAt?: string | null | undefined; updatedAt?: string | null | undefined }): number {
  const closed = pr.closedAt ? Date.parse(pr.closedAt) : Number.NaN;
  if (Number.isFinite(closed)) return closed;
  const updated = pr.updatedAt ? Date.parse(pr.updatedAt) : Number.NaN;
  return updated;
}

/** Pure recap builder: fold already-loaded PR rows + a gate-eval row into a {@link ReviewRecap}. A PR counts
 *  toward the window when its terminal timestamp (mergedAt for merged, {@link closedAtMs} for closed-unmerged)
 *  falls inside it; a PR with neither (still open) is counted separately and never inflates merged/closed. */
export function buildReviewRecap(args: ReviewRecapInputs): ReviewRecap {
  const windowDays = normalizeWindowDays(args.windowDays);
  const sinceMs = Date.parse(args.generatedAt) - windowDays * 24 * 60 * 60 * 1000;
  let merged = 0;
  let closed = 0;
  let stillOpen = 0;
  for (const pr of args.pullRequests) {
    const mergedAtMs = pr.mergedAt ? Date.parse(pr.mergedAt) : Number.NaN;
    if (pr.mergedAt && Number.isFinite(mergedAtMs) && mergedAtMs >= sinceMs) {
      merged += 1;
    } else if (pr.state === "closed" && !pr.mergedAt && Number.isFinite(closedAtMs(pr)) && closedAtMs(pr) >= sinceMs) {
      closed += 1;
    } else if (pr.state !== "closed") {
      stillOpen += 1;
    }
  }
  const repoFullName = sanitizeRecapText(args.repoFullName);
  const precisionLine =
    args.gateMergePrecision !== null
      ? `Gate merge precision: ${Math.round(args.gateMergePrecision * 100)}% (${args.gateDecided} decided prediction(s)).`
      : `Gate merge precision: not enough decided predictions yet to report.`;
  const summary = [
    `${repoFullName}: ${merged} merged, ${closed} closed, ${stillOpen} still open in the last ${windowDays} day(s).`,
    precisionLine,
  ].map(sanitizeRecapText);
  return {
    repoFullName,
    generatedAt: args.generatedAt,
    windowDays,
    merged,
    closed,
    stillOpen,
    gatePrecision: args.gateMergePrecision,
    gateDecided: args.gateDecided,
    summary,
  };
}

/** Load the inputs (PR rows for this repo + the repo's gate-eval row) and build the recap. Pure read;
 *  fail-safe defaults (empty PR list, null precision) if computeGateEval degrades (it already fails safe
 *  to an empty report on a D1 read error — see review/parity.ts). */
export async function loadReviewRecap(env: Env, repoFullName: string, options: { windowDays?: number; nowIso?: string } = {}): Promise<ReviewRecap> {
  const generatedAt = options.nowIso ?? nowIso();
  const windowDays = normalizeWindowDays(options.windowDays);
  const nowMs = Date.parse(generatedAt);
  const [pullRequests, gateEval] = await Promise.all([
    listPullRequests(env, repoFullName),
    computeGateEval(env, { days: windowDays, nowMs: Number.isFinite(nowMs) ? nowMs : Date.now() }),
  ]);
  const row = gateEval.rows.find((candidate) => candidate.project.toLowerCase() === repoFullName.toLowerCase());
  return buildReviewRecap({
    repoFullName,
    generatedAt,
    windowDays,
    pullRequests,
    gateMergePrecision: row?.mergePrecision ?? null,
    gateDecided: row?.decided ?? 0,
  });
}

/** Render the recap as a compact Discord embed description (reused by generateAndSendReviewRecap). */
function formatRecapDescription(recap: ReviewRecap): string {
  return recap.summary.join("\n").slice(0, 1800);
}

/** Post the recap to the repo's configured Discord webhook, reusing {@link resolveDiscordWebhook} — the SAME
 *  per-repo resolution notify-discord.ts's per-event notifier uses. Best-effort: a delivery failure is
 *  recorded to the audit ledger but never thrown (mirrors notifyActionToDiscord's fail-safe contract). */
export async function sendReviewRecapToDiscord(env: Env, recap: ReviewRecap): Promise<{ sent: boolean; reason?: string }> {
  const resolved = resolveDiscordWebhook(env, recap.repoFullName);
  if (resolved.status !== "configured") {
    await recordAuditEvent(env, {
      eventType: "review_recap_notification.discord",
      actor: "gittensory",
      targetKey: `review-recap:${recap.repoFullName}:${recap.windowDays}`,
      outcome: "denied",
      detail: resolved.reason,
      metadata: { repoFullName: recap.repoFullName, windowDays: recap.windowDays },
    });
    return { sent: false, reason: resolved.reason };
  }
  const body = {
    username: "Gittensory",
    embeds: [
      {
        title: `${recap.repoFullName} · review recap (${recap.windowDays}d)`,
        description: formatRecapDescription(recap),
        color: 0x5865f2,
        fields: [
          { name: "Merged", value: String(recap.merged), inline: true },
          { name: "Closed", value: String(recap.closed), inline: true },
          { name: "Still open", value: String(recap.stillOpen), inline: true },
        ],
        footer: { text: `Gittensory · ${recap.repoFullName}` },
      },
    ],
  };
  try {
    const response = await fetch(resolved.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`discord_webhook_http_${response.status}`);
    await recordAuditEvent(env, {
      eventType: "review_recap_notification.discord",
      actor: "gittensory",
      targetKey: `review-recap:${recap.repoFullName}:${recap.windowDays}`,
      outcome: "completed",
      detail: "sent",
      metadata: { repoFullName: recap.repoFullName, windowDays: recap.windowDays, source: resolved.source },
    });
    return { sent: true };
  } catch (error) {
    const detail = errorMessage(error).slice(0, 160);
    console.warn(JSON.stringify({ ev: "review_recap_discord_failed", repo: recap.repoFullName, message: detail }));
    await recordAuditEvent(env, {
      eventType: "review_recap_notification.discord",
      actor: "gittensory",
      targetKey: `review-recap:${recap.repoFullName}:${recap.windowDays}`,
      outcome: "error",
      detail,
      metadata: { repoFullName: recap.repoFullName, windowDays: recap.windowDays },
    });
    return { sent: false, reason: detail };
  }
}

/** Build the recap for one repo and deliver it to Discord in one call — the manual-trigger entry point
 *  (`/v1/internal/jobs/generate-review-recap/run`). Always returns the recap even when delivery is denied
 *  (e.g. no webhook configured), so the caller can inspect the computed numbers either way. */
export async function generateAndSendReviewRecap(env: Env, repoFullName: string, options: { windowDays?: number; nowIso?: string } = {}): Promise<{ recap: ReviewRecap; delivery: { sent: boolean; reason?: string } }> {
  const recap = await loadReviewRecap(env, repoFullName, options);
  const delivery = await sendReviewRecapToDiscord(env, recap);
  return { recap, delivery };
}
