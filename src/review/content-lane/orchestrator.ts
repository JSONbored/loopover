// Deterministic surface-model review orchestrator (no AI — surfaces are structured data; gittensory is the
// sole adjudicator). Given a lane spec, the PR's changed files, and an injected file-content loader, it:
//   1. classifies the PR via classifyRegistryPrScope (entry / provider / not-a-direct-submission),
//   2. loads the head (+ base, for entries) document content,
//   3. resolves the appended surfaces[] entries by diffing head vs base, capped at the spec's maxAppendedEntries
//      (omitted ⇒ today's strict single-entry-only default),
//   4. rejects a duplicate appended entry when the spec opts into duplicateKeyFields (omitted ⇒ off), and
//   5. validates EACH remaining appended entry independently and returns one aggregate verdict from
//      assessSubnetDocument / assessProviderDocument: close if any entry is invalid, manual if any (remaining)
//      needs manual review, merge only when every entry is clean.
// Pure + injectable: unit tests pass a loadFile stub, so no network. The live wiring (a per-repo,
// flag-gated branch in the review body) is a separate follow-up.
import {
  type Assessment,
  type ProviderAssessment,
  type RegistryLaneSpec,
  type Verdict,
  assessProviderDocument,
  assessSubnetDocument,
  classifyRegistryPrScope,
  findDuplicateAppendedEntry,
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
 * ALL surfaces[] entries present at head but absent at base — a pure head-vs-base structural diff. Returns null
 * when head is unreadable / has no surfaces[] array; returns an empty array when nothing was added (a
 * reorder/reformat/edit of existing entries reads as zero "added"). A missing base file (a brand-new entry file)
 * means every head entry is new. Makes no count judgement itself — the caller (runSurfaceReview) enforces the
 * spec's maxAppendedEntries cap and the ≥1-entry requirement.
 */
export function diffAppendedSurfaceEntries(headRaw: string | null, baseRaw: string | null, field: string): unknown[] | null {
  const headEntries = surfacesOf(safeParseJson(headRaw), field);
  if (headEntries === null) return null;
  const baseEntries = surfacesOf(safeParseJson(baseRaw), field) ?? [];
  const baseKeys = new Set(baseEntries.map((entry) => JSON.stringify(entry)));
  return headEntries.filter((entry) => !baseKeys.has(JSON.stringify(entry)));
}

function fromProvider(assessment: ProviderAssessment): SurfaceReviewResult {
  // Decisive: a valid provider merges; an invalid one CLOSES (resubmit clean) — never a manual punt.
  return assessment.ok
    ? { verdict: "merge", summary: assessment.summary }
    : { verdict: "close", summary: assessment.summary, reason: assessment.reason };
}

// Spec-less backward compat: a lane that doesn't opt into a higher/unlimited cap stays at today's strict
// single-entry-only behavior (see RegistryLaneSpec.maxAppendedEntries).
const DEFAULT_MAX_APPENDED_ENTRIES = 1;

/** The close summary for an appended-entry count outside [1, maxAppendedEntries]. */
function appendCountCloseSummary(maxAppendedEntries: number): string {
  if (maxAppendedEntries === 1) {
    return "A surface submission must append exactly one new surfaces[] entry — resubmit a clean single-entry append.";
  }
  return Number.isFinite(maxAppendedEntries)
    ? `A surface submission must append between 1 and ${maxAppendedEntries} new surfaces[] entries in one PR — resubmit a clean append within that range.`
    : "A surface submission must append at least one new surfaces[] entry — resubmit a clean append.";
}

/** The close summary for a duplicate appended entry (a same-PR repeat, or a resubmission of an entry already in
 *  the registry) — names the colliding url when the duplicate entry has one, for a concrete resubmit target. */
function duplicateEntryCloseSummary(duplicate: unknown): string {
  const url = (duplicate as { url?: unknown } | null)?.url;
  const detail = typeof url === "string" && url.trim() !== "" ? ` (${url.trim()})` : "";
  return `A surface submission must not duplicate an entry already in this PR or already in the registry${detail} — resubmit without the duplicate.`;
}

/**
 * Aggregate N independent per-entry assessments into ONE verdict: close if ANY entry is invalid, manual if ANY
 * (of the remainder) needs manual review (e.g. auth_required), merge only if EVERY entry is clean — mirroring the
 * single-entry decisiveness policy (merge/close dominate; manual is the rare exception) at whatever count the
 * spec allows. When more than one entry was appended, the surfaced summary is prefixed with its position so a
 * multi-entry PR's close/manual reason still points at the specific offending entry.
 */
function pickAggregateAssessment(assessments: Assessment[]): Assessment {
  const count = assessments.length;
  // label() is only ever called below on a "closed" or "manual-review" assessment, and every such assessment sets
  // summary (fail() requires it; the explicit closed/manual-review returns in assessSurfaceEntry both set it) —
  // so assessment.summary is never undefined here.
  const label = (assessment: Assessment, idx: number): Assessment =>
    count <= 1 ? assessment : { ...assessment, summary: `Surface entry ${idx + 1} of ${count}: ${assessment.summary}` };
  let manual: [number, Assessment] | null = null;
  let first: Assessment | null = null;
  for (const [idx, assessment] of assessments.entries()) {
    first ??= assessment;
    if (assessment.verdict === "closed") return label(assessment, idx);
    if (manual === null && assessment.verdict === "manual-review") manual = [idx, assessment];
  }
  if (manual !== null) return label(manual[1], manual[0]);
  // Every remaining assessment.verdict is "merged" (the only member of MetaVerdict left), and runSurfaceReview
  // never calls this with an empty array (the appended-entry-count guard there returns early first).
  return first as Assessment;
}

/**
 * Adjudication policy (deterministic, DECISIVE): the overwhelming majority of outcomes are merge or close —
 * manual review is the rare exception. A clean valid submission MERGES; anything invalid or non-standard
 * (a malformed/violating entry, an out-of-range append count, a duplicate entry when the spec opts into
 * duplicateKeyFields, a bundled "mixed-files" PR, an invalid provider) CLOSES with a resubmit message. A PR that
 * is NOT a registry submission at all returns `null` — the surface lane does not apply, so the caller falls
 * through to the generic gate. The only residual MANUAL comes from the per-entry validator (an authenticated
 * interface needing a human to confirm the public auth scheme) — a "very few" case, and one bad entry among
 * several still closes the whole PR (see pickAggregateAssessment).
 */
export async function runSurfaceReview(spec: RegistryLaneSpec, input: SurfaceReviewInput): Promise<SurfaceReviewResult | null> {
  const scope = classifyRegistryPrScope(spec, input.changedFiles);
  // Not a registry submission at all (no entry/provider file) — the surface lane doesn't apply; the generic gate does.
  if (scope.scope === "not-direct-submission") {
    return null;
  }
  // A submission bundled with other file changes — close decisively; resubmit the entry on its own.
  if (scope.scope === "mixed-files") {
    return { verdict: "close", summary: "A registry submission must not bundle other file changes — resubmit the entry on its own." };
  }
  // A submission scope (entry/provider) always carries a directFile (classifier invariant; see classifyRegistryPrScope).
  const directFile = scope.directFile as string;
  for (const file of input.changedFiles) {
    const normalized = file.trim();
    if (normalized === "" || normalized === directFile) continue;
    return { verdict: "manual", summary: "Registry submission includes companion file changes — routing to review." };
  }
  const headRaw = await input.loadFile(directFile, "head");
  if (scope.isProvider) {
    return fromProvider(assessProviderDocument(safeParseJson(headRaw), input.opts));
  }
  const baseRaw = await input.loadFile(directFile, "base");
  const appendedEntries = diffAppendedSurfaceEntries(headRaw, baseRaw, spec.collectionField);
  const maxAppendedEntries = spec.maxAppendedEntries ?? DEFAULT_MAX_APPENDED_ENTRIES;
  if (appendedEntries === null || appendedEntries.length === 0 || appendedEntries.length > maxAppendedEntries) {
    return { verdict: "close", summary: appendCountCloseSummary(maxAppendedEntries) };
  }
  const existingEntries = surfacesOf(safeParseJson(baseRaw), spec.collectionField) ?? [];
  const duplicate = findDuplicateAppendedEntry(spec, appendedEntries, existingEntries);
  if (duplicate !== null) {
    return { verdict: "close", summary: duplicateEntryCloseSummary(duplicate[0]) };
  }
  const headDoc = safeParseJson(headRaw);
  const assessment = pickAggregateAssessment(
    appendedEntries.map((appendedEntry) => assessSubnetDocument(headDoc, { ...input.opts, appendedEntry })),
  );
  return { verdict: toCoreVerdict(assessment.verdict), summary: assessment.summary, reason: assessment.reason };
}
