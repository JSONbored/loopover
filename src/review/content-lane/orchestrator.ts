// Deterministic surface-model review orchestrator (no AI — surfaces are structured data; loopover is the
// sole adjudicator). Given a lane spec, the PR's changed files, and an injected file-content loader, it:
//   1. classifies the PR via classifyRegistryPrScope (entry / provider / not-a-direct-submission),
//   2. loads the head (+ base, for entries) document content,
//   3. resolves the appended surfaces[] entries by diffing head vs base, capped at the spec's maxAppendedEntries
//      (omitted ⇒ today's strict single-entry-only default),
//   4. rejects a duplicate appended entry when the spec opts into duplicateKeyFields (omitted ⇒ off), and
//   5. validates EACH remaining appended entry independently via the spec's OWN assessAppendedEntry /
//      assessProviderEntry validators (the orchestrator never hardcodes a domain-specific validator — a spec
//      with no validator configured gets "manual") and returns one aggregate verdict: close if any entry is
//      invalid, manual if any (remaining) needs manual review, merge only when every entry is clean, and
//   6. for an entry submission riding alongside a path-shaped provider companion file, confirms the companion is
//      actually a DEBUT (absent at base — an edit to an already-registered provider routes to manual instead),
//      then validates it via assessProviderEntry and combines it with the entry's own result — merge only when
//      BOTH sides are clean.
// Pure + injectable: unit tests pass a loadFile stub, so no network. The live wiring (a per-repo,
// flag-gated branch in the review body) is a separate follow-up.
import {
  type Assessment,
  type ProviderAssessment,
  type RegistryLaneSpec,
  type Verdict,
  classifyRegistryPrScope,
  findDuplicateAppendedEntry,
  toCoreVerdict,
} from "./registry-logic";

export interface SurfaceReviewInput {
  changedFiles: string[];
  /** Loads decoded file content at a ref; injected so unit tests need no network. Returns null when absent. */
  loadFile: (path: string, ref: "head" | "base") => Promise<string | null>;
  opts?: { secretsScan?: boolean; sourceUrlValidation?: boolean };
  /** Optional LIVE content verification for an entry that already passed static validation (#8908, #8909) —
   *  injected I/O, exactly like `loadFile`, so the orchestrator stays pure and domain-agnostic and any registry
   *  can supply its own verifier (metagraphed's is `makeSurfaceEntryVerifier` in ./surface-verification).
   *  Returns an OVERRIDING Assessment when verification downgrades the entry (hold or close), or `null` when it
   *  confirms it (the static assessment stands). Omitted ⇒ no verification runs and no fetch is made, so the
   *  verdict is byte-identical to the pre-#8908 lane. */
  verifyEntry?: (entry: unknown) => Promise<Assessment | null>;
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
 * byte-identical reorder reads as zero "added" — an actual FIELD EDIT to an existing entry does NOT: the edited
 * entry's new content differs from every base entry, so it reads as one "added" entry, same as a brand-new
 * append — see survivingExistingEntries below for how the caller tells the two apart before duplicate-checking).
 * A missing base file (a brand-new entry file) means every head entry is new. Makes no count judgement itself —
 * the caller (runSurfaceReview) enforces the spec's maxAppendedEntries cap and the ≥1-entry requirement.
 */
export function diffAppendedSurfaceEntries(headRaw: string | null, baseRaw: string | null, field: string): unknown[] | null {
  const headEntries = surfacesOf(safeParseJson(headRaw), field);
  if (headEntries === null) return null;
  const baseEntries = surfacesOf(safeParseJson(baseRaw), field) ?? [];
  const baseKeys = new Set(baseEntries.map((entry) => canonicalEntryKey(entry)));
  return headEntries.filter((entry) => !baseKeys.has(canonicalEntryKey(entry)));
}

/**
 * #9490: entry identity, KEY-ORDER INVARIANT. Both structural diffs below used raw `JSON.stringify(entry)` as
 * the identity key, and JSON.stringify preserves insertion order -- so reordering an existing entry's keys
 * (`{url, kind}` -> `{kind, url}`) read as a FRESH append while simultaneously removing the entry's prior self
 * from survivingExistingEntries' scope, taking it out of the duplicate check too. That is a recipe for
 * unbounded content-free auto-merged registry PRs: each one "contributes" a reorder, farms a merge, and leaves
 * the registry byte-different but semantically identical. Sorting keys recursively makes a reorder read as
 * exactly what it is -- zero appended entries. Arrays keep their order (order IS meaning there, same rule as
 * decision-record.ts's canonicalJson).
 */
export function canonicalEntryKey(entry: unknown): string {
  return JSON.stringify(sortKeysDeep(entry));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Base surfaces[] entries that are STILL PRESENT, byte-identical, in the head document — i.e. entries this PR
 * left completely untouched. Feeds findDuplicateAppendedEntry's `existingEntries` argument so a submission's
 * duplicate check only ever collides against an entry that genuinely still occupies that identity in the
 * registry, not one this very PR just edited away.
 *
 * Why this matters: an in-place edit (e.g. tightening `probe.expect` on an already-registered surface, keeping
 * its url) makes diffAppendedSurfaceEntries read the edited entry as "added" (its new content differs from every
 * base entry — see that function's own doc comment), and the edited entry's identity key (typically its url)
 * still matches its OWN prior self in base. Passing the raw base surfaces[] array as `existingEntries` (the
 * pre-fix behavior) makes an entry collide with its own now-superseded version and reads as a resubmitted
 * duplicate, closing every legitimate "fix an existing surface" PR outright regardless of content correctness.
 * Filtering to only the base entries that SURVIVE into head fixes this: an edited entry's old self is gone from
 * head (replaced in place), so it is excluded here and can no longer collide with the edit. A genuine duplicate
 * resubmission is unaffected — the untouched original entry remains in head, stays in this filtered set, and
 * still collides with the newly appended entry sharing its identity, so that case still closes as before.
 *
 * Returns [] when head is unreadable (mirrors diffAppendedSurfaceEntries' own null-safety); the orchestrator only
 * reaches this after diffAppendedSurfaceEntries has already confirmed head parses with a surfaces[] array.
 */
export function survivingExistingEntries(headRaw: string | null, baseRaw: string | null, field: string): unknown[] {
  const headEntries = surfacesOf(safeParseJson(headRaw), field);
  if (headEntries === null) return [];
  const baseEntries = surfacesOf(safeParseJson(baseRaw), field) ?? [];
  // #9490: same canonical key as diffAppendedSurfaceEntries, and for the same reason -- a key-reordered entry
  // must still count as "surviving" so its identity stays inside the duplicate check's scope.
  const headKeys = new Set(headEntries.map((entry) => canonicalEntryKey(entry)));
  return baseEntries.filter((entry) => headKeys.has(canonicalEntryKey(entry)));
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
 *  the registry). Keep it fully generic: duplicate detection runs before content safety validation. */
function duplicateEntryCloseSummary(): string {
  return "A surface submission must not duplicate an entry already in this PR or already in the registry — resubmit without the duplicate.";
}

// A spec with no domain-specific validator configured yet (RegistryLaneSpec.assessAppendedEntry /
// assessProviderEntry) still gets structural gating (scope, entry-count cap, duplicate detection), but the
// orchestrator can't itself judge the entry's content — route to manual review rather than merge or close.
const NO_VALIDATOR_ENTRY_SUMMARY = "No validator is configured for this registry's surface entries — routing to review.";
const NO_VALIDATOR_PROVIDER_SUMMARY = "No validator is configured for this registry's provider submissions — routing to review.";
// classifyRegistryPrScope identifies a provider companion by FILE PATH alone (it does no I/O); that only proves
// the file is shaped like a provider submission, not that it's a genuine DEBUT (a brand-new provider, not an edit
// to one already in the registry). The orchestrator independently confirms debut-ness once it has the fetched
// content — see the base-presence check in runSurfaceReview.
const NON_DEBUT_COMPANION_SUMMARY =
  "Registry submission's provider companion already exists in the registry — this isn't a debut provider, so it needs a human to review the edit alongside the entry.";

/**
 * Combines an entry-submission's aggregate Assessment with its companion debut-provider file's ProviderAssessment
 * into ONE SurfaceReviewResult — the "entry + debut provider in the same PR" flow. `providerRaw` is already loaded
 * by the caller (in parallel with the entry's own head/base fetches — see runSurfaceReview), `assessProvider`
 * already confirmed present, and the companion already confirmed to actually BE a debut (absent at base) — so
 * this function does no I/O and can't itself punt to "no validator configured" or "not actually a debut".
 * Reuses `fromProvider` for the provider's own ok/close mapping — the same conversion the standalone provider-
 * submission scope uses — so the two paths can never silently drift apart. Decisive: close if EITHER side is
 * invalid, manual if the entry needs manual review and the provider is clean (a provider assessment is itself
 * always decisive — merge or close, never manual — so it can never be the source of a manual verdict here), merge
 * only when both are clean (forwarding the provider's own merge summary, same as a standalone provider merge).
 */
function assessEntryWithProviderCompanion(
  assessProvider: NonNullable<RegistryLaneSpec["assessProviderEntry"]>,
  entryAssessment: Assessment,
  providerRaw: string | null,
  opts: SurfaceReviewInput["opts"],
): SurfaceReviewResult {
  if (entryAssessment.verdict === "closed") {
    return { verdict: "close", summary: entryAssessment.summary, reason: entryAssessment.reason };
  }
  const providerResult = fromProvider(assessProvider(safeParseJson(providerRaw), opts));
  if (providerResult.verdict === "close") return providerResult;
  if (entryAssessment.verdict === "manual-review") {
    return { verdict: "manual", summary: entryAssessment.summary };
  }
  return providerResult;
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
 * Apply the injected live-content verifier (#8908, #8909) to every appended entry that passed STATIC validation,
 * and return the per-entry assessments with any downgrade folded in.
 *
 * Only "merged" entries are verified, for two reasons: an entry already closing or held has its verdict decided
 * (verification could only ever confirm it), and skipping them means an invalid submission — the common bad case
 * — pays for no network I/O at all. The surviving entries are verified CONCURRENTLY (independent URLs, no data
 * dependency), mirroring how this function's caller already parallelizes its GitHub reads.
 *
 * A verifier that THROWS must never take the review down or, worse, be swallowed into a pass: the entry is held
 * for review instead. `makeSurfaceEntryVerifier` is itself written not to throw, so this is a belt-and-braces
 * guard against a future/third-party verifier that is less careful.
 */
/**
 * #9490: hard ceiling on live verifications per review run. Each verification fetches up to 2 URLs, each
 * following up to 5 hops with a 10s per-hop timeout -- so an uncapped run over a spec with
 * `maxAppendedEntries: Infinity` (metagraphed's documented policy) let a 500-entry PR command thousands of
 * outbound subrequests from the bot: a request-amplification primitive, and on Workers a subrequest-exhaustion
 * path that converts into bulk `probe_fetch_failed` holds for everyone else in the isolate. Ten matches
 * source-evidence.ts's own fan-out cap. Entries past the cap are HELD for a human, never merged unverified --
 * the cap bounds spend, it must not become a way to sneak entry #11 through unprobed.
 */
export const MAX_VERIFIED_ENTRIES_PER_RUN = 10;

async function verifyMergedEntries(
  staticAssessments: Assessment[],
  appendedEntries: readonly unknown[],
  verifyEntry: SurfaceReviewInput["verifyEntry"],
): Promise<Assessment[]> {
  if (!verifyEntry) return staticAssessments;
  let verificationsStarted = 0;
  return await Promise.all(
    staticAssessments.map(async (assessment, idx) => {
      if (assessment.verdict !== "merged") return assessment;
      // Counted SYNCHRONOUSLY, before any await, so the concurrent map cannot race the budget check --
      // .map's callbacks run their synchronous prefix in order, so exactly the first N merged entries verify.
      if (verificationsStarted >= MAX_VERIFIED_ENTRIES_PER_RUN) {
        return {
          verdict: "manual-review" as const,
          summary: `This PR appends more than ${MAX_VERIFIED_ENTRIES_PER_RUN} entries needing live verification; this entry is past that per-run probe budget, so it is routed to review rather than accepted unverified.`,
          candidate: assessment.candidate,
          reason: "verification-capacity",
        };
      }
      verificationsStarted += 1;
      try {
        return (await verifyEntry(appendedEntries[idx])) ?? assessment;
      } catch {
        return {
          verdict: "manual-review" as const,
          summary: "Live verification of this surface entry could not be completed — routing to review rather than accepting an unverified entry.",
          candidate: assessment.candidate,
          reason: "verification-error",
        };
      }
    }),
  );
}

/**
 * Adjudication policy (deterministic, DECISIVE): the overwhelming majority of outcomes are merge or close —
 * manual review is the rare exception. A clean valid submission MERGES; anything invalid or non-standard
 * (a malformed/violating entry, an out-of-range append count, a duplicate entry when the spec opts into
 * duplicateKeyFields, a bundled "mixed-files" PR, an invalid provider) CLOSES with a resubmit message. A PR that
 * is NOT a registry submission at all returns `null` — the surface lane does not apply, so the caller falls
 * through to the generic gate. Residual MANUAL comes from two places: the spec's OWN per-entry validator (e.g.
 * an authenticated interface needing a human to confirm the public auth scheme — a "very few" case, and one bad
 * entry among several still closes the whole PR, see pickAggregateAssessment) — or, structurally, a spec with no
 * `assessAppendedEntry`/`assessProviderEntry` configured yet, which still gets scope/count/duplicate gating but
 * can't itself judge entry content.
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
  // NOTE the deliberate asymmetry documented on classifyRegistryPrScope's own doc comment: an entry submission
  // with an ambiguous companion shape (e.g. 2+ provider files riding along) lands HERE as a manual-review HOLD,
  // not a close — unlike the entry-FREE "2+ provider files" case, which the classifier itself closes outright as
  // mixed-files, since there's nothing else in that diff worth preserving.
  const directFile = scope.directFile as string;
  const companionProviderFile = scope.providerCompanionFile;
  // Anything besides the direct file must be the recognized debut-provider companion validated below. Generated
  // artifact companions match an allowed path pattern, but the surface lane does not prove they match the source
  // entry, so route them to manual review rather than treating arbitrary artifact content as merge-safe. Anything
  // else here is an unrecognized/ambiguous shape (classifyRegistryPrScope only reaches this scope when every file
  // matched SOME allowed pattern, so this is the residual "which companion is it" case, e.g. more than one provider
  // companion) — fall back to routing it to manual review.
  for (const file of input.changedFiles) {
    const normalized = file.trim();
    if (normalized === "" || normalized === directFile || normalized === companionProviderFile) continue;
    return { verdict: "manual", summary: "Registry submission includes companion file changes — routing to review." };
  }
  if (scope.isProvider) {
    const assessProvider = spec.assessProviderEntry;
    if (!assessProvider) {
      return { verdict: "manual", summary: NO_VALIDATOR_PROVIDER_SUMMARY };
    }
    const headRaw = await input.loadFile(directFile, "head");
    return fromProvider(assessProvider(safeParseJson(headRaw), input.opts));
  }
  // A companion provider file with no configured validator can never be judged, whatever the entry itself turns
  // out to be — hold before paying for the entry-side fetch + diff + per-entry assessment pipeline below.
  if (companionProviderFile !== null && !spec.assessProviderEntry) {
    return { verdict: "manual", summary: NO_VALIDATOR_PROVIDER_SUMMARY };
  }
  // The entry's head/base fetch and the companion provider's head/base fetch (when present) are up to four
  // independent GitHub-Contents reads with no data dependency on each other — resolve them concurrently rather
  // than paying for sequential round-trips.
  const [headRaw, baseRaw, providerHeadRaw, providerBaseRaw] = await Promise.all([
    input.loadFile(directFile, "head"),
    input.loadFile(directFile, "base"),
    companionProviderFile !== null ? input.loadFile(companionProviderFile, "head") : Promise.resolve(null),
    companionProviderFile !== null ? input.loadFile(companionProviderFile, "base") : Promise.resolve(null),
  ]);
  // A companion recognized by path alone (see classifyRegistryPrScope) is only a genuine DEBUT provider when it's
  // absent at base — the same "null base ⇒ brand-new file" convention diffAppendedSurfaceEntries already applies
  // to the entry file itself. A non-null base means this PR is editing an existing, already-registered provider
  // record alongside an unrelated entry — a materially different, more sensitive shape that needs a human, not
  // the automatic debut-provider merge/close flow below.
  if (companionProviderFile !== null && providerBaseRaw !== null) {
    return { verdict: "manual", summary: NON_DEBUT_COMPANION_SUMMARY };
  }
  const appendedEntries = diffAppendedSurfaceEntries(headRaw, baseRaw, spec.collectionField);
  const maxAppendedEntries = spec.maxAppendedEntries ?? DEFAULT_MAX_APPENDED_ENTRIES;
  if (appendedEntries === null || appendedEntries.length === 0 || appendedEntries.length > maxAppendedEntries) {
    return { verdict: "close", summary: appendCountCloseSummary(maxAppendedEntries) };
  }
  // survivingExistingEntries, not the raw base array — an entry this PR edited in place must not collide with
  // its own now-superseded prior self (see that function's doc comment for the full false-positive it fixes).
  const existingEntries = survivingExistingEntries(headRaw, baseRaw, spec.collectionField);
  const duplicate = findDuplicateAppendedEntry(spec, appendedEntries, existingEntries);
  if (duplicate !== null) {
    return { verdict: "close", summary: duplicateEntryCloseSummary() };
  }
  const assessEntry = spec.assessAppendedEntry;
  if (!assessEntry) {
    return { verdict: "manual", summary: NO_VALIDATOR_ENTRY_SUMMARY };
  }
  const headDoc = safeParseJson(headRaw);
  const staticAssessments = appendedEntries.map((appendedEntry) => assessEntry(headDoc, { ...input.opts, appendedEntry }));
  const assessment = pickAggregateAssessment(await verifyMergedEntries(staticAssessments, appendedEntries, input.verifyEntry));
  if (companionProviderFile !== null) {
    // Guaranteed non-null: the no-validator short-circuit above already returned when this spec lacks one.
    const assessProvider = spec.assessProviderEntry as NonNullable<RegistryLaneSpec["assessProviderEntry"]>;
    return assessEntryWithProviderCompanion(assessProvider, assessment, providerHeadRaw, input.opts);
  }
  return { verdict: toCoreVerdict(assessment.verdict), summary: assessment.summary, reason: assessment.reason };
}
