// Content/registry surface-lane HOST ADAPTER (#1255 convergence, spec resolution #2435). `runSurfaceReview` is a
// pure, AI-FREE, structured-data adjudicator for registry-submission PRs. This file is the thin host wiring that
// lets its deterministic verdict drive the SAME gate disposition (check-run + auto-action + public comment) the
// generic gate produces: the flag + per-repo RegistryLaneSpec resolution, the GitHub-backed loadFile, and the
// verdict → GateCheckEvaluation conversion.
//
// FLAG-GATED + DEFAULT-OFF: GITTENSORY_REVIEW_CONTENT_LANE must be truthy, AND `resolveRegistryLaneSpec`
// (content-lane/spec-resolver.ts) must resolve a spec for this repo — either an explicit per-repo `.gittensory.yml`
// `contentLane:` config, or (today's zero-config default) the repo being in the GITTENSORY_REVIEW_REPOS cutover
// allowlist, which resolves to METAGRAPHED_LANE_SPEC. When off / unresolved (the default for any repo that hasn't
// opted in) the caller takes no new branch, runs no fetch, and `gateEvaluation` is byte-identical to today. The
// verdict NEVER depends on an AI model, so this is independent of the AI-reviewer accuracy work (the surface lane
// emits none of the AI_JUDGMENT_BLOCKER_CODES).
//
// SAFETY (three deliberate guards):
//  1. A generic HARD (non-AI-judgment) blocker — e.g. a committed secret detected before this runs — is PRESERVED:
//     a surface "merge" can never clear a real critical the generic gate already raised (applySurfaceGate unions
//     them).
//  2. An unreadable head — or a null base on a file GitHub marks "modified" (whose base MUST exist, so a null
//     read is a transient blip, not an absent base) — defers to the generic gate rather than auto-closing a good
//     PR on a spurious "the submission looks empty/invalid" read. (A null base on an ADDED file is the expected
//     brand-new-entry case and is not deferred.)
//  3. A generic failure caused SOLELY by AI-judgment blockers (`ai_consensus_defect` / `ai_review_split`) does
//     NOT override a decisive surface verdict (applySurfaceGate). The surface lane is the sole, AI-free
//     adjudicator for this structured data — an AI opinion has no standing to veto it, only a real deterministic
//     blocker does (see guard #1).
import { AI_JUDGMENT_BLOCKER_CODES, type GateCheckEvaluation, isAiJudgmentOnlyFailure } from "../rules/advisory";
import { GITTENSORY_GATE_CHECK_NAME } from "./check-names";
import { isContentLaneEnabled } from "./content-lane/flag";
import { runSurfaceReview, type SurfaceReviewInput, type SurfaceReviewResult } from "./content-lane/orchestrator";
import type { RegistryLaneSpec } from "./content-lane/registry-logic";
import { registeredValidatorIds, resolveRegistryLaneSpec, unregisteredValidatorId } from "./content-lane/spec-resolver";
import { makeGithubFileFetcher } from "./grounding-wire";
import type { FocusManifest } from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import type { AdvisoryFinding, AdvisorySeverity } from "../types";

// Deterministic surface-lane finding codes. DELIBERATELY NOT in AI_JUDGMENT_BLOCKER_CODES; surface closes are
// facts, and blocker findings must never be flipped to merge by green CI.
const SURFACE_REJECT_CODE = "surface_lane_reject";
const SURFACE_MANUAL_CODE = "surface_lane_manual";
const SURFACE_UNKNOWN_VALIDATOR_CODE = "surface_lane_unknown_validator_id";
const SURFACE_TITLE = "Registry surface review";

function surfaceFinding(code: string, severity: AdvisorySeverity, summary: string): AdvisoryFinding {
  return { code, title: SURFACE_TITLE, severity, detail: summary, publicText: summary };
}

/** A diagnostic (non-blocking) finding for a `.gittensory.yml` `contentLane.validatorId` that doesn't match any
 *  code-registered validator — most likely an operator typo. Without this, `buildRegistryLaneSpecFromConfig`
 *  degrades silently to structural-only gating (a legitimate mode for a registry with no validator yet), which
 *  makes a typo indistinguishable from a deliberate choice. Surfaced the SAME way a surface verdict is (pushed
 *  onto `advisory.findings`) so it renders directly in the PR comment an operator is already reading, rather than
 *  requiring a separate manifest-diagnostics lookup. */
function unregisteredValidatorIdFinding(badId: string): AdvisoryFinding {
  const knownText = registeredValidatorIds().join(", ");
  const summary = `contentLane.validatorId "${badId}" is not a registered validator (known: ${knownText}); falling back to structural-only review with no domain validator.`;
  return surfaceFinding(SURFACE_UNKNOWN_VALIDATOR_CODE, "warning", summary);
}

/** Convert the deterministic surface verdict into a gate evaluation. merge→success, manual→neutral
 *  (a warning, not auto-closed and not a failing required check), and any decisive non-merge/non-manual verdict (close) → failure with a single
 *  critical blocker. Returns the finding to splice into the advisory so the public comment renders the reason. */
export function surfaceVerdictToGate(result: SurfaceReviewResult): {
  evaluation: GateCheckEvaluation;
  finding: AdvisoryFinding | null;
} {
  const summary = result.summary ?? "Registry surface review.";
  if (result.verdict === "merge") {
    return { evaluation: { enabled: true, conclusion: "success", title: SURFACE_TITLE, summary, blockers: [], warnings: [] }, finding: null };
  }
  if (result.verdict === "manual") {
    const finding = surfaceFinding(SURFACE_MANUAL_CODE, "warning", summary);
    return { evaluation: { enabled: true, conclusion: "neutral", title: SURFACE_TITLE, summary, blockers: [], warnings: [finding] }, finding };
  }
  const finding = surfaceFinding(SURFACE_REJECT_CODE, "critical", summary);
  return { evaluation: { enabled: true, conclusion: "failure", title: SURFACE_TITLE, summary, blockers: [finding], warnings: [] }, finding };
}

/** Merge the surface override onto the generic gate while PRESERVING the generic gate's hard (non-AI-judgment)
 *  blockers. A surface "merge" must NOT clear a real critical (e.g. a committed secret) the generic gate already
 *  raised — so when the generic gate carries such blockers, they survive and the conclusion stays a failure.
 *  `null` surface ⇒ defer (the generic gate is returned unchanged). PURE.
 *
 *  EXCEPTION: when the generic gate's ONLY blockers are AI-judgment codes (`ai_consensus_defect` /
 *  `ai_review_split`, see `isAiJudgmentOnlyFailure`), a decisive surface merge overrides them — the surface lane
 *  is the sole, AI-free adjudicator for this structured registry data (its own secrets/shape/safety scan already
 *  runs independently), so an AI opinion alone must never veto a verdict the deterministic lane already reached.
 *  A real (non-AI) blocker in the mix still falls through to the union below and blocks. The generic gate's
 *  OTHER (non-blocker) warnings are unrelated to the discarded AI blocker and are preserved onto the surface
 *  result rather than silently dropped — see `evaluateWithSurfaceLane` for the companion `advisory.findings`
 *  cleanup that keeps the public comment from re-surfacing the overridden AI defect via a separate path. */
export function applySurfaceGate(
  generic: GateCheckEvaluation | undefined,
  surface: GateCheckEvaluation | null,
): GateCheckEvaluation | undefined {
  if (surface === null) return generic;
  if (!generic) return surface; // gate off → surface stands
  // A generic manual-review HOLD is encoded as a non-success conclusion with warning(s), not as a hard blocker.
  // Preserve it over a surface-lane merge so size/guardrail holds cannot be erased by the content lane (#gate-size).
  if (generic.blockers.length === 0 && generic.conclusion === "success") return surface; // generic was clean → surface stands
  if (generic.blockers.length === 0) {
    if (surface.conclusion === "success") return generic;
    return surface;
  }
  if (isAiJudgmentOnlyFailure(generic) && surface.conclusion === "success") {
    return { ...surface, warnings: [...generic.warnings, ...surface.warnings] };
  }
  return {
    enabled: true,
    conclusion: "failure",
    title: surface.title,
    summary: surface.summary,
    blockers: [...generic.blockers, ...surface.blockers],
    warnings: [...generic.warnings, ...surface.warnings],
  };
}

/** Run the deterministic surface review for a registry-submission PR against `spec` (the caller's already-resolved
 *  RegistryLaneSpec — see `resolveRegistryLaneSpec`) and return its gate evaluation, or `null` to defer to the
 *  generic gate (not a submission, or an unreadable file — see below). Mutates `advisory.findings` so the reason
 *  renders in the unified public comment. NEVER throws on a fetch blip — the file fetcher is fail-safe.
 *  `loadFileOverride` is injected by unit tests; production builds a lazy GitHub-Contents-backed loader so a
 *  non-submission PR (the common case) pays for no fetch at all. `files` carries each changed file's GitHub
 *  status so a null BASE read can be told apart from an absent base (see the defer guard). */
export async function runRegistrySurfaceGate(
  env: Env,
  spec: RegistryLaneSpec,
  args: {
    installationId: number | null | undefined;
    repoFullName: string;
    pr: { headSha: string; baseRef: string };
    advisory: { findings: AdvisoryFinding[] };
    files: { path: string; status?: string | null | undefined }[];
  },
  loadFileOverride?: SurfaceReviewInput["loadFile"],
): Promise<GateCheckEvaluation | null> {
  let fetcherPromise: ReturnType<typeof makeGithubFileFetcher> | null = null;
  const githubLoad = async (path: string, ref: "head" | "base"): Promise<string | null> => {
    fetcherPromise ??= makeGithubFileFetcher(env, args.repoFullName, args.installationId);
    const fetcher = await fetcherPromise;
    return fetcher.getFileContent(path, ref === "head" ? args.pr.headSha : args.pr.baseRef);
  };
  const baseLoad = loadFileOverride ?? githubLoad;
  const statusByPath = new Map(args.files.map((file) => [file.path, file.status ?? null]));
  let deferUnreadable = false;
  const loadFile = async (path: string, ref: "head" | "base"): Promise<string | null> => {
    const content = await baseLoad(path, ref);
    // An unreadable HEAD — or a null BASE for a file GitHub reports as "modified" (whose base MUST exist, so a
    // null read is a transient fetch blip, NOT an absent base) — would make a valid submission read as empty/
    // invalid → a spurious one-shot close. Defer to the generic gate instead. A null base for an ADDED file is
    // the expected brand-new-entry case and is left to the orchestrator, whose spec-driven entry-count policy
    // decides the verdict (the resolved spec's own maxAppendedEntries — e.g. METAGRAPHED_LANE_SPEC allows any
    // number of clean entries).
    if (ref === "head" && content === null) deferUnreadable = true;
    if (ref === "base" && content === null && statusByPath.get(path) === "modified") deferUnreadable = true;
    return content;
  };
  const result = await runSurfaceReview(spec, {
    changedFiles: args.files.map((file) => file.path),
    loadFile,
    opts: { secretsScan: true, sourceUrlValidation: true },
  });
  if (result === null) return null; // not a registry submission → the generic gate applies
  if (deferUnreadable) return null; // a fetch blip on a file that must be readable → defer, never auto-close
  const { evaluation, finding } = surfaceVerdictToGate(result);
  if (finding) args.advisory.findings.push(finding);
  return evaluation;
}

/** Resolve the head/base refs the surface loader needs from a (nullable) PR record: head SHA, and base ref
 *  falling back to the repo default branch then empty. PURE — keeps the nullable-field branches out of the hot
 *  processor seam so they're unit-tested here. */
export function resolveSurfaceRefs(
  pr: { headSha?: string | null | undefined; baseRef?: string | null | undefined },
  repo: { defaultBranch?: string | null | undefined } | null | undefined,
): { headSha: string; baseRef: string } {
  return { headSha: pr.headSha ?? "", baseRef: pr.baseRef ?? repo?.defaultBranch ?? "" };
}

/** The processor SEAM in one testable call: when a RegistryLaneSpec resolves for this repo (see
 *  `resolveRegistryLaneSpec` — an explicit per-repo `.gittensory.yml` `contentLane:` config, or the
 *  GITTENSORY_REVIEW_REPOS allowlist default), run the surface lane against it and merge its verdict onto the
 *  generic gate (preserving generic hard blockers); otherwise return the generic evaluation unchanged.
 *  `getChangedFiles` is a thunk so an unresolved repo resolves no files (no extra diff load). The env kill-switch
 *  is checked BEFORE loading the manifest, so a globally-disabled lane pays no manifest-load I/O either.
 *
 *  When `applySurfaceGate`'s AI-judgment override fires (an AI-judgment-only generic failure is overridden by a
 *  decisive surface merge), the AI-judgment finding(s) are ALSO removed from `args.advisory.findings` — that
 *  array is a separate, raw feed the unified-comment bridge reads independently via `consensusDefectFromFindings`
 *  (src/review/unified-comment-bridge.ts) to render the "Code review" reviewer note, bypassing the gate
 *  evaluation entirely. Without this cleanup, the public comment would still show "Concerns raised — review
 *  before merging" quoting the overridden AI defect even though the gate the same comment reports is a clean
 *  merge — a visible, confusing contradiction of the override this function just made.
 *
 *  `loadManifestOverride` is injected by unit tests (mirrors `runRegistrySurfaceGate`'s `loadFileOverride`) so
 *  they never hit the real cached-manifest loader's D1/network I/O; production omits it and gets the real,
 *  cached `loadRepoFocusManifest`. A manifest-load failure never throws OUT of this function: for an allowlisted
 *  repo it still degrades to the allowlist-default spec (unaffected, since that path never reads the manifest);
 *  for a non-allowlisted repo — whose ONLY way to configure a spec is that same manifest — it instead holds the
 *  gate neutral (unless a real generic hard blocker is already present, which is always preserved) rather than
 *  silently looking identical to "this repo has no content-lane configured at all".
 *
 *  An unregistered `contentLane.validatorId` in the loaded manifest pushes a non-blocking diagnostic finding
 *  (`unregisteredValidatorIdFinding`) onto `args.advisory.findings` so an operator typo (e.g. "metagraph" instead
 *  of "metagraphed") is visible in the PR comment instead of silently degrading to structural-only review. */
export async function evaluateWithSurfaceLane(
  env: Env,
  repoFullName: string,
  gateEnabled: boolean,
  gateEvaluation: GateCheckEvaluation | undefined,
  args: {
    installationId: number | null | undefined;
    pr: { headSha?: string | null | undefined; baseRef?: string | null | undefined };
    repo: { defaultBranch?: string | null | undefined } | null | undefined;
    advisory: { findings: AdvisoryFinding[] };
    getChangedFiles: () => Promise<{ path: string; status?: string | null | undefined }[]>;
  },
  loadManifestOverride?: (env: Env, repoFullName: string) => Promise<FocusManifest>,
): Promise<GateCheckEvaluation | undefined> {
  if (!gateEnabled || !isContentLaneEnabled(env)) return gateEvaluation;
  const loadManifest = loadManifestOverride ?? loadRepoFocusManifest;
  // loadRepoFocusManifest itself already degrades a fetch/parse blip to an EMPTY manifest (a legitimate "no
  // config" signal) internally, so this catch only fires for a rarer failure outside that (e.g. the cache
  // read/write layer). Track that distinctly from a genuinely-empty manifest: for a repo NOT on the
  // isConvergenceRepoAllowed cutover list, `contentLane:` in its own `.gittensory.yml` is the ONLY way to
  // resolve a spec (#2435) -- so `manifest` reading as absent here is indistinguishable, downstream, from
  // "this repo never configured content-lane at all", and would silently skip the registry gate on nothing
  // more than a transient read failure for exactly the self-hosted-maintainer use case this PR exists to
  // support. An allowlisted repo is unaffected either way, since its fallback (METAGRAPHED_LANE_SPEC) never
  // depends on the manifest.
  let manifest: FocusManifest | undefined;
  let manifestLoadFailed = false;
  try {
    manifest = await loadManifest(env, repoFullName);
  } catch {
    manifestLoadFailed = true;
  }
  const badValidatorId = unregisteredValidatorId(manifest?.contentLane);
  if (badValidatorId) args.advisory.findings.push(unregisteredValidatorIdFinding(badValidatorId));
  const spec = resolveRegistryLaneSpec(env, manifest, repoFullName);
  if (!spec) {
    // A real hard blocker the generic gate already raised (e.g. a committed secret) must never be cleared by
    // this path — mirrors applySurfaceGate's own guard #1. Only override when there is nothing to preserve.
    if (!manifestLoadFailed || (gateEvaluation && gateEvaluation.blockers.length > 0)) return gateEvaluation;
    // We could not read this repo's manifest AND it resolved to no spec — cannot rule out a configured
    // contentLane block being silently skipped. Hold rather than let this look identical to "not configured".
    return {
      enabled: true,
      conclusion: "neutral",
      title: `${GITTENSORY_GATE_CHECK_NAME} — held for human review`,
      summary: "The repo's .gittensory.yml could not be read, so Gittensory cannot confirm whether a registry content-lane is configured for this repo. The gate is held for a human reviewer rather than silently skipping the registry check. It re-evaluates on the next update.",
      blockers: [],
      warnings: gateEvaluation?.warnings ?? [],
    };
  }
  const surfaceGate = await runRegistrySurfaceGate(env, spec, {
    installationId: args.installationId,
    repoFullName,
    pr: resolveSurfaceRefs(args.pr, args.repo),
    advisory: args.advisory,
    files: await args.getChangedFiles(),
  });
  const result = applySurfaceGate(gateEvaluation, surfaceGate);
  if (gateEvaluation && surfaceGate?.conclusion === "success" && isAiJudgmentOnlyFailure(gateEvaluation)) {
    args.advisory.findings = args.advisory.findings.filter((finding) => !AI_JUDGMENT_BLOCKER_CODES.has(finding.code));
  }
  return result;
}
