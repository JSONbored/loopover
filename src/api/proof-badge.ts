// README badge for the public proof page (#9569). Renders through the SAME flat-badge primitive and the
// SAME XML escaping as the repo-quality badge (`./badge.ts`), so an unauthenticated, embeddable surface
// cannot become an injection vector and the two badges cannot drift apart visually.
import { escapeXml } from "./badge";
import { buildProofBadgeColor, buildProofBadgeMessage, type ProofSummary } from "../review/proof-summary";

const PROOF_BADGE_LABEL = "loopover proof";
const UNAVAILABLE_COLOR = "#9e9e9e";

/** `null` renders the neutral unavailable badge — used for both the flag-off 404 and the error 503, since
 *  from a README's point of view those are the same thing: no claim is being made right now. */
export function renderProofBadgeSvg(summary: ProofSummary | null): string {
  const message = summary ? buildProofBadgeMessage(summary) : "unavailable";
  const color = summary ? buildProofBadgeColor(summary) : UNAVAILABLE_COLOR;
  return renderFlatBadge(PROOF_BADGE_LABEL, message, color);
}

function renderFlatBadge(label: string, message: string, color: string): string {
  const labelText = escapeXml(label);
  const messageText = escapeXml(message);
  const labelWidth = textWidth(label);
  const messageWidth = textWidth(message);
  const totalWidth = labelWidth + messageWidth;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${labelText}: ${messageText}">`,
    `<title>${labelText}: ${messageText}</title>`,
    `<rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>`,
    `<rect width="${labelWidth}" height="20" rx="3" fill="#24292f"/>`,
    `<rect x="${labelWidth}" width="${messageWidth}" height="20" rx="3" fill="${escapeXml(color)}"/>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${labelWidth / 2}" y="14">${labelText}</text>`,
    `<text x="${labelWidth + messageWidth / 2}" y="14">${messageText}</text>`,
    `</g></svg>`,
  ].join("");
}

function textWidth(text: string): number {
  return Math.max(40, Math.round(text.length * 6.5) + 10);
}
