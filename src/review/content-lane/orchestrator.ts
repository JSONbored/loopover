// Deterministic surface-model review orchestrator (no AI — surfaces are structured data; gittensory is the
// sole adjudicator). Given a lane spec, the PR's changed files, and an injected file-content loader, it:
//   1. classifies the PR via classifyRegistryPrScope (entry / provider / not-a-direct-submission),
//   2. loads the head (+ base, for entries) document content,
//   3. resolves the SINGLE appended surfaces[] entry by diffing head vs base, and
//   4. returns a normalized verdict from assessSubnetDocument / assessProviderDocument.
// Pure + injectable: unit tests pass a loadFile stub, so no network. The live wiring (a per-repo,
// flag-gated branch in the review body) is a separate follow-up.
import {
  type ProviderAssessment,
  type RegistryLaneSpec,
  type Verdict,
  assessProviderDocument,
  assessSubnetDocument,
  classifyRegistryPrScope,
  isRegistrySubmissionScope,
  toCoreVerdict,
} from "./registry-logic";

export interface SurfaceReviewInput {
  changedFiles: string[];
  /** Loads decoded file content at a ref; injected so unit tests need no network. Returns null when absent. */
  loadFile: (path: string, ref: "head" | "base") => Promise<string | null>;
  opts?: { secretsScan?: boolean; sourceUrlValidation?: boolean };
}

export interface SurfaceReviewResult {
  verdict: Verdict;
  summary?: string | undefined;
  reason?: string | undefined;
}

function safeParseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function surfacesOf(doc: unknown, field: string): unknown[] | null {
  const arr = (doc as Record<string, unknown> | null)?.[field];
  return Array.isArray(arr) ? arr : null;
}

/**
 * The single surfaces[] entry present at head but absent at base — the deterministic "exactly one appended
 * entry" rule. Returns null when head is unreadable / has no surfaces[] array, or when the count of added
 * entries !== 1 (a reorder/reformat/edit of existing entries reads as multiple "added" and is rejected upstream).
 * A missing base file (a brand-new entry file) means every head entry is new, so it passes only when there is one.
 */
export function diffAppendedSurfaceEntry(headRaw: string | null, baseRaw: string | null, field: string): unknown {
  const headEntries = surfacesOf(safeParseJson(headRaw), field);
  if (headEntries === null) return null;
  const baseEntries = surfacesOf(safeParseJson(baseRaw), field) ?? [];
  const baseKeys = new Set(baseEntries.map((entry) => JSON.stringify(entry)));
  const added = headEntries.filter((entry) => !baseKeys.has(JSON.stringify(entry)));
  return added.length === 1 ? added[0] : null;
}

function fromProvider(assessment: ProviderAssessment): SurfaceReviewResult {
  // Conservative routing: a valid provider merges; an invalid one goes to HUMAN review — never an auto-close.
  return assessment.ok
    ? { verdict: "merge", summary: assessment.summary }
    : { verdict: "manual", summary: assessment.summary, reason: assessment.reason };
}

/**
 * Adjudication policy (deterministic): auto-close is reserved for a clean single-append whose entry has a CLEAR
 * violation (secret, not public_safe, observed-state claim, unsafe URL, unsupported kind, non-integer root netuid)
 * — the unambiguous "resubmit clean" cases assessSubnetDocument already returns `closed` for. Everything ambiguous
 * (not a direct submission, not a clean single append, an invalid provider) routes to MANUAL review and is never
 * auto-closed, so a legitimate edit/refactor PR can't be one-shot-closed.
 */
export async function runSurfaceReview(spec: RegistryLaneSpec, input: SurfaceReviewInput): Promise<SurfaceReviewResult> {
  const scope = classifyRegistryPrScope(spec, input.changedFiles);
  if (!isRegistrySubmissionScope(scope.scope)) {
    return { verdict: "manual", summary: "Not a direct registry surface or provider submission — routing to review." };
  }
  // A submission scope (entry/provider) always carries a directFile (classifier invariant; see classifyRegistryPrScope).
  const directFile = scope.directFile as string;
  const headRaw = await input.loadFile(directFile, "head");
  if (scope.isProvider) {
    return fromProvider(assessProviderDocument(safeParseJson(headRaw), input.opts));
  }
  const baseRaw = await input.loadFile(directFile, "base");
  const appendedEntry = diffAppendedSurfaceEntry(headRaw, baseRaw, spec.collectionField);
  if (appendedEntry === null) {
    return { verdict: "manual", summary: "PR does not cleanly append exactly one surface entry — routing to review." };
  }
  const assessment = assessSubnetDocument(safeParseJson(headRaw), { ...input.opts, appendedEntry });
  return { verdict: toCoreVerdict(assessment.verdict), summary: assessment.summary, reason: assessment.reason };
}
