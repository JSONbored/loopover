// Content-addressed decision records (#8836, epic #8828 Phase 4) — the legibility layer.
//
// WHY: a contributor closed by ORB today cannot see WHICH ruleset version or clause closed them — and the
// authoritative config being private (LOOPOVER_REPO_CONFIG_DIR on the operator's host) makes that worse, not
// better. The remedy is a per-decision record whose inputs are pinned by content address: the digest is
// published even where the contents stay private, so "the bot closed me" becomes "clause X of ruleset
// abc123 closed me" — inspectable, arguable, and stable under challenge. The shape follows SLSA's
// Verification Summary Attestation (verifier + policy digest + result), which exists for exactly this
// delegate-a-decision pattern.
//
// This record is also the input schema the golden-corpus replay (#8832) and the deterministic replay harness
// (#8838) consume — one schema, three consumers, so drift between "what we published" and "what we can
// replay" is structurally impossible.
//
// HONEST LIMIT (#9122). This is the CURRENT statement of it, and the only one that gets updated:
// migrations/0180_decision_ledger.sql carries an older, shorter version in its own header and must keep it
// verbatim forever. That file has already been applied on running deployments, and runSelfHostMigrations
// hashes every applied migration's FULL text (comments included) to detect post-apply edits -- so editing
// its prose, even harmlessly, makes every already-upgraded ORB fail to boot. Documentation about this table
// belongs here, where it can change freely. The hash-chained
// ledger below makes this instance's history tamper-EVIDENT against every actor except an operator with
// direct DB access, on its own — such an operator could still rewrite the chain wholesale (delete every row,
// recompute a fresh one from genesis) and nothing INTERNAL to this table can detect that from first
// principles. As of #9267, external anchoring closes most of that gap: a scheduled job (ledger-anchor-
// scheduler.ts) publishes a signed checkpoint of the tip to a Rekor transparency log and a git commit (cross-
// mirrored by GH Archive / Software Heritage) that the operator does not control — rewriting history before
// the oldest still-referenced anchor now means forging that signature or fabricating matching external
// evidence too. The gap that remains: the unanchored tail since the last checkpoint is exactly as tamper-
// evident-only as before anchoring existed. None of this reduces the value against every OTHER actor (a
// maintainer quietly deleting one disputed decision, or an unprivileged bug), or against accidental
// corruption — both of which the chain below still catches deterministically.
//
// #9124 (v4): three of the four commitments this record makes did not commit to what actually decided the
// PR — fixed together, since all three are computed at the same call site (processors.ts):
//   - `configDigest` now digests the RESOLVED `gateCheckPolicy(...)` object (the thing `evaluateGateCheck`
//     actually ran against — including the live-calibrated AI close-confidence floor and the cron-refreshed
//     untrustworthy-rule-code set) instead of raw `settings`. The raw settings digest survives as the new,
//     separate `settingsDigest` field.
//   - `promptDigest` now digests the ACTUAL `buildSystemPrompt(...)` output for this call (base template plus
//     whichever of its suffixes resolved: grounding/enrichment/profile/security-focus/path-instructions/
//     `review.instructions`/screenshot-evidence/inline/category/improvement-signal), not the base constant
//     alone — a changed `review.instructions` now moves this digest.
//   - `modelIds` (renamed from the always-null `modelId`) carries the REAL parsed-reviewer identities from
//     `reviewDiagnostics`, the full set when more than one model produced a usable opinion.
//   - `ciState` is populated from the live CI aggregate already in scope at the call site (was hardcoded null).
// #9135 (also v4): `divertedByHoldout` records when the randomized close-audit holdout (#8831) converted this
// decision's plan from a heuristic close to a hold — see that field's own doc comment.
import { deliveryIdOrigin, type DeliveryIdOrigin } from "../queue/delivery-id";
import { errorMessage, nowIso } from "../utils/json";
import { retentionCutoffIsoForTable } from "../db/retention";

/** Bump when the record's FIELD SET changes meaning — consumers compare records only within a version. */
export const DECISION_RECORD_SCHEMA_VERSION = "6"; // v6 (#9743): + findingsCount, so "findings raised per PR" is derivable from the LEDGER rather than from the AI review cache (which is keyed for reuse, not anchored, and so cannot back a reproducibility claim); v5 (#8834): + aiAgreement (inter-run agreement folded with the verbalized confidence); v4 (#9124/#9135): configDigest digests the resolved policy (+ settingsDigest split out), promptDigest digests the actual sent prompt, modelId -> modelIds (real identities), ciState populated, + divertedByHoldout; v3 (#8962): + salvageability {score, factors}; v2 (#8834): + aiConfidence, model/prompt commitments

/**
 * Canonical JSON: recursively key-sorted, no insignificant whitespace — the ONE serialization every digest
 * in this system is computed over. Identical logical inputs must always hash identically, so object key
 * order (an artifact of construction, not meaning) can never influence a digest. Arrays keep their order
 * (order IS meaning there). undefined object members are dropped (JSON has no undefined); undefined inside
 * arrays follows JSON.stringify's own null coercion. PURE.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  // Functions/symbols/bigints have no JSON meaning; refusing loudly beats a silent wrong digest.
  throw new Error(`canonicalJson: unsupported value type "${typeof value}"`);
}

/** SHA-256 hex over UTF-8 text via Web Crypto (available in the Workers runtime AND Node ≥20). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Digest of any JSON-shaped value via the canonical serialization above. */
export async function contentDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** The published, public-safe decision record. Counts/digests/enums only — no diffs, no private config
 *  contents (their DIGEST is the commitment), no author identity beyond what the PR page already shows. */
export type DecisionRecord = {
  schemaVersion: string;
  repoFullName: string;
  pullNumber: number;
  headSha: string;
  baseSha: string | null;
  /** The disposition the bot actually acted on (merge/close/hold) — never the raw check conclusion (#8825). */
  action: string;
  /** The clause that decided it: a blocker class, `policy_close:<kind>`, or the gate conclusion. */
  reasonCode: string;
  /** #9124: digest of the RESOLVED `gateCheckPolicy(...)` object (canonical JSON) — the thing
   *  `evaluateGateCheck` actually ran against, including the live-calibrated AI close-confidence floor
   *  (`readCalibratedThreshold`/`system_flags`, resolved OUTSIDE `settings`) and the cron-refreshed
   *  untrustworthy-rule-code set (`readUntrustworthyRuleCodes`) the precision breaker consults. Two decisions
   *  computed under a different calibrated floor or a different untrustworthy-code set now publish different
   *  digests even when raw `settings` is unchanged — see `settingsDigest` below for the raw-config commitment
   *  this field used to make instead. */
  configDigest: string;
  /** #9124: digest of the RAW resolved effective settings (`.loopover.yml` > DB > defaults, canonical JSON) —
   *  what `configDigest` digested before v4. Kept as its own field because it is independently useful (an
   *  operator can diff two decisions' settings without reconstructing the full resolved-policy shape); null
   *  for a caller that has not computed it. */
  settingsDigest: string | null;
  /** The gate policy pack in force (public enum, safe to publish alongside the digest). */
  gatePack: string | null;
  /** CI aggregate consumed by the decision, when one was read. */
  ciState: string | null;
  /** #9124: the distinct provider/model identities (`AiReviewDiagnostic.model`, deduped + sorted) whose
   *  output actually shaped this decision — the FULL set when more than one model produced a parsed opinion,
   *  never a representative one. Renamed from the always-null `modelId` (v3 and earlier never threaded the
   *  real identities through). null for rule-only decisions. */
  modelIds: string[] | null;
  /** #9124: sha256 of the ACTUAL system prompt sent (`buildSystemPrompt`'s real output — the base template
   *  plus whichever of its up-to-ten suffixes resolved for this call), not a digest of the base constant
   *  alone. A changed `review.instructions` (or any other suffix input) now moves this digest. null for
   *  rule-only decisions. */
  promptDigest: string | null;
  /** #8834: the calibrated confidence of the AI-judgment finding that shaped this decision (consensus
   *  defect / split), null when no AI judgment contributed. Persisted so every decision joins the
   *  risk-control calibration set (#8835) with its confidence attached. */
  aiConfidence: number | null;
  /** #8834: the per-decision confidence signal — inter-run agreement across the reviewer stances that
   *  produced the AI judgment, folded together with that judgment's verbalized confidence (see
   *  src/review/judgment-agreement.ts). `aiConfidence` above records what the model SAID; this records how
   *  reproducibly the reviewers reached it, which is the input a calibrated abstention threshold (#8835)
   *  needs. null when no AI judgment contributed, and for every record predating v5. */
  aiAgreement: { agreement: number; confidence: number; sampleCount: number; uncorroborated: boolean } | null;
  /** #8962: the deterministic salvageability score + its named factors when an AI judgment shaped the
   *  decision — the second-axis evidence for auditing the close/hold boundary. null for rule-only decisions
   *  (and for reconstructed/backfilled records predating v3). */
  salvageability: { score: number; factors: string[] } | null;
  /** #9135: true when the randomized close-audit holdout (#8831) diverted this decision's plan — the
   *  `action` recorded above is a HOLD that the deterministic pipeline would otherwise have executed as a
   *  heuristic CLOSE. Makes that divergence legible on the record's own face instead of requiring a
   *  cross-reference against `decision_audit_holdout` audit rows to notice two byte-identical-looking
   *  records disagree on outcome. false for every decision the holdout never touched, including every
   *  decision recorded before #9135 shipped (via `buildDecisionRecord`'s normalization below). */
  divertedByHoldout: boolean;
  /** #9743: how many findings this evaluation actually raised (blockers + warnings). Recorded HERE so the
   *  per-author-class parity rollups are reproducible from the anchored ledger alone -- the AI review cache
   *  also holds findings, but it is keyed for reuse rather than anchored, so counting from it would make a
   *  published fairness number unverifiable. Null for a caller that has no findings to report (a policy
   *  close, an update_branch), which is distinct from a genuine zero. */
  findingsCount: number | null;
  decidedAt: string;
};

/** Assemble the record and its own content digest. PURE given pre-computed digests. Normalizes the
 *  optional-shaped caller fields (undefined -> null) HERE so call sites carry no fallback arms of their own. */
export async function buildDecisionRecord(
  input: Omit<DecisionRecord, "schemaVersion" | "decidedAt" | "gatePack" | "ciState" | "baseSha" | "aiConfidence" | "aiAgreement" | "salvageability" | "settingsDigest" | "divertedByHoldout" | "findingsCount"> & {
    decidedAt?: string;
    gatePack?: string | null | undefined;
    ciState?: string | null | undefined;
    baseSha?: string | null | undefined;
    aiConfidence?: number | null | undefined;
    aiAgreement?: { agreement: number; confidence: number; sampleCount: number; uncorroborated: boolean } | null | undefined;
    salvageability?: { score: number; factors: string[] } | null | undefined;
    settingsDigest?: string | null | undefined;
    divertedByHoldout?: boolean | undefined;
    findingsCount?: number | null | undefined;
  },
): Promise<{ record: DecisionRecord; recordDigest: string }> {
  const record: DecisionRecord = {
    schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    decidedAt: input.decidedAt ?? nowIso(),
    ...input,
    gatePack: input.gatePack ?? null,
    ciState: input.ciState ?? null,
    baseSha: input.baseSha ?? null,
    aiConfidence: input.aiConfidence ?? null,
    aiAgreement: input.aiAgreement ?? null,
    salvageability: input.salvageability ?? null,
    settingsDigest: input.settingsDigest ?? null,
    divertedByHoldout: input.divertedByHoldout ?? false,
    // Non-negative integer or null; a fractional or negative count is a caller bug, not a fact to publish.
    findingsCount:
      typeof input.findingsCount === "number" && Number.isInteger(input.findingsCount) && input.findingsCount >= 0
        ? input.findingsCount
        : null,
  };
  return { record, recordDigest: await contentDigest(record) };
}

/**
 * Persist the record (decision_records, migration 0179), one row per (target, head sha) UNLESS this exact
 * head was already decided before — a re-gate that lands a SECOND verdict for a head decision_records
 * already has a row for (#9123's "compounding bug": a live fleet carried 51 chain rows referencing a digest
 * an UPDATE had already overwritten, permanently unreconcilable). The FIRST record for a (repo, pull, head)
 * keeps the plain `record:<repo>#<pr>@<head>` id every existing consumer (the replay CLI's extract query,
 * decision-replay.ts) already expects; a SUPERSESSION gets its OWN row at `<baseId>:rev<N>` instead of
 * overwriting it, so the digest the ledger already chained for the first decision keeps a live preimage
 * forever — the ledger's own append-only "supersessions are visible history" promise now actually holds for
 * the record body too, not just the chain pointer. Best-effort: recording legibility must never break
 * finalization (mirrors recordNativeGateDecision's posture). Returns the id actually written (null on a
 * swallowed failure) so a caller needing to key a private sibling row (e.g. decision-replay.ts's replay
 * input) targets the SAME row this call produced, including a supersession's revisioned id.
 */
/**
 * Why a head SHA was evaluated more than once (#9742).
 *
 * A CLOSED set, because the point of recording it is that an outsider can count re-evaluations by cause
 * without interpreting free text. A new head SHA (force-push, new commits) is NOT a re-evaluation and needs
 * no code -- that path is a fresh verdict by definition.
 */
export const REEVALUATION_REASONS = [
  /** Routine scheduled re-gate: the periodic sweep, or a sibling PR's churn waking this one. No new
   *  information is claimed -- this is by far the highest-volume cause, and naming it is what keeps
   *  the other four meaningful rather than making every repeat verdict look like an incident. */
  "scheduled_recheck",
  /** The prior evaluation did not complete or produced an unusable result. */
  "pipeline_error",
  /** Repo configuration or calibrated policy changed, so the prior verdict was computed under rules that no
   *  longer apply. */
  "config_change",
  /** A maintainer explicitly asked for the PR to be re-gated. */
  "maintainer_request",
  /** External state the verdict depended on (CI, upstream) settled differently after the fact. */
  "upstream_state_change",
] as const;

export type ReevaluationReason = (typeof REEVALUATION_REASONS)[number];

export function isReevaluationReason(value: unknown): value is ReevaluationReason {
  return typeof value === "string" && (REEVALUATION_REASONS as readonly string[]).includes(value);
}

/**
 * Which cause each synthetic delivery-id origin represents (#9742).
 *
 * `Record<DeliveryIdOrigin, ...>` deliberately: adding a producer to DELIVERY_ID_PREFIXES without
 * saying why its re-evaluations happen is a build failure, not a silently-wrong verdict record. This
 * is the whole reason the prefixes were consolidated into one module.
 */
export const REEVALUATION_REASON_BY_ORIGIN: Record<DeliveryIdOrigin, ReevaluationReason> = {
  regateSweep: "scheduled_recheck",
  regateRepair: "pipeline_error",
  manualRegate: "maintainer_request",
  backlogConvergence: "pipeline_error",
  panelRetriggerRecovery: "maintainer_request",
  linkedIssueVerify: "upstream_state_change",
  reconcile: "pipeline_error",
  surfaceWithoutDisposition: "pipeline_error",
};

/**
 * The re-evaluation reason a job's delivery id implies.
 *
 * A raw GitHub delivery id (no synthetic prefix) means a real event on the PR moved something the
 * verdict depends on -- CI settling, a label changing, a sibling merging -- which is
 * `upstream_state_change`. Mechanical, so no call site has to judge its own cause.
 */
export function deriveReevaluationReason(deliveryId: string | null | undefined): ReevaluationReason {
  const origin = deliveryIdOrigin(deliveryId);
  return origin === null ? "upstream_state_change" : REEVALUATION_REASON_BY_ORIGIN[origin];
}

/** A re-evaluation's provenance: why it happened, and which verdict it supersedes. */
export type ReevaluationContext = {
  reason: ReevaluationReason;
  /** The `decision_records.id` this supersedes. Resolved by the writer when absent. */
  supersedesRecordId?: string | undefined;
  /** WHO caused it, when that is a person: the operator behind a manual re-gate, the maintainer who
   *  ran the review command. Absent for the machine-paced causes, which is most of them. */
  actor?: string | null | undefined;
};

/** Thrown when a repeat evaluation of a head SHA arrives without declaring why (#9742). */
export class UndeclaredReevaluationError extends Error {
  constructor(readonly target: string, readonly priorCount: number) {
    super(
      `Refusing to write a repeat verdict for ${target}: this head SHA already has ${priorCount} verdict(s), so the write must declare a re-evaluation reason (one of ${REEVALUATION_REASONS.join(", ")}). A new head SHA needs no reason.`,
    );
    this.name = "UndeclaredReevaluationError";
  }
}

/** A resolved re-evaluation: the declared reason and the record it supersedes. Null for a first evaluation. */
type ResolvedReevaluation = { reason: ReevaluationReason; supersedesRecordId: string; actor: string | null };

/**
 * The whole re-evaluation decision in one place (#9742): a first evaluation resolves to null and needs no
 * reason, a repeat one must declare a valid reason or the write is refused.
 *
 * Separate from the write so the invariant is stated once and `isReevaluationReason` narrows the reason to
 * `ReevaluationReason` for the caller -- the row's two columns are then either both set or both null, with
 * no third state to represent or test for.
 */
function resolveReevaluation(
  priorCount: number,
  baseId: string,
  context: ReevaluationContext | undefined,
  target: string,
): ResolvedReevaluation | null {
  if (priorCount === 0) return null;
  const reason = context?.reason;
  if (!isReevaluationReason(reason)) throw new UndeclaredReevaluationError(target, priorCount);
  return {
    reason,
    // Whatever the caller names, else the immediately-prior revision, which `:revN` numbering makes derivable.
    supersedesRecordId: context?.supersedesRecordId ?? (priorCount === 1 ? baseId : `${baseId}:rev${priorCount}`),
    // Trimmed to null rather than stored as "" so "no actor" is one value, not two.
    actor: context?.actor?.trim() ? context.actor.trim() : null,
  };
}

export async function persistDecisionRecord(
  env: Env,
  record: DecisionRecord,
  recordDigest: string,
  attempts = 3,
  /** #9742: required when this head SHA already carries a verdict. Absent on a first evaluation, which is
   *  every ordinary write. The check lives HERE, at the ledger-write layer, so no caller can bypass it by
   *  writing the row itself. */
  reevaluation?: ReevaluationContext | undefined,
): Promise<string | null> {
  const baseId = `record:${record.repoFullName}#${record.pullNumber}@${record.headSha}`.slice(0, 250);
  try {
    for (let attempt = 1; ; attempt += 1) {
      const prior = await env.DB.prepare(`SELECT COUNT(*) AS n FROM decision_records WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?`)
        .bind(record.repoFullName.slice(0, 200), record.pullNumber, record.headSha)
        .first<{ n: number }>();
      /* v8 ignore next -- defensive: a bare COUNT(*) always returns exactly one row (even {n: 0} against an
       * empty table); the `?? 0` only satisfies .first<T>()'s optional-by-signature TS return type. */
      const priorCount = prior?.n ?? 0;
      // #9742: a repeat evaluation of the SAME head SHA must say why. Without this, "evaluated once" and
      // "evaluated three times and one result was kept" are indistinguishable in the public record. A new
      // head SHA never reaches here with priorCount > 0, so the ordinary path is untouched.
      const reevaluated = resolveReevaluation(priorCount, baseId, reevaluation, `${record.repoFullName}#${record.pullNumber}@${record.headSha}`);
      const id = priorCount === 0 ? baseId : `${baseId}:rev${priorCount + 1}`;
      try {
        await env.DB.prepare(
          `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at, reevaluation_reason, supersedes_record_id, reevaluation_actor, findings_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(id, record.repoFullName.slice(0, 200), record.pullNumber, record.headSha, record.action, record.reasonCode.slice(0, 200), recordDigest, canonicalJson(record), record.decidedAt, reevaluated?.reason ?? null, reevaluated?.supersedesRecordId ?? null, reevaluated?.actor ?? null, record.findingsCount ?? null)
          .run();
      } catch (error) {
        if (attempt >= attempts) throw error;
        // A concurrent supersession at the exact same (repo, pull, head) raced the count-then-insert above and
        // collided on the PK — re-count and retry with the next revision id (mirrors appendDecisionLedger's
        // own PK-collision retry for the ledger tip immediately above).
        continue;
      }
      // The record row landed. #9078: a failure chaining it must NOT be conflated with the persist failure
      // handled below (nothing landed at all) — the record already exists, so this is its own distinct
      // failure mode ("an unchained record", per this module's header) and deserves its own dedicated,
      // non-swallowed alarm rather than the same generic console.warn every other persist failure gets.
      // verifyDecisionLedger's `missing_record`/`short_tail` reconciliation is what catches this after the
      // fact; this alarm is what makes it visible the moment it happens, instead of only on the next verify.
      try {
        // #8837: every write appends a chain row — including a supersession's OWN new row, so re-decisions
        // are visible history rather than silent replacement.
        await appendDecisionLedger(env, id, recordDigest);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "decision_ledger_append_failed",
            target: `${record.repoFullName}#${record.pullNumber}`,
            recordId: id,
            message: errorMessage(error).slice(0, 160),
            at: nowIso(),
          }),
        );
      }
      return id;
    }
  } catch (error) {
    // #9742: a REFUSED re-evaluation is a policy answer, not a persistence failure, and must not be
    // flattened into the same `null` every transient D1 fault returns -- a caller that cannot tell them
    // apart cannot honour the refusal. Everything else keeps the historical swallow: a decision record
    // failing to persist must never break the review that produced it.
    if (error instanceof UndeclaredReevaluationError) throw error;
    console.warn(JSON.stringify({ event: "decision_record_persist_error", target: `${record.repoFullName}#${record.pullNumber}`, message: errorMessage(error).slice(0, 160) }));
    return null;
  }
}

/** Bounded, human-readable markdown body for the public review surface: the claim ("clause X of config
 *  abc123…") plus the digests a challenger needs. #9123: digests print in FULL (64 hex chars) — a truncated
 *  prefix is not a commitment a challenger can actually compare against a re-hashed config/prompt/record, only
 *  a hint. The head sha keeps its conventional 7-char git-abbreviation (a display convention for a commit-ish,
 *  not a digest commitment; the full value is the record's own `headSha` field). Returned WITHOUT a details
 *  wrapper — the unified-comment bridge renders the collapsible chrome itself (UnifiedCollapsible). */
export function renderDecisionRecordSection(record: DecisionRecord, recordDigest: string): string {
  // Defensive against an OLDER persisted record (a smaller schemaVersion, loaded straight back out of
  // decision_records.record_json — see loadDecisionRecordCollapsible) whose JSON simply predates a field
  // this schema version introduced: `?? ` here, not only a `!== null` check, so a genuinely ABSENT key
  // (`undefined`, not `null`) degrades the same honest way an explicit null does, instead of throwing on
  // `.length`/`.join` of undefined.
  const modelIds = record.modelIds ?? null;
  const divertedByHoldout = record.divertedByHoldout ?? false;
  const lines = [
    `- **action**: ${record.action} · **clause**: \`${record.reasonCode}\``,
    `- **config**: \`${record.configDigest}\`${record.gatePack ? ` · **pack**: ${record.gatePack}` : ""}${record.ciState ? ` · **ci**: ${record.ciState}` : ""}`,
    ...(modelIds !== null || record.promptDigest !== null
      ? [`- **model**: ${modelIds !== null && modelIds.length > 0 ? modelIds.join("+") : "n/a"}${record.promptDigest !== null ? ` · **prompt**: \`${record.promptDigest}\`` : ""}${record.aiConfidence !== null ? ` · **confidence**: ${record.aiConfidence}` : ""}`]
      : []),
    // #9135: a hold that is really a diverted close must be legible ON THE FACE of the public comment, not
    // only inferable by cross-referencing a private audit row.
    ...(divertedByHoldout ? ["- **note**: diverted by the randomized close-audit holdout (#8831) — the deterministic pipeline would otherwise have closed this PR"] : []),
    `- **record**: \`${recordDigest}\` (schema v${record.schemaVersion}, head \`${record.headSha.slice(0, 7)}\`)`,
  ];
  return lines.join("\n");
}

/** Load the latest persisted record for a PR as a ready-to-append UnifiedCollapsible body; null when none
 *  exists yet (first publish precedes the first finalize) or the stored JSON is unreadable (fail-safe: the
 *  comment simply omits the section rather than failing the publish). */
export async function loadDecisionRecordCollapsible(env: Env, repoFullName: string, pullNumber: number): Promise<{ title: string; body: string } | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT record_digest AS recordDigest, record_json AS recordJson FROM decision_records
        WHERE repo_full_name = ? AND pull_number = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(repoFullName, pullNumber)
      .first<{ recordDigest: string; recordJson: string }>();
    if (!row) return null;
    const record = JSON.parse(row.recordJson) as DecisionRecord;
    return { title: "Decision record", body: renderDecisionRecordSection(record, row.recordDigest) };
  } catch (error) {
    console.warn(JSON.stringify({ event: "decision_record_load_error", target: `${repoFullName}#${pullNumber}`, message: errorMessage(error).slice(0, 160) }));
    return null;
  }
}

/**
 * #9123: the record was persisted but never PUBLISHED anywhere — the only thing that ever reached a
 * contributor was renderDecisionRecordSection's bounded markdown summary (12-char digest prefixes, no
 * decidedAt/baseSha/salvageability/repoFullName/pullNumber at all). This is the raw material for a public
 * `GET /v1/public/decision-records/:owner/:repo/:pull` route: the LATEST record for a PR, verbatim, plus its
 * digest — DecisionRecord is already public-safe by construction (its own type doc: "counts/digests/enums
 * only — no diffs, no private config contents, no author identity"), so no field-level redaction is needed
 * here, unlike a route that touches a wallet/hotkey/trust-score-bearing type. Same latest-wins query
 * loadDecisionRecordCollapsible already uses (ORDER BY created_at DESC — a supersession's revisioned id sorts
 * correctly by creation time regardless of its id suffix). Returns null on no-row-yet OR unreadable JSON,
 * mirroring loadDecisionRecordCollapsible's own fail-safe posture — a route caller renders 404 either way.
 */
export async function loadPublicDecisionRecord(env: Env, repoFullName: string, pullNumber: number): Promise<{ record: DecisionRecord; recordDigest: string } | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT record_digest AS recordDigest, record_json AS recordJson FROM decision_records
        WHERE repo_full_name = ? AND pull_number = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(repoFullName, pullNumber)
      .first<{ recordDigest: string; recordJson: string }>();
    if (!row) return null;
    return { record: JSON.parse(row.recordJson) as DecisionRecord, recordDigest: row.recordDigest };
  } catch (error) {
    console.warn(JSON.stringify({ event: "decision_record_public_load_error", target: `${repoFullName}#${pullNumber}`, message: errorMessage(error).slice(0, 160) }));
    return null;
  }
}

// ── Hash-chained ledger (#8837) ─────────────────────────────────────────────────────────────────────────────

/** Genesis predecessor: the chain's first row links to 64 zero nibbles. */
export const LEDGER_GENESIS_HASH = "0".repeat(64);

/** The semantic fields a ledger row commits to (canonical-JSON'd inside the row hash). */
export type LedgerRowFields = { seq: number; recordId: string; recordDigest: string; createdAt: string };

/** row_hash = SHA-256(prev_hash || canonicalJson(fields)) — the ONE definition append and verify share. */
export async function ledgerRowHash(prevHash: string, fields: LedgerRowFields): Promise<string> {
  return sha256Hex(prevHash + canonicalJson(fields));
}

/**
 * Append one chain row for a persisted record. seq is explicit (last+1, genesis 1) so a GAP is itself a
 * detectable break — never autoincrement, which would silently paper over deletions. A concurrent append
 * races on the PRIMARY KEY and retries with a re-read predecessor (bounded); persistDecisionRecord treats a
 * final failure as its own best-effort failure (the record row still lands — an unchained record is caught
 * by the verify endpoint's record/ledger reconciliation, a follow-up check, rather than by losing the
 * decision itself).
 */
/** The chain's current tip -- {@link LEDGER_GENESIS_HASH}/seq 0/count 0 on an empty ledger. Deliberately
 *  lighter than {@link verifyDecisionLedger} (which additionally walks and verifies a window): a caller that
 *  only needs "what is the tip right now" (the scheduled anchoring job, #9274) shouldn't pay for a
 *  self-consistency walk it isn't asking for. */
export async function loadDecisionLedgerTip(env: Env): Promise<{ seq: number; rowHash: string; totalCount: number }> {
  // #9489: ONE statement, not two under Promise.all. The seq/totalCount pair is exactly how a verifier detects
  // truncation-and-rechaining (see buildLedgerAnchorPayload's own doc), so reading them separately meant a
  // concurrent appendDecisionLedger landing between the two queries produced totalCount = seq + 1 alongside
  // the OLD rowHash -- an internally inconsistent checkpoint. Anchoring then signs it and publishes it to
  // Rekor, unretractably, as a FALSE tamper signal about the maintainer's own ledger. A single statement reads
  // both from one snapshot, so the pair can never disagree.
  const row = await env.DB
    .prepare("SELECT (SELECT COUNT(*) FROM decision_ledger) AS n, seq, row_hash AS rowHash FROM decision_ledger ORDER BY seq DESC LIMIT 1")
    .first<{ n: number; seq: number; rowHash: string }>();
  // An empty ledger returns no row at all (the ORDER BY ... LIMIT 1 has nothing to return), which is the
  // genesis case rather than a defensive one.
  if (!row) return { seq: 0, rowHash: LEDGER_GENESIS_HASH, totalCount: 0 };
  return { seq: row.seq, rowHash: row.rowHash, totalCount: row.n };
}

export async function appendDecisionLedger(env: Env, recordId: string, recordDigest: string, attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const tip = await env.DB.prepare("SELECT seq, row_hash AS rowHash FROM decision_ledger ORDER BY seq DESC LIMIT 1").first<{ seq: number; rowHash: string }>();
    const seq = (tip?.seq ?? 0) + 1;
    const prevHash = tip?.rowHash ?? LEDGER_GENESIS_HASH;
    const createdAt = nowIso();
    const rowHash = await ledgerRowHash(prevHash, { seq, recordId, recordDigest, createdAt });
    try {
      await env.DB.prepare(
        "INSERT INTO decision_ledger (seq, record_id, record_digest, prev_hash, row_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(seq, recordId, recordDigest, prevHash, rowHash, createdAt)
        .run();
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      // PK collision from a concurrent append — re-read the tip and retry.
    }
  }
}

export type LedgerBreak =
  | { kind: "sequence_gap"; atSeq: number; expectedSeq: number }
  | { kind: "predecessor_mismatch"; atSeq: number }
  | { kind: "row_hash_mismatch"; atSeq: number }
  // #9122: a self-consistent chain that stops short of every decision_records row it should account for — see
  // the reconciliation check at the end of verifyDecisionLedger below for exactly what this catches and why.
  | { kind: "short_tail"; atSeq: number }
  // #9078: the ledger's OWN committed digest for this row disagrees with a digest freshly recomputed from the
  // record's current record_json — content tampering (or an operational bug) that rewrote decision_records
  // without touching the chain. Comparing against the ledger's row.recordDigest — not the equally-tamperable
  // decision_records.record_digest column — is what makes this a real check: a forger would have to also
  // recompute every row_hash after this one to make a tampered record_json look consistent, which
  // row_hash_mismatch would already catch.
  | { kind: "content_mismatch"; atSeq: number; recordId: string }
  // #9078: a ledger row commits to a decision_records id that no longer has a row at all — the one preimage
  // the chain vouched for is simply gone (a direct-DB deletion, or some other operation none of the
  // gap/predecessor/hash checks above can see, since those only ever compare ledger rows against each other).
  // #9474: NOT reported for a record whose hash-chained ledger created_at is older than the published
  // decision_records retention window — that absence is the retention policy doing its job, and reporting it
  // as tampering would make legitimate pruning indistinguishable from evidence destruction. The verify result
  // counts such rows in `prunedRecords` instead.
  | { kind: "missing_record"; atSeq: number; recordId: string }
  // #9489: a record older than the append grace window with NO ledger row vouching for it, at a created_at at
  // or before the verified tail — i.e. an INTERIOR orphan the short_tail check could never see, because that
  // check only ever compared the tail. A permanently failed appendDecisionLedger call, or a targeted deletion
  // of one interior ledger row... except the latter also breaks the seq chain, so in practice this is the
  // failed-append signature.
  | { kind: "unchained_record"; atSeq: number; recordId: string };

/**
 * #9489: how old a decision_records row must be before its lack of a ledger row is treated as a break rather
 * than an append still in flight. persistDecisionRecord inserts the record and appends its chain row in the
 * same call, ordinarily milliseconds apart — but a verification running in that gap used to report
 * `short_tail`, i.e. "tampering", on a PUBLIC endpoint, for a state every healthy write passes through. Five
 * minutes is orders of magnitude beyond any healthy insert-to-append latency while still bounding how long a
 * genuinely failed append (its own error-level alarm fires at the moment it happens) can hide from verify.
 */
const LEDGER_APPEND_GRACE_MS = 5 * 60 * 1000;

/**
 * Verify a window of the chain, resumable via `afterSeq` (0 = genesis). Reports the FIRST break with its
 * class — a gap, a broken predecessor link, a rewritten row, a short tail, a content mismatch, or a missing
 * record (see below) — and the cursor for the next window. Always returns the CURRENT global tip
 * (`tipSeq`/`tipHash`) and total row count, regardless of where this window's pagination stopped, so a
 * third-party checkpoint-keeper can compare it against whatever tip it last observed (#9122 — the exact shape
 * the scheduled anchoring job, #9274, now consumes via {@link loadDecisionLedgerTip}). #9078: also reconciles
 * each row against `decision_records` —
 * recomputing `contentDigest(JSON.parse(record_json))` and comparing it to the digest the chain itself
 * committed to, so a rewrite of `record_json` that left `decision_records.record_digest` untouched (or vice
 * versa) is caught here instead of only being provable by an external challenger who happens to still have the
 * original preimage. Read-only; safe on a public route — it reads `record_json` to recompute a digest but
 * never RETURNS record contents, only the break kind, sequence, and (public, already-exposed) record id.
 */
/** A declared, bounded exclusion from the CONTENT re-check (#9850). Chain checks are never waived. */
export type LedgerContentWaiver = { fromSeq: number; toSeq: number; reason: string };

/**
 * PURE. Parse `LOOPOVER_LEDGER_CONTENT_WAIVER`, format `<fromSeq>-<toSeq>:<reason>`.
 *
 * WHY THIS EXISTS. A row whose record preimage is genuinely unrecoverable -- e.g. the rows the pre-#9123
 * record-overwriting UPDATE left behind -- can never be reconciled again. Rewriting those records so the
 * digests match would be exactly the tampering this ledger exists to detect, so the only honest options are
 * to fail forever or to declare the damage. A permanently-red endpoint is one nobody reads, which is a worse
 * public signal than a green one carrying an explicit, counted exclusion.
 *
 * FOUR PROPERTIES MAKE THIS A DISCLOSURE RATHER THAN A COVER-UP, and each is enforced here:
 *
 *   1. BOUNDED BY SEQ, NOT TIME. A date boundary drifts: as the clock advances it silently swallows new
 *      damage. A seq range is fixed forever -- only an explicit edit widens it. (The retention cutoff above
 *      gets to be time-based because it tracks a published policy that genuinely moves; this does not.)
 *   2. BOTH ENDS REQUIRED. An open-ended waiver is a blanket exemption wearing a range's clothes.
 *   3. A REASON IS MANDATORY. You cannot waive silently; the text is published with the count, so the claim
 *      being made is legible to whoever is checking.
 *   4. CONTENT ONLY. Enforced at the call site, not here: a waived row still has to pass sequence,
 *      predecessor and row_hash. Tampering with a waived row's CHAIN position still fails.
 *
 * Returns null on anything malformed -- fail CLOSED, waiving nothing, so a typo cannot widen an exclusion.
 * src/selfhost/preflight.ts surfaces the malformed value rather than leaving it silently inert.
 */
export function parseLedgerContentWaiver(raw: string | undefined): LedgerContentWaiver | null {
  if (!raw) return null;
  const separator = raw.indexOf(":");
  if (separator < 0) return null;
  const reason = raw.slice(separator + 1).trim();
  if (reason === "") return null;
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(raw.slice(0, separator));
  if (!match) return null;
  const fromSeq = Number(match[1]);
  const toSeq = Number(match[2]);
  // A descending or zero-based range is a mistake, not an intent: seq starts at 1 and a waiver must name a
  // real, forward interval.
  if (fromSeq < 1 || toSeq < fromSeq) return null;
  return { fromSeq, toSeq, reason };
}

export type LedgerUnchainedWaiver = { fromIso: string; toIso: string; maxRecords: number; reason: string };

/**
 * PURE. Parse `LOOPOVER_LEDGER_UNCHAINED_WAIVER`, format `<fromIso>..<toIso>|<maxRecords>|<reason>`.
 *
 * WHY A SECOND WAIVER (#9933). `unchained_record` means a decision_records row exists that no ledger row ever
 * vouched for -- the failed-append signature. The content waiver above deliberately cannot cover it (property
 * 4: chain findings are never waivable), which is right for tampering but leaves a bounded, already-fixed
 * historical failure permanently red. Measured on the production ORB: 231 orphans between 2026-07-04 and
 * 2026-07-24 and NONE since, against an otherwise structurally perfect chain. A permanently-red integrity
 * endpoint is the worst possible signal, because "red" stops distinguishing old damage from a real failed
 * append tomorrow -- the precise thing this check exists to catch.
 *
 * WHY TIME-BOUNDED, given parseLedgerContentWaiver's property 1 says NOT to be. That rule is about boundaries
 * that MOVE: a relative window ("the last 30 days") silently swallows new damage as the clock advances. Both
 * bounds here are ABSOLUTE instants, so the interval is exactly as fixed as a seq range -- only an explicit
 * edit widens it. Seq is not available as an alternative in any case: an orphan is defined by having no ledger
 * row, so it has no sequence number to name.
 *
 * `maxRecords` closes the remaining gap that a seq range gets for free. A seq interval names a fixed number of
 * rows; a time interval names a fixed span that could in principle come to contain MORE orphans than the
 * operator counted. Declaring the count means a new failed append backdated into the window cannot hide behind
 * the declaration: the moment the real count exceeds what was declared, the waiver stops applying entirely and
 * the endpoint goes red. Fail-closed in the same direction as everything else here.
 *
 * The other three properties are unchanged and enforced below: both ends required, a reason is mandatory, and
 * only the INTERIOR `unchained_record` kind is declarable -- `short_tail` (a record newer than the verified
 * tip with no chain entry) stays unwaivable, because a truncated tail is exactly the attack this defends.
 *
 * Pipe-delimited rather than colon-delimited purely because ISO-8601 instants contain colons; a colon split
 * could not tell the range from the reason.
 *
 * Returns null on anything malformed -- fail CLOSED, waiving nothing. preflight.ts surfaces the malformed
 * value rather than leaving it silently inert.
 */
export function parseLedgerUnchainedWaiver(raw: string | undefined): LedgerUnchainedWaiver | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length < 3) return null;
  const [rangePart, countPart, ...reasonParts] = parts;
  const reason = reasonParts.join("|").trim();
  if (reason === "") return null;
  // `parts.length >= 3` above already guarantees both indices, and the regex guarantees its own groups, so
  // these are asserted rather than defaulted -- a `?? ""` fallback here would only add an arm no input can
  // reach. Number()/Date.parse() of a genuinely bad value still lands on the NaN guard below.
  const match = /^\s*(\S+)\s*\.\.\s*(\S+)\s*$/.exec(rangePart!);
  if (!match) return null;
  const fromMs = Date.parse(match[1]!);
  const toMs = Date.parse(match[2]!);
  // A descending or unparseable range is a mistake, not an intent.
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) return null;
  // Must be a positive integer: "0" waives nothing while looking like a declaration, and a fractional or
  // negative count is a typo. Number() rather than parseInt so "12abc" is rejected instead of read as 12.
  const maxRecords = Number(countPart!.trim());
  if (!Number.isInteger(maxRecords) || maxRecords < 1) return null;
  // Normalized to ISO so the published value is unambiguous regardless of how the operator wrote it.
  return { fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString(), maxRecords, reason };
}

export async function verifyDecisionLedger(
  env: Env,
  afterSeq = 0,
  limit = 500,
): Promise<{
  ok: boolean;
  checked: number;
  nextAfterSeq: number | null;
  tipSeq: number;
  tipHash: string;
  totalCount: number;
  prunedRecords: number;
  contentMismatches: number;
  /** #9850: mismatches inside the declared waiver -- reported separately and prominently, never folded into
   *  contentMismatches, so "83 rows are excused" can never read as "83 rows are fine". */
  waivedContentMismatches: number;
  contentWaiver: LedgerContentWaiver | null;
  /** #9933: orphaned records inside the declared unchained waiver -- counted and published separately, never
   *  folded into a clean result's silence, so "231 records were never chained" can never read as "nothing to
   *  see here". 0 when no waiver is configured or none fell inside it. */
  waivedUnchainedRecords: number;
  unchainedWaiver: LedgerUnchainedWaiver | null;
  break?: LedgerBreak;
}> {
  const bounded = Math.max(1, Math.min(1000, limit));
  // #9474: rows whose record preimage was legitimately pruned by the published retention policy (see the
  // missing-record branch below). Surfaced in the result so "the chain is clean but N old preimages are no
  // longer independently checkable" is an explicit, countable statement rather than silent.
  let prunedRecords = 0;
  // #9850: content mismatches no longer ABORT the scan, they accumulate. Returning at the first one made a
  // single unreconcilable row a denial-of-verification for everything after it: found on a live instance
  // carrying 83 rows (seq 5-257) from before #9123 replaced the record-overwriting UPDATE with the revision
  // scheme, where verification stopped at seq 5 and never examined the remaining 1,649 rows. Real tampering
  // at seq 900 would have been invisible behind permanent, historical damage at seq 5.
  //
  // Safe to continue precisely BECAUSE the chain checks above already passed for this row: sequence,
  // predecessor and row_hash all reconciled, so `prevHash` for the next row is sound. A content mismatch says
  // "this row's preimage no longer matches what the chain committed to", which is a statement about that row
  // alone. A STRUCTURAL break is different -- a sequence gap or predecessor mismatch means everything after
  // it is unverifiable, so those still return immediately.
  //
  // `ok` is still false and the first mismatch is still reported as `break`, so nothing about the verdict is
  // softened; the scan simply keeps going and reports how many there are.
  let contentMismatches = 0;
  let waivedContentMismatches = 0;
  let firstContentMismatch: LedgerBreak | null = null;
  const contentWaiver = parseLedgerContentWaiver(env.LOOPOVER_LEDGER_CONTENT_WAIVER);
  // #9933: the sibling declaration for orphaned (never-appended) records -- see parseLedgerUnchainedWaiver.
  const unchainedWaiver = parseLedgerUnchainedWaiver(env.LOOPOVER_LEDGER_UNCHAINED_WAIVER);
  let waivedUnchainedRecords = 0;
  const decisionRecordsPruneCutoff = retentionCutoffIsoForTable("decision_records");
  const [totalRow, globalTip, prior] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM decision_ledger").first<{ n: number }>(),
    env.DB.prepare("SELECT seq, row_hash AS rowHash FROM decision_ledger ORDER BY seq DESC LIMIT 1").first<{ seq: number; rowHash: string }>(),
    afterSeq > 0 ? env.DB.prepare("SELECT seq, row_hash AS rowHash, created_at AS createdAt FROM decision_ledger WHERE seq = ?").bind(afterSeq).first<{ seq: number; rowHash: string; createdAt: string }>() : Promise.resolve(null),
  ]);
  /* v8 ignore next -- defensive: a bare COUNT(*) always returns exactly one row (even {n: 0} against an empty
   * table); the `?? 0` only satisfies .first<T>()'s optional-by-signature TS return type. */
  const totalCount = totalRow?.n ?? 0;
  const tipSeq = globalTip?.seq ?? 0;
  const tipHash = globalTip?.rowHash ?? LEDGER_GENESIS_HASH;
  // `== null` deliberately: D1 drivers disagree on .first() returning null vs undefined for no-row.
  if (afterSeq > 0 && prior == null) return { ok: false, checked: 0, nextAfterSeq: null, tipSeq, tipHash, totalCount, prunedRecords, contentMismatches, waivedContentMismatches, contentWaiver, waivedUnchainedRecords, unchainedWaiver, break: { kind: "sequence_gap", atSeq: afterSeq, expectedSeq: afterSeq } };
  let prevHash = prior?.rowHash ?? LEDGER_GENESIS_HASH;
  let expectedSeq = afterSeq + 1;
  const { results } = await env.DB.prepare(
    "SELECT seq, record_id AS recordId, record_digest AS recordDigest, prev_hash AS prevHash, row_hash AS rowHash, created_at AS createdAt FROM decision_ledger WHERE seq > ? ORDER BY seq ASC LIMIT ?",
  )
    .bind(afterSeq, bounded)
    .all<{ seq: number; recordId: string; recordDigest: string; prevHash: string; rowHash: string; createdAt: string }>();
  // #9078: batch-fetch every decision_records row this window's chain rows reference, ONE query rather than
  // one per row, so the content reconciliation below is a map lookup instead of an N+1 query per verify call.
  const recordIds = [...new Set(results.map((row) => row.recordId))];
  const recordsById = new Map<string, { recordDigest: string; recordJson: string }>();
  if (recordIds.length > 0) {
    const { results: recordRows } = await env.DB.prepare(
      `SELECT id, record_digest AS recordDigest, record_json AS recordJson FROM decision_records WHERE id IN (${recordIds.map(() => "?").join(",")})`,
    )
      .bind(...recordIds)
      .all<{ id: string; recordDigest: string; recordJson: string }>();
    for (const recordRow of recordRows) recordsById.set(recordRow.id, { recordDigest: recordRow.recordDigest, recordJson: recordRow.recordJson });
  }
  let checked = 0;
  // Tracks the created_at of the last row this call actually verified clean — the anchor the tail-truncation
  // reconciliation below compares decision_records against. Seeded from `prior` (the checkpoint we resumed
  // from) so a call that finds ZERO new rows still has an anchor to reconcile against.
  let lastVerifiedCreatedAt = prior?.createdAt ?? null;
  for (const row of results) {
    if (row.seq !== expectedSeq) return { ok: false, checked, nextAfterSeq: null, tipSeq, tipHash, totalCount, prunedRecords, contentMismatches, waivedContentMismatches, contentWaiver, waivedUnchainedRecords, unchainedWaiver, break: { kind: "sequence_gap", atSeq: row.seq, expectedSeq } };
    if (row.prevHash !== prevHash) return { ok: false, checked, nextAfterSeq: null, tipSeq, tipHash, totalCount, prunedRecords, contentMismatches, waivedContentMismatches, contentWaiver, waivedUnchainedRecords, unchainedWaiver, break: { kind: "predecessor_mismatch", atSeq: row.seq } };
    const recomputed = await ledgerRowHash(prevHash, { seq: row.seq, recordId: row.recordId, recordDigest: row.recordDigest, createdAt: row.createdAt });
    if (recomputed !== row.rowHash) return { ok: false, checked, nextAfterSeq: null, tipSeq, tipHash, totalCount, prunedRecords, contentMismatches, waivedContentMismatches, contentWaiver, waivedUnchainedRecords, unchainedWaiver, break: { kind: "row_hash_mismatch", atSeq: row.seq } };
    // #9078: the promised record/ledger reconciliation — a row_hash chained cleanly can still commit to a
    // digest whose CONTENT has since been rewritten (or whose preimage is simply gone). Neither is visible to
    // the chain-only checks above, since those only ever compare ledger rows against each other.
    const storedRecord = recordsById.get(row.recordId);
    if (!storedRecord) {
      // #9474: decision_records carries a 180-day retention window while ledger rows are kept forever, so
      // roughly 180 days after that rule first bit, EVERY full-chain verification would have reported
      // missing_record at the first pruned row -- a false tamper signal manufactured by a legitimate,
      // published retention policy, on the one endpoint whose whole point is that a skeptic can trust it.
      // The tolerance keys on the LEDGER row's created_at, which is inside the hash chain: backdating it to
      // sneak a fresh deletion under the cutoff breaks row_hash_mismatch above first. What is genuinely
      // given up is exactly what pruning gives up -- the content reconciliation for that row -- while the
      // chain checks (already passed above) still hold; the digest the chain committed to remains published,
      // so a challenger holding the original preimage can still prove a historical rewrite by hand.
      if (decisionRecordsPruneCutoff !== null && row.createdAt < decisionRecordsPruneCutoff) {
        prunedRecords += 1;
      } else {
        return { ok: false, checked, nextAfterSeq: null, tipSeq, tipHash, totalCount, prunedRecords, contentMismatches, waivedContentMismatches, contentWaiver, waivedUnchainedRecords, unchainedWaiver, break: { kind: "missing_record", atSeq: row.seq, recordId: row.recordId } };
      }
    } else {
      let recomputedContentDigest: string | null = null;
      try {
        recomputedContentDigest = await contentDigest(JSON.parse(storedRecord.recordJson));
      } catch {
        // Unparseable record_json is itself proof the content no longer matches whatever the chain committed to.
        recomputedContentDigest = null;
      }
      if (recomputedContentDigest !== row.recordDigest) {
        // Inside a declared waiver this is counted and disclosed, not forgiven silently -- and note this is
        // reached only AFTER the chain checks above passed for this row, so a waiver can never excuse a
        // structural break.
        if (contentWaiver !== null && row.seq >= contentWaiver.fromSeq && row.seq <= contentWaiver.toSeq) {
          waivedContentMismatches += 1;
        } else {
          contentMismatches += 1;
          firstContentMismatch ??= { kind: "content_mismatch", atSeq: row.seq, recordId: row.recordId };
        }
      }
    }
    prevHash = row.rowHash;
    lastVerifiedCreatedAt = row.createdAt;
    expectedSeq = row.seq + 1;
    checked += 1;
  }
  const nextAfterSeq = results.length === bounded ? results[results.length - 1]!.seq : null;
  // #9122 — TAIL TRUNCATION: everything above only ever detects a break BETWEEN rows that still exist; deleting
  // the newest rows outright (`DELETE FROM decision_ledger WHERE seq > N`) leaves every remaining row's
  // gap/predecessor/hash checks passing clean, since there is nothing left in the window to disagree with.
  // But decision_ledger and decision_records are written together, in the SAME call (persistDecisionRecord
  // appends its ledger row immediately after inserting the record) — deleting ledger rows never touches
  // decision_records. So a record created strictly AFTER this window's verified tip, with no chain entry
  // covering it, is exactly the signature a truncated tail leaves behind in the one place the deletion could
  // not reach. Only checked once we've reached what this call believes is the current end of the chain
  // (`nextAfterSeq === null`; a paginated window still has more to verify first) and only when there is an
  // actual tip to anchor the comparison on (an entirely empty, never-yet-populated ledger has nothing to
  // truncate FROM, and predates this reconciliation by definition).
  //
  // #9489 reshaped this reconciliation twice over:
  //   1. GRACE — the record INSERT and its ledger append are two writes milliseconds apart, and a verify
  //      landing between them used to report short_tail ("tampering") on a public endpoint for a state every
  //      healthy write passes through. A record younger than LEDGER_APPEND_GRACE_MS is now simply not yet
  //      due for reconciliation; a genuinely failed append still surfaces here on the next verify after the
  //      grace lapses (and fired its own error-level alarm at the moment it happened).
  //   2. INTERIOR ORPHANS — the old check only compared created_at against the verified TAIL, so the moment
  //      any newer record chained cleanly, an unchained record behind it became invisible forever. The
  //      NOT EXISTS anti-join (indexed via decision_ledger_record_id, migration 0198) asks the real
  //      question — "does ANY ledger row vouch for this record?" — which catches both positions. The newest
  //      orphan decides the break kind: past the tail it is the truncated-tail signature short_tail always
  //      meant; at or before the tail it is an interior unchained_record.
  // Records legitimately pruned by retention cannot false-positive here in either direction: pruning deletes
  // the RECORD row, and this reconciliation only ever reports records that still exist.
  if (nextAfterSeq === null && lastVerifiedCreatedAt !== null) {
    const graceCutoffIso = new Date(Date.parse(nowIso()) - LEDGER_APPEND_GRACE_MS).toISOString();
    // #9933: count what the declared waiver actually covers BEFORE deciding anything. The count is the guard
    // that makes a time-bounded waiver as tight as a seq-bounded one: declaring 231 means a 232nd orphan
    // appearing inside the same window -- a new failed append, or one backdated into it -- cannot hide behind
    // the declaration. Over the declared maximum, the waiver stops applying in full and every orphan is
    // reported again, rather than waiving the first N and quietly reporting the rest.
    //
    // Every waiver predicate carries `created_at <= lastVerifiedCreatedAt` -- the INTERIOR test. Excluding the
    // window without it silently waived a short_tail sitting inside the window, i.e. exactly the truncated-tail
    // attack the docs promise is unwaivable. Encoding "interior" in the SQL rather than checking it afterwards
    // keeps the count and the break search agreeing on which rows the waiver covers.
    if (unchainedWaiver !== null) {
      const covered = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM decision_records r WHERE r.created_at >= ? AND r.created_at <= ? AND r.created_at <= ? AND r.created_at <= ? AND NOT EXISTS (SELECT 1 FROM decision_ledger l WHERE l.record_id = r.id)",
      )
        .bind(unchainedWaiver.fromIso, unchainedWaiver.toIso, lastVerifiedCreatedAt, graceCutoffIso)
        .first<{ n: number }>();
      /* v8 ignore next -- defensive, mirroring the totalCount read above: a bare COUNT(*) always returns
       * exactly one row (even {n: 0} against an empty table), so the fallback only satisfies .first<T>()'s
       * optional-by-signature TS return type. */
      const coveredCount = covered?.n ?? 0;
      if (coveredCount <= unchainedWaiver.maxRecords) waivedUnchainedRecords = coveredCount;
    }
    // Orphans inside an APPLIED waiver are excluded from the break search; everything else is reported exactly
    // as before. A waiver that failed its count guard applies to nothing, so the window is not excluded here.
    const waiverApplies = unchainedWaiver !== null && waivedUnchainedRecords > 0;
    const orphan = await (waiverApplies
      ? env.DB.prepare(
          "SELECT id, created_at AS createdAt FROM decision_records r WHERE r.created_at <= ? AND NOT (r.created_at >= ? AND r.created_at <= ? AND r.created_at <= ?) AND NOT EXISTS (SELECT 1 FROM decision_ledger l WHERE l.record_id = r.id) ORDER BY r.created_at DESC LIMIT 1",
        ).bind(graceCutoffIso, unchainedWaiver.fromIso, unchainedWaiver.toIso, lastVerifiedCreatedAt)
      : env.DB.prepare(
          "SELECT id, created_at AS createdAt FROM decision_records r WHERE r.created_at <= ? AND NOT EXISTS (SELECT 1 FROM decision_ledger l WHERE l.record_id = r.id) ORDER BY r.created_at DESC LIMIT 1",
        ).bind(graceCutoffIso)
    ).first<{ id: string; createdAt: string }>();
    // `== null` deliberately: D1 drivers disagree on .first() returning null vs undefined for no-row.
    if (orphan != null) {
      return {
        ok: false,
        checked,
        nextAfterSeq: null,
        tipSeq,
        tipHash,
        totalCount,
        prunedRecords,
        contentMismatches,
        waivedContentMismatches,
        contentWaiver,
        waivedUnchainedRecords,
        unchainedWaiver,
        break:
          orphan.createdAt > lastVerifiedCreatedAt
            ? // A truncated TAIL is never waivable -- see parseLedgerUnchainedWaiver. The waiver's window can
              // only ever exclude interior orphans, and this arm is reached only for a record newer than the
              // verified tip, which is the attack signature itself.
              { kind: "short_tail", atSeq: expectedSeq - 1 }
            : { kind: "unchained_record", atSeq: expectedSeq - 1, recordId: orphan.id },
      };
    }
  }
  // A content mismatch is still a FAILED verification -- the scan continuing does not soften the verdict, it
  // only stops one bad row from hiding every row after it. The first is reported as `break` exactly as before.
  if (firstContentMismatch !== null) {
    return { ok: false, checked, nextAfterSeq, tipSeq, tipHash, totalCount, prunedRecords, contentMismatches, waivedContentMismatches, contentWaiver, waivedUnchainedRecords, unchainedWaiver, break: firstContentMismatch };
  }
  return { ok: true, checked, nextAfterSeq, tipSeq, tipHash, totalCount, prunedRecords, contentMismatches, waivedContentMismatches, contentWaiver, waivedUnchainedRecords, unchainedWaiver };
}

/** One ledger row, exactly as chained -- the shape `GET /v1/public/decision-ledger/row/:seq` returns. */
export type PublicLedgerRow = { seq: number; recordId: string; recordDigest: string; prevHash: string; rowHash: string; createdAt: string };

/**
 * Load a single ledger row by seq (#9269). This is what BINDS an external anchor back to the live chain: an
 * anchor published elsewhere commits to a `(seq, rowHash)` pair, but on its own that only proves some hash
 * existed somewhere at some time -- not that it is still THIS chain's hash at that seq. With this route, a
 * third party fetches the live row, recomputes `sha256(prevHash || canonicalJson({seq, recordId,
 * recordDigest, createdAt}))` via {@link ledgerRowHash}, and compares. An operator who deleted the chain and
 * re-chained from genesis produces a DIFFERENT rowHash at every anchored seq, so every published anchor then
 * fails that comparison independently and publicly -- which is precisely the "wholesale re-chaining" gap
 * `migrations/0180_decision_ledger.sql` names as its own honest limit.
 *
 * Public-safe by the same argument the verify route already makes: every field here is a hash, a sequence
 * number, a timestamp, or the record id -- all of which that route (and the published decision record) expose
 * already. Never returns record CONTENTS. `null` for an unknown seq so the caller can 404 rather than answer
 * 200 with nulls, keeping "never appended" distinguishable from "appended with empty fields".
 */
export async function loadPublicLedgerRow(env: Env, seq: number): Promise<PublicLedgerRow | null> {
  const row = await env.DB.prepare(
    "SELECT seq, record_id AS recordId, record_digest AS recordDigest, prev_hash AS prevHash, row_hash AS rowHash, created_at AS createdAt FROM decision_ledger WHERE seq = ?",
  )
    .bind(seq)
    .first<PublicLedgerRow>();
  // `== null` deliberately, matching verifyDecisionLedger above: D1 drivers disagree on .first() returning
  // null vs undefined for no-row.
  return row == null ? null : row;
}
