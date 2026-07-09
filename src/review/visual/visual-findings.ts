// Advisory-only AI-vision analysis of before/after visual captures (#4111, part of the visual-capture
// convergence epic #3607). PURE decision + prompt/response logic ONLY — this module never fetches screenshot
// bytes, calls an AI provider, or touches D1; a caller supplies already-resolved images (as
// `AiContentBlock[]`, see `../../types`), a resolved BYOK provider key, and a resolved reputation signal, so
// this file stays testable without network or D1 fixtures. Wiring a live caller — fetch the captured PNG
// bytes, resolve submitter reputation + BYOK, invoke `callAiProvider`/the self-host AI with the images, and
// append the resulting finding to `advisory.findings` — is a deliberately deferred follow-up (see the #4111
// PR description); this module ships the gating + message-shape + parsing + finding-construction it needs.
//
// STRICTLY ADVISORY: `VISUAL_REGRESSION_FINDING_CODE` is not one of the codes `isConfiguredGateBlocker`
// (src/rules/advisory.ts) recognizes, so a visual finding can NEVER become a gate blocker — it rides the
// identical `advisory.findings` pipeline `ai_consensus_defect`/`ai_review_split` already use, recovered in the
// unified comment exactly like a consensus defect (see `review/unified-comment-bridge.ts`'s
// `visualFindingsFromFindings`), but there is no code path that promotes it to `blockers`.

import type { AdvisoryFinding } from "../../types";
import { extractLastJsonObject, toPublicSafe, type AiReviewProviderKey } from "../../services/ai-review";
import type { ReputationSignal } from "../submitter-reputation";
import type { CaptureRoute } from "./capture";

/** The advisory finding code a visual-regression observation is published under (#4111). Deliberately absent
 *  from `isConfiguredGateBlocker`'s allowlist (src/rules/advisory.ts) — see this file's header. */
export const VISUAL_REGRESSION_FINDING_CODE = "visual_regression_finding";

/** Bound on how many routes a single review ever sends to vision, independent of how many the capture
 *  pipeline rendered — a vision call is the most expensive AI request this codebase makes per-route (an
 *  image attachment, not just text), so an unbounded capture set must never translate into unbounded spend. */
const MAX_VISION_ROUTES = 2;

/**
 * True when a captured route crossed the EXISTING pixel-diff change threshold (the visual-agent pixel-diff
 * module's `changeThresholdPercent`) — surfaced here via the diff-overlay URL, since `uploadDiffImage`
 * (`./capture.ts`) only ever populates `diffUrl`/`diffUrlMobile` for a route `compareRouteScreenshots`
 * classified `"changed"`. An "unchanged" route (no diff URL on either viewport) is excluded, so a PR that
 * touches web-visible files but renders pixel-identical before/after spends zero vision tokens — no NEW
 * threshold is introduced here. (Not imported directly — this file only reads the ALREADY-COMPUTED diffUrl
 * field, keeping worker-reachable code free of the Node-only pixel-diff dependency; see
 * test/unit/worker-entry-boundary.test.ts.)
 */
export function routeHasConfirmedVisualRegression(route: CaptureRoute): boolean {
  return Boolean(route.diffUrl || route.diffUrlMobile);
}

/** The (bounded) subset of captured routes worth a vision call: only those confirmed changed by the existing
 *  pixel-diff threshold, capped at {@link MAX_VISION_ROUTES}. */
export function selectRoutesForVisualVision(routes: readonly CaptureRoute[]): CaptureRoute[] {
  return routes.filter(routeHasConfirmedVisualRegression).slice(0, MAX_VISION_ROUTES);
}

/** Why {@link evaluateVisualVisionGate} declined to run the vision call — observability-only; never public. */
export type VisualVisionSkipReason = "no_confirmed_regression" | "low_reputation" | "byok_not_configured";

export type VisualVisionGateResult =
  | { run: false; reason: VisualVisionSkipReason }
  | { run: true; routes: CaptureRoute[] };

/**
 * Decide whether a visual-vision call is warranted for this review — ALL THREE must clear:
 *   1. pixel-diff threshold — at least one route the capture pipeline already flagged "changed" (see
 *      {@link selectRoutesForVisualVision}); an all-unchanged capture costs nothing.
 *   2. submitter reputation — a "low" windowed reputation signal (`../submitter-reputation.ts`) skips vision
 *      exactly like the other AI neurons already skip for a low-reputation/burst submitter
 *      (`shouldSkipAiForReputation`, `../reputation-wire.ts`); checked FIRST so a low-reputation submitter is
 *      never even told which reason applies to their capture.
 *   3. a provider that can actually SEE the screenshots — either BYOK (`providerKey` non-null: the
 *      maintainer's own anthropic/openai key) or a self-host local vision provider (`selfHostVisionAvailable`,
 *      #4335: a dedicated ollama+VLM binding, `env.AI_VISION`). Workers AI is fully retired (no free
 *      vision-capable path exists) and the self-host subscription CLIs (claude-code/codex) cannot consume
 *      inline image bytes through their stdin-JSON invocation (see `../../selfhost/ai.ts`'s `contentText`),
 *      so only an HTTP-capable provider — BYOK or self-host's dedicated AI_VISION binding — can see them.
 * Pure + total: the caller resolves the reputation signal / provider key / self-host vision availability (D1,
 * decryption, and env all live outside this file) and passes the results in.
 */
export function evaluateVisualVisionGate(input: {
  routes: readonly CaptureRoute[];
  reputationSignal: ReputationSignal;
  providerKey: AiReviewProviderKey | null;
  selfHostVisionAvailable?: boolean;
}): VisualVisionGateResult {
  if (input.reputationSignal === "low") return { run: false, reason: "low_reputation" };
  if (!input.providerKey && !input.selfHostVisionAvailable) return { run: false, reason: "byok_not_configured" };
  const routes = selectRoutesForVisualVision(input.routes);
  if (routes.length === 0) return { run: false, reason: "no_confirmed_regression" };
  return { run: true, routes };
}

/** One vision observation the model reported for a specific route — both fields already public-safe (see
 *  {@link parseVisualVisionResponse}). */
export type VisualVisionFinding = { path: string; body: string };

/** Cap on findings kept from a single vision response — mirrors `composeAdvisoryNotes`'s selectivity so a
 *  verbose model can't pad the comment with a long list of minor observations. */
const MAX_VISUAL_FINDINGS = 3;

export const VISUAL_VISION_SYSTEM_PROMPT = [
  "You are reviewing a BEFORE (production) vs AFTER (this pull request's preview deploy) screenshot pair for the same route.",
  'Respond with ONLY a JSON object of this exact shape (no prose, no code fence): {"findings": [{"path": string, "body": string}]}.',
  "Report a finding ONLY for a genuine, visually-confirmable regression introduced by the AFTER screenshot — broken layout,",
  "overlapping/clipped/unstyled content, a missing or misplaced element, unreadable contrast, or obvious placeholder content.",
  "Each body is ONE sentence, specific to what you SEE (not what the diff pixels imply). Do NOT report a color/spacing/copy",
  "change that still looks like a normal, intentional design update. Return an empty findings array when the AFTER screenshot",
  "looks like a legitimate, correctly-rendered page. Never mention rewards, payouts, wallets, hotkeys, coldkeys, or trust scores.",
].join(" ");

/** Build the user-turn text naming the route(s) under review, ahead of their image content blocks — the
 *  caller attaches the actual before/after images (see `../../types`'s `AiContentBlock`); this module only
 *  builds the text half of the request. */
export function buildVisualVisionUserPrompt(routes: readonly { path: string }[]): string {
  const paths = routes.map((route) => `- ${route.path}`).join("\n");
  return `Route(s) under review:\n${paths}\n\nEach route's images are attached in before, after order.`;
}

/** Parse the model's structured vision response into public-safe findings, dropping anything unparseable, a
 *  blank path/body, or a body that trips the public/private boundary (`toPublicSafe`). Bounded to
 *  {@link MAX_VISUAL_FINDINGS}. Never throws — an unparseable response degrades to `[]`, the same fail-safe
 *  convention `parseModelReview` uses. */
export function parseVisualVisionResponse(text: string): VisualVisionFinding[] {
  const raw = extractLastJsonObject(text);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const findingsRaw = (parsed as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(findingsRaw)) return [];
  const out: VisualVisionFinding[] = [];
  for (const entry of findingsRaw) {
    if (out.length >= MAX_VISUAL_FINDINGS) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const rawBody = typeof record.body === "string" ? record.body : "";
    const body = toPublicSafe(rawBody);
    if (!path || !body) continue;
    out.push({ path, body });
  }
  return out;
}

/** Build the ADVISORY-ONLY findings for the unified comment (#4111) — one per vision observation, feeding the
 *  SAME `advisory.findings` pipeline `ai_consensus_defect`/`ai_review_split` already ride (see this file's
 *  header for why `visual_regression_finding` can never become a blocker). `severity: "warning"` is required,
 *  not incidental — `evaluateGateCheckCore` (src/rules/advisory.ts) only carries `"warning"`-severity findings
 *  into `gate.warnings` at all, so anything else would silently vanish from the rendered comment. */
export function buildVisualRegressionFindings(findings: readonly VisualVisionFinding[]): AdvisoryFinding[] {
  return findings.map((finding) => ({
    code: VISUAL_REGRESSION_FINDING_CODE,
    severity: "warning",
    title: `Possible visual regression: ${finding.path}`,
    detail: finding.body,
    action: "Advisory only — verify against the Visual preview screenshots before deciding.",
  }));
}
