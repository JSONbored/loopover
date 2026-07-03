import type { PublicRepoQuality, QueueHealthLevel } from "../services/public-repo-quality";

// Self-rendered README status badge (#541). Renders ONLY the public-safe whitelisted metrics from
// `PublicRepoQuality` — no external badge service, no contributor/reward/trust data. All text is XML-escaped
// before it reaches the SVG so the unauthenticated, embeddable surface cannot be turned into an injection
// vector even if upstream values ever change shape.

const LABEL = "gittensory";

const QUEUE_COLORS: Record<QueueHealthLevel, string> = {
  low: "#3fb950",
  medium: "#d29922",
  high: "#db6d28",
  critical: "#f85149",
};

// Severity order of the queue-health levels, ascending (low = least alarming … critical = most alarming).
const QUEUE_SEVERITY: Record<QueueHealthLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const LOW_REAL_CONTRIBUTION_PCT = 50;
const UNAVAILABLE_COLOR = "#9e9e9e";

export type ShieldsBadge = {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  cacheSeconds: number;
};

export function buildBadgeMessage(quality: PublicRepoQuality): string {
  const real = quality.realContributionPct === null ? "real n/a" : `${quality.realContributionPct}% real`;
  const merge =
    quality.medianTimeToMergeHours === null ? "merge n/a" : `merge ${formatDuration(quality.medianTimeToMergeHours)}`;
  return `${real} · ${merge} · queue ${quality.queueHealthLevel}`;
}

export function buildBadgeColor(quality: PublicRepoQuality): string {
  const queueColor = QUEUE_COLORS[quality.queueHealthLevel];
  // A low real-contribution share dominates the signal — it FLOORS the color at `high`, escalating a healthier
  // queue up to orange. It must never DOWNGRADE a more-severe queue: a `critical` (red) queue with low contribution
  // is doubly bad, so keep its color rather than replacing it with the less-alarming `high` orange.
  if (quality.realContributionPct !== null && quality.realContributionPct < LOW_REAL_CONTRIBUTION_PCT) {
    return QUEUE_SEVERITY[quality.queueHealthLevel] >= QUEUE_SEVERITY.high ? queueColor : QUEUE_COLORS.high;
  }
  return queueColor;
}

export function buildShieldsBadge(quality: PublicRepoQuality, cacheSeconds: number): ShieldsBadge {
  return {
    schemaVersion: 1,
    label: LABEL,
    message: buildBadgeMessage(quality),
    color: buildBadgeColor(quality),
    cacheSeconds,
  };
}

export function renderBadgeSvg(quality: PublicRepoQuality): string {
  return renderFlatBadge(LABEL, buildBadgeMessage(quality), buildBadgeColor(quality));
}

export function renderUnavailableBadgeSvg(): string {
  return renderFlatBadge(LABEL, "unavailable", UNAVAILABLE_COLOR);
}

function formatDuration(hours: number): string {
  if (hours < 1) return "<1h";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// Minimal flat ("shields"-style) badge. Widths are approximated from character count; exactness is not
// required for a README badge and keeps the renderer dependency-free.
function renderFlatBadge(label: string, message: string, color: string): string {
  const labelText = escapeXml(label);
  const messageText = escapeXml(message);
  const labelWidth = textWidth(label);
  const messageWidth = textWidth(message);
  const totalWidth = labelWidth + messageWidth;
  const labelMid = labelWidth / 2;
  const messageMid = labelWidth + messageWidth / 2;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${labelText}: ${messageText}">`,
    `<title>${labelText}: ${messageText}</title>`,
    `<rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>`,
    `<rect width="${labelWidth}" height="20" rx="3" fill="#24292f"/>`,
    `<rect x="${labelWidth}" width="${messageWidth}" height="20" rx="3" fill="${escapeXml(color)}"/>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${labelMid}" y="14">${labelText}</text>`,
    `<text x="${messageMid}" y="14">${messageText}</text>`,
    `</g></svg>`,
  ].join("");
}

function textWidth(text: string): number {
  // ~6.5px per character + 10px horizontal padding, clamped to a sane minimum.
  return Math.max(40, Math.round(text.length * 6.5) + 10);
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
