// Maintainer-recap BUILDER (#2239, foundation for the #1963 recap digest).
//
// A PURE data-shaping seam: fold a window of gittensory's own review-outcome data across repos into a single
// serializable RecapReport. No delivery, no scheduling, no I/O, no model call — exactly the shape
// weekly-value-report.ts's buildWeeklyValueReport uses (inputs injected, report returned). The caller supplies
// each repo's two already-computed aggregators (services/gate-precision.ts buildGatePrecisionReport +
// services/outcome-calibration.ts buildRepoOutcomeCalibration, the same pair src/review/ops-wire.ts already
// loads together) so NO new D1 queries are added here.
//
// Distinct from services/review-recap.ts's buildReviewRecap: that is SINGLE-repo and sourced from gate merge-
// PREDICTION precision; this is MULTI-repo and sourced from the realized gate-block + recommendation-outcome
// calibration ledgers (blocked-then-merged false positives, maintainer overrides, recommendation reversals).
import { PUBLIC_LOCAL_PATH_SCRUB_PATTERN, PUBLIC_UNSAFE_PATTERN } from "../signals/redaction";
import { deliverRecapToDiscord, deliverRecapToSlack } from "./notify-discord";
import type { GatePrecisionReport } from "./gate-precision";
import type { OutcomeCalibration } from "./outcome-calibration";
import type { MaintainerRecapRepo, RecapReport } from "../types";
import { nowIso } from "../utils/json";

const DEFAULT_WINDOW_DAYS = 7;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;

/** Clamp an arbitrary window-days input to a sane range; non-finite/omitted falls back to the weekly default.
 *  Mirrors review-recap.ts's normalizeWindowDays (same bounds). */
function normalizeWindowDays(value: number | null | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WINDOW_DAYS;
  return Math.max(MIN_WINDOW_DAYS, Math.min(MAX_WINDOW_DAYS, Math.round(numeric)));
}

/** Public-safe scrub for any free text pulled into the recap (defense in depth — repo full names are the only
 *  free-text input today). Mirrors review-recap.ts's sanitizeRecapText. */
function sanitizeRecapText(value: string): string {
  return value.replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<redacted-path>").slice(0, 240);
}

/** One repo's two already-computed aggregators. Both carry the SAME repoFullName; the gate report drives repo
 *  identity. Injected by the caller (no new D1 read here), exactly like buildWeeklyValueReport's inputs. */
export type MaintainerRecapRepoInput = { gatePrecision: GatePrecisionReport; calibration: OutcomeCalibration };

export type MaintainerRecapInputs = {
  generatedAt: string;
  windowDays?: number | null | undefined;
  repos: MaintainerRecapRepoInput[];
};

/** PURE recap builder: fold each repo's gate-precision + outcome-calibration reports into a {@link RecapReport}
 *  with per-repo counts and top-line gate/reversal totals. Never throws; an empty repo list yields a zeroed
 *  report with a null false-positive rate (nothing blocked ⇒ nothing to divide by). */
export function buildMaintainerRecap(args: MaintainerRecapInputs): RecapReport {
  const windowDays = normalizeWindowDays(args.windowDays);
  const repos: MaintainerRecapRepo[] = [];
  const totals = {
    reviewed: 0,
    merged: 0,
    closed: 0,
    blocked: 0,
    gateFalsePositives: 0,
    gateOverrides: 0,
    reversals: 0,
    gateFalsePositiveRate: null as number | null,
  };
  for (const { gatePrecision, calibration } of args.repos) {
    let merged = 0;
    let closed = 0;
    for (const band of calibration.slop.bands) {
      merged += band.merged;
      closed += band.closed;
    }
    let gateOverrides = 0;
    for (const perType of gatePrecision.perGateType) gateOverrides += perType.overridden;
    const repo: MaintainerRecapRepo = {
      repoFullName: sanitizeRecapText(gatePrecision.repoFullName),
      reviewed: calibration.slop.totalResolved,
      merged,
      closed,
      gateFalsePositives: gatePrecision.overall.blockedThenMerged,
      gateOverrides,
      reversals: calibration.recommendations.negative,
    };
    repos.push(repo);
    totals.reviewed += repo.reviewed;
    totals.merged += repo.merged;
    totals.closed += repo.closed;
    totals.blocked += gatePrecision.overall.blocked;
    totals.gateFalsePositives += repo.gateFalsePositives;
    totals.gateOverrides += repo.gateOverrides;
    totals.reversals += repo.reversals;
  }
  totals.gateFalsePositiveRate =
    totals.blocked > 0 ? Math.round((totals.gateFalsePositives / totals.blocked) * 100) / 100 : null;
  const rateLine =
    totals.gateFalsePositiveRate !== null
      ? `Gate false-positive rate: ${Math.round(totals.gateFalsePositiveRate * 100)}% (${totals.gateFalsePositives}/${totals.blocked} block(s) later merged).`
      : `Gate false-positive rate: not enough blocked PRs in the window to report.`;
  const summary = [
    `Maintainer recap over the last ${windowDays} day(s): ${repos.length} repo(s), ${totals.reviewed} reviewed, ${totals.merged} merged, ${totals.closed} closed.`,
    rateLine,
    `${totals.gateOverrides} maintainer override(s), ${totals.reversals} recommendation reversal(s).`,
  ].map(sanitizeRecapText);
  return { generatedAt: args.generatedAt, windowDays, repos, totals, summary };
}

/** Redact one free-text line bound for the public digest body. Two arms mirroring weekly-value-report.ts's
 *  sanitizeReportText: scrub any absolute local path to `<redacted-path>`, then blank the WHOLE line to
 *  `<redacted>` if any economic/identity term (reward/score/wallet/payout/…) survives. Defense in depth — the
 *  builder already sanitizes free-text fields, but the formatter re-guards every emitted line so a hand-built
 *  or future report can never leak a private term into a digest. Capped at 240 chars like sanitizeRecapText. */
function redactRecapLine(value: string): string {
  const scrubbed = value.replace(PUBLIC_LOCAL_PATH_SCRUB_PATTERN, "<redacted-path>").slice(0, 240);
  return PUBLIC_UNSAFE_PATTERN.test(scrubbed) ? "<redacted>" : scrubbed;
}

/** Render a titled section's body: one `- ` bullet per redacted item, or a single italic fallback line when the
 *  section is empty so a header never dangles over a blank body. */
function recapSectionLines(items: string[], fallback: string): string[] {
  return items.length === 0 ? [fallback] : items.map((item) => `- ${redactRecapLine(item)}`);
}

/** Render a {@link RecapReport} into a formatted maintainer-digest body: a header plus titled sections
 *  (Summary, Totals, Per-repo), mirroring formatWeeklyValueReportMarkdown at weekly-value-report.ts. PURE
 *  string function — no delivery, no I/O. Every free-text value is routed through {@link redactRecapLine} so no
 *  reward/trust/score/path term can leak into the digest even if the input report was hand-built. (#2240) */
export function formatMaintainerRecap(report: RecapReport): string {
  const { totals } = report;
  const rate = totals.gateFalsePositiveRate !== null ? `${Math.round(totals.gateFalsePositiveRate * 100)}%` : "n/a";
  const perRepoLines = report.repos.map(
    (repo) =>
      `${redactRecapLine(repo.repoFullName)} — ${repo.reviewed} reviewed, ${repo.merged} merged, ${repo.closed} closed, ${repo.gateFalsePositives} gate false-positive(s), ${repo.gateOverrides} override(s), ${repo.reversals} reversal(s)`,
  );
  const lines = [
    "# Maintainer recap",
    "",
    `- Generated: ${redactRecapLine(report.generatedAt)}`,
    `- Window: ${report.windowDays} day(s)`,
    `- Repos: ${report.repos.length}`,
    "",
    "## Summary",
    ...recapSectionLines(report.summary, "_No summary lines for this window._"),
    "",
    "## Totals",
    `- Reviewed: ${totals.reviewed}`,
    `- Merged: ${totals.merged}`,
    `- Closed: ${totals.closed}`,
    `- Gate false positives: ${totals.gateFalsePositives}/${totals.blocked} (${rate})`,
    `- Overrides: ${totals.gateOverrides}`,
    `- Reversals: ${totals.reversals}`,
    "",
    "## Per-repo",
    ...recapSectionLines(perRepoLines, "_No repositories in this window._"),
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export type RunMaintainerRecapResult =
  | { skipped: true; reason: "disabled" }
  | {
      skipped: false;
      report: RecapReport;
      formatted: string;
      delivery: {
        discord: { sent: boolean; reason?: string };
        slack: { sent: boolean; reason?: string };
      };
    };

/**
 * End-to-end maintainer recap orchestration (#2252): build (or accept an injected report) →
 * {@link formatMaintainerRecap} → fan out to Discord + Slack independently. Each deliverer is best-effort and
 * never throws, so a single-channel outage does not abort the other. When `enabled === false`, short-circuits
 * before any I/O (the flag-OFF arm mirrored by the cron/job processor).
 */
export async function runMaintainerRecap(
  env: Env,
  options: {
    windowDays?: number;
    generatedAt?: string;
    repos?: MaintainerRecapRepoInput[];
    /** Pre-built report for test injection; skips {@link buildMaintainerRecap} when set. */
    report?: RecapReport;
    /** When explicitly false, short-circuits before build/format/delivery. Default: run. */
    enabled?: boolean;
  } = {},
): Promise<RunMaintainerRecapResult> {
  if (options.enabled === false) return { skipped: true, reason: "disabled" };

  const report =
    options.report ??
    buildMaintainerRecap({
      generatedAt: options.generatedAt ?? nowIso(),
      windowDays: options.windowDays,
      repos: options.repos ?? [],
    });
  const formatted = formatMaintainerRecap(report);
  const [discord, slack] = await Promise.all([
    deliverRecapToDiscord(env, report, formatted),
    deliverRecapToSlack(env, report, formatted),
  ]);
  return { skipped: false, report, formatted, delivery: { discord, slack } };
}
