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
// HONEST LIMIT (#9122, mirrored from migrations/0180_decision_ledger.sql's own header): the hash-chained
// ledger below makes this instance's history tamper-EVIDENT, not tamper-PROOF — an operator with direct DB
// access can still rewrite the chain wholesale (delete every row, recompute a fresh one from genesis) and
// nothing here can detect that from first principles. External anchoring (a signed checkpoint published
// somewhere the operator does not control — a git commit, a transparency log, an on-chain commitment) is the
// tracked follow-up once tenants exist, not yet built. That gap does not reduce the value against every OTHER
// actor (a maintainer quietly deleting one disputed decision, or an unprivileged bug), or against accidental
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
import { errorMessage, nowIso } from "../utils/json";

/** Bump when the record's FIELD SET changes meaning — consumers compare records only within a version. */
export const DECISION_RECORD_SCHEMA_VERSION = "5"; // v5 (#8834): + aiAgreement (inter-run agreement folded with the verbalized confidence); v4 (#9124/#9135): configDigest digests the resolved policy (+ settingsDigest split out), promptDigest digests the actual sent prompt, modelId -> modelIds (real identities), ciState populated, + divertedByHoldout; v3 (#8962): + salvageability {score, factors}; v2 (#8834): + aiConfidence, model/prompt commitments

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
  decidedAt: string;
};

/** Assemble the record and its own content digest. PURE given pre-computed digests. Normalizes the
 *  optional-shaped caller fields (undefined -> null) HERE so call sites carry no fallback arms of their own. */
export async function buildDecisionRecord(
  input: Omit<DecisionRecord, "schemaVersion" | "decidedAt" | "gatePack" | "ciState" | "baseSha" | "aiConfidence" | "aiAgreement" | "salvageability" | "settingsDigest" | "divertedByHoldout"> & {
    decidedAt?: string;
    gatePack?: string | null | undefined;
    ciState?: string | null | undefined;
    baseSha?: string | null | undefined;
    aiConfidence?: number | null | undefined;
    aiAgreement?: { agreement: number; confidence: number; sampleCount: number; uncorroborated: boolean } | null | undefined;
    salvageability?: { score: number; factors: string[] } | null | undefined;
    settingsDigest?: string | null | undefined;
    divertedByHoldout?: boolean | undefined;
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
export async function persistDecisionRecord(env: Env, record: DecisionRecord, recordDigest: string, attempts = 3): Promise<string | null> {
  const baseId = `record:${record.repoFullName}#${record.pullNumber}@${record.headSha}`.slice(0, 250);
  try {
    for (let attempt = 1; ; attempt += 1) {
      const prior = await env.DB.prepare(`SELECT COUNT(*) AS n FROM decision_records WHERE repo_full_name = ? AND pull_number = ? AND head_sha = ?`)
        .bind(record.repoFullName.slice(0, 200), record.pullNumber, record.headSha)
        .first<{ n: number }>();
      /* v8 ignore next -- defensive: a bare COUNT(*) always returns exactly one row (even {n: 0} against an
       * empty table); the `?? 0` only satisfies .first<T>()'s optional-by-signature TS return type. */
      const priorCount = prior?.n ?? 0;
      const id = priorCount === 0 ? baseId : `${baseId}:rev${priorCount + 1}`;
      try {
        await env.DB.prepare(
          `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(id, record.repoFullName.slice(0, 200), record.pullNumber, record.headSha, record.action, record.reasonCode.slice(0, 200), recordDigest, canonicalJson(record), record.decidedAt)
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
  | { kind: "missing_record"; atSeq: number; recordId: string };

/** #9122: the exact shape a scheduled external-anchoring job (git-commit checkpoint, transparency log, or an
 *  on-chain commitment — the actual publishing mechanism is a genuinely open infra/protocol decision tracked
 *  on the issue, deliberately NOT built here) would publish for a given tip: enough for a third party to later
 *  prove "the ledger's tip really was this, at this time" against whatever anchor eventually receives it. Pure
 *  and synchronous — this module has no scheduler and calls this from nowhere yet; a future cron handler is
 *  the natural caller, using the tipSeq/tipHash verifyDecisionLedger already returns on every call. */
export function buildLedgerAnchorPayload(tip: { seq: number; rowHash: string }, at: string = nowIso()): { seq: number; rowHash: string; at: string } {
  return { seq: tip.seq, rowHash: tip.rowHash, at };
}

/**
 * Verify a window of the chain, resumable via `afterSeq` (0 = genesis). Reports the FIRST break with its
 * class — a gap, a broken predecessor link, a rewritten row, a short tail, a content mismatch, or a missing
 * record (see below) — and the cursor for the next window. Always returns the CURRENT global tip
 * (`tipSeq`/`tipHash`) and total row count, regardless of where this window's pagination stopped, so a
 * third-party checkpoint-keeper can compare it against whatever tip it last observed (#9122 — the exact shape
 * a future external-anchoring job would need). #9078: also reconciles each row against `decision_records` —
 * recomputing `contentDigest(JSON.parse(record_json))` and comparing it to the digest the chain itself
 * committed to, so a rewrite of `record_json` that left `decision_records.record_digest` untouched (or vice
 * versa) is caught here instead of only being provable by an external challenger who happens to still have the
 * original preimage. Read-only; safe on a public route — it reads `record_json` to recompute a digest but
 * never RETURNS record contents, only the break kind, sequence, and (public, already-exposed) record id.
 */
export async function verifyDecisionLedger(
  env: Env,
  afterSeq = 0,
  limit = 500,
): Promise<{ ok: boolean; checked: number; nextAfterSeq: number | null; tipSeq: number; tipHash: string; totalCount: number; break?: LedgerBreak }> {
  const bounded = Math.max(1, Math.min(1000, limit));
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
  if (afterSeq > 0 && prior == null) return { ok: false, checked: 0, nextAfterSeq: null, tipSeq, tipHash, totalCount, break: { kind: "sequence_gap", atSeq: afterSeq, expectedSeq: afterSeq } };
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
    if (row.seq !== expectedSeq) return { ok: false, checked, nextAfterSeq: null, tipSeq, tipHash, totalCount, break: { kind: "sequence_gap", atSeq: row.seq, expectedSeq } };
    if (row.prevHash !== prevHash) return { ok: false, checked, nextAfterSeq: null, tipSeq, tipHash, totalCount, break: { kind: "predecessor_mismatch", atSeq: row.seq } };
    const recomputed = await ledgerRowHash(prevHash, { seq: row.seq, recordId: row.recordId, recordDigest: row.recordDigest, createdAt: row.createdAt });
    if (recomputed !== row.rowHash) return { ok: false, checked, nextAfterSeq: null, tipSeq, tipHash, totalCount, break: { kind: "row_hash_mismatch", atSeq: row.seq } };
    // #9078: the promised record/ledger reconciliation — a row_hash chained cleanly can still commit to a
    // digest whose CONTENT has since been rewritten (or whose preimage is simply gone). Neither is visible to
    // the chain-only checks above, since those only ever compare ledger rows against each other.
    const storedRecord = recordsById.get(row.recordId);
    if (!storedRecord) return { ok: false, checked, nextAfterSeq: null, tipSeq, tipHash, totalCount, break: { kind: "missing_record", atSeq: row.seq, recordId: row.recordId } };
    let recomputedContentDigest: string | null = null;
    try {
      recomputedContentDigest = await contentDigest(JSON.parse(storedRecord.recordJson));
    } catch {
      // Unparseable record_json is itself proof the content no longer matches whatever the chain committed to.
      recomputedContentDigest = null;
    }
    if (recomputedContentDigest !== row.recordDigest) return { ok: false, checked, nextAfterSeq: null, tipSeq, tipHash, totalCount, break: { kind: "content_mismatch", atSeq: row.seq, recordId: row.recordId } };
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
  if (nextAfterSeq === null && lastVerifiedCreatedAt !== null) {
    const orphaned = await env.DB.prepare("SELECT COUNT(*) AS n FROM decision_records WHERE created_at > ?").bind(lastVerifiedCreatedAt).first<{ n: number }>();
    /* v8 ignore next -- defensive: a bare COUNT(*) always returns exactly one row (even {n: 0}); the `?? 0`
     * only satisfies .first<T>()'s optional-by-signature TS return type. */
    if ((orphaned?.n ?? 0) > 0) {
      return { ok: false, checked, nextAfterSeq: null, tipSeq, tipHash, totalCount, break: { kind: "short_tail", atSeq: expectedSeq - 1 } };
    }
  }
  return { ok: true, checked, nextAfterSeq, tipSeq, tipHash, totalCount };
}
