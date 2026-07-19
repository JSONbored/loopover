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

/** The advisory finding code an "unrelated" (pre-existing, out-of-scope) visual observation is published
 *  under (`review.visual.bugAnalysis`) — rides the identical strictly-advisory contract as
 *  {@link VISUAL_REGRESSION_FINDING_CODE} (this file's header), also deliberately absent from
 *  `isConfiguredGateBlocker`'s allowlist. Distinct from the regression code so the unified comment / any
 *  future automation can tell "this PR broke something" apart from "this PR's screenshots happen to show a
 *  pre-existing problem" — the latter is never this PR's fault and should never read like a blocker. */
export const VISUAL_UNRELATED_ISSUE_FINDING_CODE = "visual_unrelated_issue_finding";

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

/** One vision observation the model reported for a specific route — `path`/`body` already public-safe (see
 *  {@link parseVisualVisionResponse}). `category` is only ever populated when the caller used
 *  {@link VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT} (`review.visual.bugAnalysis`) — the default prompt
 *  ({@link VISUAL_VISION_SYSTEM_PROMPT}) never asks the model for one, so it's absent (parsed as
 *  `"regression"`, {@link buildVisualRegressionFindings}'s default) for every repo that hasn't opted in,
 *  byte-identical to pre-bugAnalysis behavior. `"regression"` = a defect this PR's own change introduced;
 *  `"unrelated"` = a pre-existing problem visible in either screenshot that has nothing to do with this PR's
 *  stated change. */
export type VisualVisionFinding = { path: string; body: string; category?: "regression" | "unrelated" };

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

/** `review.visual.bugAnalysis`'s enhanced vision prompt — same before/after image contract as
 *  {@link VISUAL_VISION_SYSTEM_PROMPT}, but PR-intent-aware and dual-category: it reports a genuine defect
 *  the PR's OWN change introduced ("regression") separately from a pre-existing problem the screenshots
 *  happen to reveal that has nothing to do with the PR's stated intent ("unrelated") — e.g. broken styling on
 *  a neighboring component the diff never touches. This is deliberately a SEPARATE prompt from the default,
 *  not a superset toggle on it: a repo that hasn't opted in must see byte-identical model behavior, and this
 *  prompt's added PR-context/category instructions are exactly the kind of thing that could otherwise subtly
 *  shift a model's existing regression-detection behavior even when the caller never intended a change. */
export const VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT = [
  "You are reviewing a BEFORE (production) vs AFTER (this pull request's preview deploy) screenshot pair for the same route,",
  "with the pull request's own stated title/description as context for what this change is supposed to do.",
  'Respond with ONLY a JSON object of this exact shape (no prose, no code fence): {"findings": [{"path": string, "body": string, "category": "regression" | "unrelated"}]}.',
  'Report a "regression" finding ONLY for a genuine, visually-confirmable defect that this PR\'s OWN change introduced —',
  "broken layout, overlapping/clipped/unstyled content, a missing or misplaced element, unreadable contrast, or obvious",
  'placeholder content. Report an "unrelated" finding for a genuine visual problem you can see in EITHER screenshot that has',
  "nothing to do with the PR's stated change — a pre-existing bug on the same page the diff never touches. Judge relatedness",
  "against the stated title/description, not against which pixels happen to differ. Do NOT report a color/spacing/copy change",
  "that still looks like a normal, intentional part of the stated change. Each body is ONE sentence, specific to what you SEE.",
  "Return an empty findings array when the AFTER screenshot looks like a legitimate, correctly-rendered page with nothing",
  "else visibly wrong. Never mention rewards, payouts, wallets, hotkeys, coldkeys, or trust scores.",
].join(" ");

/** Build the user-turn text for {@link VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT} — same route-listing contract as
 *  {@link buildVisualVisionUserPrompt}, plus the PR's own stated title/description (when available) so the
 *  model can judge whether an observation is in- or out-of-scope. A null/blank title AND body still produces
 *  a valid prompt (the model falls back to judging purely from what it sees) — this is a best-effort context
 *  addition, not a hard requirement. */
export function buildVisualBugAnalysisUserPrompt(routes: readonly { path: string }[], pr: { title?: string | null | undefined; body?: string | null | undefined }): string {
  const paths = routes.map((route) => `- ${route.path}`).join("\n");
  const title = pr.title?.trim();
  const body = pr.body?.trim();
  const prContext =
    title || body
      ? `Pull request's stated change:\n${title ? `Title: ${title}\n` : ""}${body ? `Description: ${body.slice(0, 2000)}\n` : ""}\n`
      : "";
  return `${prContext}Route(s) under review:\n${paths}\n\nEach route's images are attached in before, after order.`;
}

/** Parse the model's structured vision response into public-safe findings, dropping anything unparseable, a
 *  blank path/body, or a body that trips the public/private boundary (`toPublicSafe`). Bounded to
 *  {@link MAX_VISUAL_FINDINGS}. Never throws — an unparseable response degrades to `[]`, the same fail-safe
 *  convention `parseModelReview` uses. `category` is parsed permissively: absent/unrecognized ⇒ undefined
 *  (treated as `"regression"` by every caller, e.g. {@link buildVisualRegressionFindings}) — the default
 *  prompt never asks for one, so this keeps that path byte-identical while still accepting a valid category
 *  from the bug-analysis prompt. */
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
    const category = record.category === "regression" || record.category === "unrelated" ? record.category : undefined;
    out.push(category ? { path, body, category } : { path, body });
  }
  return out;
}

/** Build the ADVISORY-ONLY findings for the unified comment (#4111 / `review.visual.bugAnalysis`) — one per
 *  vision observation, feeding the SAME `advisory.findings` pipeline `ai_consensus_defect`/`ai_review_split`
 *  already ride (see this file's header for why neither finding code can ever become a blocker).
 *  `severity: "warning"` is required, not incidental — `evaluateGateCheckCore` (src/rules/advisory.ts) only
 *  carries `"warning"`-severity findings into `gate.warnings` at all, so anything else would silently vanish
 *  from the rendered comment. An `"unrelated"`-category finding (only ever produced by
 *  {@link VISUAL_BUG_ANALYSIS_SYSTEM_PROMPT}) gets its own code + a distinct message suggesting the observer
 *  open a separate issue, since it is — by construction — not this PR's fault and must never read like one. */
export function buildVisualRegressionFindings(findings: readonly VisualVisionFinding[]): AdvisoryFinding[] {
  return findings.map((finding) =>
    finding.category === "unrelated"
      ? {
          code: VISUAL_UNRELATED_ISSUE_FINDING_CODE,
          severity: "warning",
          title: `Possible unrelated visual issue: ${finding.path}`,
          detail: finding.body,
          action: "Advisory only — this doesn't look related to this PR's stated change. Consider opening a new issue to track it separately.",
        }
      : {
          code: VISUAL_REGRESSION_FINDING_CODE,
          severity: "warning",
          title: `Possible visual regression: ${finding.path}`,
          detail: finding.body,
          action: "Advisory only — verify against the Visual preview screenshots before deciding.",
        },
  );
}
