// The public verifier's claim checks (#9723, epic #9722).
//
// LoopOver publishes fairness numbers and says a stranger can check them. Until now "checking them" meant
// reading `verify-this-review.mdx`, reimplementing canonical JSON, reimplementing ECDSA-over-that, and
// hand-diffing four endpoints -- so in practice nobody ever did, and a broken commitment could have sat
// published indefinitely. This module is the check itself, as code, runnable by anyone with `npx`.
//
// EVERY FUNCTION HERE IS PURE. They take already-fetched payloads and return verdicts; the bin does the
// network. That is not a testing convenience -- it is what makes the verifier auditable. A reader can see
// exactly what is being asserted without tracing HTTP, and every claim below is exercised in tests against
// hand-written payloads including the failure side, so "the verifier would have caught it" is a tested
// property rather than a hope.
//
// WHAT A FAILURE MEANS. `fail` is always a statement about the DEPLOYMENT, never about the verifier's own
// luck: a digest that does not recompute, a commitment to a corpus nobody can obtain, an anchor whose
// signature does not verify. Anything the verifier merely could not obtain -- an endpoint that is disabled,
// a corpus behind a rule that publishes none -- is `skip`, reported as such and NOT counted as a pass.
// Collapsing "could not check" into "checked, fine" is the single easiest way to build a verifier that
// always says green, so the two are kept structurally distinct all the way to the exit code.
import { contentDigest, canonicalJson, sha256Hex } from "@loopover/contract/digest";
import { anchorSigningInput, verifyLedgerAnchorSignature, type AnchorPublicKey, type SignedLedgerAnchor } from "@loopover/contract/anchor-verify";

export type ClaimStatus = "pass" | "fail" | "skip";

/** One checked claim. `detail` is written to be read by someone who did not write this code: on a failure it
 *  names what was expected and what was found, because "FAIL" with no preimage is not evidence of anything. */
export type ClaimResult = {
  id: string;
  claim: string;
  status: ClaimStatus;
  detail: string;
};

/** An eval-score record, narrowed to the fields the checks read. Deliberately structural rather than the
 *  contract's full inferred type: the verifier must be able to check a record published by a DEPLOYMENT
 *  RUNNING AN OLDER BUILD than the CLI, and a nominal type would reject it before a single digest was
 *  recomputed -- turning "their build is older" into a crash instead of a report. */
export type VerifiableEvalRecord = {
  recordDigest?: unknown;
  score?: { decided?: unknown } | undefined;
  commitments?: { corpusChecksum?: unknown } | undefined;
  workUnit?: { ruleId?: unknown; kind?: unknown } | undefined;
  subject?: { id?: unknown } | undefined;
};

/** The checksum of an EMPTY case list -- `sha256(canonicalJson([]))`, i.e. sha256("[]"). Computed, never
 *  hardcoded, so it cannot drift from the serialization it is supposed to represent. */
export async function emptyCorpusChecksum(): Promise<string> {
  return sha256Hex(canonicalJson([]));
}

/** A short, stable label for a record in failure text. Falls back through the identifying fields rather than
 *  indexing blindly, since a malformed record is exactly the case this text has to describe. */
export function describeRecord(record: VerifiableEvalRecord, index: number): string {
  const rule = typeof record.workUnit?.ruleId === "string" ? record.workUnit.ruleId : null;
  const subject = typeof record.subject?.id === "string" ? record.subject.id : null;
  return rule ?? subject ?? `record[${index}]`;
}

/**
 * CLAIM 1: every published `recordDigest` is the digest of the record that carries it.
 *
 * The preimage is the record MINUS `recordDigest` -- a digest cannot cover itself -- under the same
 * canonical serialization the Worker used. Because `canonicalJson` sorts keys, the field order the endpoint
 * happened to serialize in is irrelevant, which is what makes this checkable at all from parsed JSON.
 *
 * A record with no `recordDigest` at all is a FAIL, not a skip: an unsigned record among signed ones is the
 * exact shape a silently-dropped commitment takes, and skipping it would hide it.
 */
export async function checkRecordDigests(records: readonly VerifiableEvalRecord[]): Promise<ClaimResult> {
  const claim = "Every eval-score record's recordDigest recomputes from its own contents";
  if (records.length === 0) {
    return { id: "record-digests", claim, status: "skip", detail: "no eval-score records published" };
  }
  const failures: string[] = [];
  for (const [index, record] of records.entries()) {
    const label = describeRecord(record, index);
    const published = record.recordDigest;
    if (typeof published !== "string" || published === "") {
      failures.push(`${label}: no recordDigest published`);
      continue;
    }
    const { recordDigest: _omitted, ...preimage } = record as Record<string, unknown> & { recordDigest?: unknown };
    let recomputed: string;
    try {
      recomputed = await contentDigest(preimage);
    } catch (error) {
      // canonicalJson refuses values JSON cannot represent. Reaching here means the payload held something
      // no JSON endpoint can actually emit, so report it rather than letting the throw kill every later claim.
      failures.push(`${label}: not serializable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (recomputed !== published) failures.push(`${label}: published ${published.slice(0, 16)}…, recomputed ${recomputed.slice(0, 16)}…`);
  }
  return failures.length === 0
    ? { id: "record-digests", claim, status: "pass", detail: `${records.length} record(s) recomputed exactly` }
    : { id: "record-digests", claim, status: "fail", detail: failures.join("; ") };
}

/**
 * CLAIM 2: each record's `corpusChecksum` is the checksum of a corpus that can actually be downloaded.
 *
 * `corpusByRuleId` holds what `/v1/public/eval-corpus?ruleId=…` returned for each rule -- absent when that
 * fetch found nothing. The checksum is recomputed from the CASES as served, which is the whole point: a
 * commitment is only worth anything if it covers bytes the reader can obtain, so this deliberately does not
 * trust the corpus payload's own `checksum` field and recomputes from `cases` instead.
 *
 * The empty-corpus rule is the sharp edge #9723 names. `sha256(canonicalJson([]))` is the SAME value for
 * every rule and every deployment, so a record committing to it commits to nothing -- while looking exactly
 * like a real commitment to anyone eyeballing a hex string. Paired with `decided > 0` ("we scored real work")
 * that is a contradiction, and it is reported as a failure rather than a curiosity.
 */
export async function checkCorpusCommitments(
  records: readonly VerifiableEvalRecord[],
  corpusByRuleId: ReadonlyMap<string, { cases?: unknown; checksum?: unknown } | undefined>,
): Promise<ClaimResult> {
  const claim = "Every corpusChecksum matches a downloadable corpus, and no scored record commits to an empty one";
  const committed = records.filter((record) => typeof record.commitments?.corpusChecksum === "string");
  if (committed.length === 0) {
    return { id: "corpus-commitments", claim, status: "skip", detail: "no record published a corpusChecksum" };
  }
  const emptyChecksum = await emptyCorpusChecksum();
  const failures: string[] = [];
  const checked: string[] = [];
  // Counted separately from `checked`, which also collects "corpus not published" notes. A claim that
  // rehashed NOTHING has verified nothing, and reporting that as a pass -- with a detail line that openly
  // says "unverified" -- is precisely the "could not check, therefore fine" collapse this module's header
  // rules out. It is a skip.
  let rehashed = 0;
  for (const [index, record] of committed.entries()) {
    const label = describeRecord(record, index);
    const published = record.commitments?.corpusChecksum as string;
    const decided = typeof record.score?.decided === "number" ? record.score.decided : 0;

    if (published === emptyChecksum && decided > 0) {
      failures.push(`${label}: commits to the EMPTY corpus while reporting decided=${decided}`);
      continue;
    }
    const ruleId = typeof record.workUnit?.ruleId === "string" ? record.workUnit.ruleId : null;
    const corpus = ruleId === null ? undefined : corpusByRuleId.get(ruleId);
    if (corpus === undefined || !Array.isArray(corpus.cases)) {
      // Not a failure: #9805 deliberately omits a commitment for a truncated or empty corpus, and a rule can
      // legitimately publish no corpus. What would be a failure -- committing to nothing while claiming to
      // have decided something -- is already caught above.
      checked.push(`${label}: corpus not published (unverified)`);
      continue;
    }
    const recomputed = await sha256Hex(canonicalJson(corpus.cases));
    if (recomputed !== published) failures.push(`${label}: committed ${published.slice(0, 16)}…, corpus hashes to ${recomputed.slice(0, 16)}…`);
    else {
      rehashed += 1;
      checked.push(`${label}: ${corpus.cases.length} case(s) rehashed exactly`);
    }
  }
  if (failures.length > 0) return { id: "corpus-commitments", claim, status: "fail", detail: failures.join("; ") };
  if (rehashed === 0) {
    return { id: "corpus-commitments", claim, status: "skip", detail: `${committed.length} commitment(s) published, but no corresponding corpus is downloadable -- nothing could be rehashed` };
  }
  return { id: "corpus-commitments", claim, status: "pass", detail: checked.join("; ") };
}

/**
 * CLAIM 3: the current signed ledger checkpoint verifies offline, against a published key.
 *
 * "Offline" is load-bearing: the signature is checked with the operator's PUBLISHED public key and nothing
 * else. No call goes back to any LoopOver service that could simply assert success -- this recomputes the
 * signing input and runs ECDSA locally, so a deployment cannot pass by claiming to have passed.
 *
 * TWO independent things are checked, and the second is the one that matters most:
 *
 *   1. The signature verifies over the payload, under the key the checkpoint itself names. The key is
 *      selected by `keyId`, never by trying them all -- see `SignedLedgerAnchor`'s own doc for why a scan
 *      turns a real failure into an ambiguous one.
 *   2. The `signingInput` the endpoint SHOWS equals the canonical serialization of the payload it shows.
 *      Without this, a deployment could display one payload and sign a different set of bytes, and check 1
 *      would still pass against the bytes actually signed. Recomputing the preimage locally is what closes
 *      that gap, and it is exactly the check a reader cannot perform by eye.
 */
export async function checkAnchorCheckpoint(
  checkpoint: { signed?: unknown; signingInput?: unknown } | undefined,
  keys: readonly AnchorPublicKey[],
  ledger?: { totalCount?: unknown } | undefined,
): Promise<ClaimResult> {
  const claim = "The current signed ledger checkpoint verifies offline against a published key";
  const id = "anchor-checkpoint";
  if (checkpoint === undefined || !isSignedAnchor(checkpoint.signed)) {
    // #9940: an EMPTY ledger and a misconfigured signer used to produce the same sentence, and the
    // difference is the whole diagnosis. This surface holding no decisions is not a verifiability failure
    // -- there is nothing to anchor -- whereas decisions with no signing key is a real gap. Conflating them
    // sent me down the wrong path on a live deployment: I read "not configured" and went looking for a
    // missing secret, when the deployment simply had no ledger and the anchoring worked fine elsewhere.
    const totalCount = typeof ledger?.totalCount === "number" ? ledger.totalCount : null;
    if (totalCount === 0) {
      return {
        id,
        claim,
        status: "skip",
        detail: "this deployment's decision ledger is EMPTY (0 records), so there is nothing to anchor — check the deployment that actually records decisions, via --base-url",
      };
    }
    return {
      id,
      claim,
      status: "skip",
      detail: totalCount === null ? "no signed checkpoint published, and the ledger size is unknown" : `no signed checkpoint published, though the ledger holds ${totalCount} record(s) — anchor signing looks unconfigured here`,
    };
  }
  const signed = checkpoint.signed;
  if (keys.length === 0) {
    // A checkpoint nothing can be checked against is a real gap, but it is a gap in what is OBTAINABLE,
    // not proof of a bad signature -- so it is a skip whose text says exactly what is missing.
    return { id, claim, status: "skip", detail: "a checkpoint is published, but no signing key is published to check it against" };
  }

  if (typeof checkpoint.signingInput === "string") {
    const recomputed = anchorSigningInput(signed.payload);
    if (recomputed !== checkpoint.signingInput) {
      return { id, claim, status: "fail", detail: `the published signingInput is NOT the canonical serialization of the published payload (signed bytes differ from displayed bytes)` };
    }
  }

  const key = keys.find((candidate) => candidate.keyId === signed.keyId);
  if (key === undefined) {
    return { id, claim, status: "fail", detail: `checkpoint at seq ${signed.payload.seq} names key "${signed.keyId}", which is not among the ${keys.length} published key(s)` };
  }
  const verified = await verifyLedgerAnchorSignature(signed, key.publicKeySpki);
  return verified
    ? { id, claim, status: "pass", detail: `checkpoint at seq ${signed.payload.seq} verifies against published key "${key.keyId}"` }
    : { id, claim, status: "fail", detail: `checkpoint at seq ${signed.payload.seq} does NOT verify against its own named key "${key.keyId}"` };
}

/** Structural guard for a checkable signed checkpoint. Selects rather than validates: a payload shape this
 *  build does not recognise is reported as "nothing to check", not as a forgery. */
function isSignedAnchor(value: unknown): value is SignedLedgerAnchor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { payload?: unknown; keyId?: unknown; signature?: unknown };
  if (typeof candidate.keyId !== "string" || typeof candidate.signature !== "string") return false;
  const payload = candidate.payload as { seq?: unknown; rowHash?: unknown } | undefined;
  return typeof payload === "object" && payload !== null && typeof payload.seq === "number" && typeof payload.rowHash === "string";
}

/**
 * CLAIM 4: the headline stats agree with the ledger-derived surfaces they are supposed to summarize.
 *
 * `/v1/public/stats` is the number a reader actually sees; the parity rollups are computed from
 * `decision_records` directly. They are two paths to the same underlying count, so a disagreement means one
 * of them is wrong -- which is precisely the class of bug no amount of internal testing catches, because
 * each surface is individually self-consistent.
 *
 * Compared with a tolerance, not for equality: the two are read at different instants against a live ledger,
 * so a verdict landing between the two fetches moves one and not the other. The tolerance is absolute and
 * tiny -- large enough to absorb that race, far too small to absorb a real divergence.
 */
export function checkStatsParity(stats: { totals?: { handled?: unknown } | undefined } | undefined, parity: { verdicts?: unknown } | undefined, tolerance = 5): ClaimResult {
  const claim = "Published headline stats agree with the ledger-derived parity rollups";
  const handled = typeof stats?.totals?.handled === "number" ? stats.totals.handled : null;
  const verdicts = typeof parity?.verdicts === "number" ? parity.verdicts : null;
  if (handled === null || verdicts === null) {
    return {
      id: "stats-parity",
      claim,
      status: "skip",
      detail: handled === null ? "/v1/public/stats published no totals.handled count" : "review-parity rollups published no verdict count",
    };
  }
  // The parity rollup covers a WINDOW while totals are all-time, so parity can only ever be the smaller of
  // the two. It exceeding the all-time count is the direction that indicates a real accounting error: the
  // two are computed by different code over the same ledger, which is the divergence no amount of
  // per-surface testing catches, because each surface is individually self-consistent.
  //
  // Compared with a tolerance, not for equality: the two are read at different instants against a live
  // ledger, so a verdict landing between the two fetches moves one and not the other. The tolerance is
  // absolute and tiny -- large enough to absorb that race, far too small to absorb a real divergence.
  if (verdicts > handled + tolerance) {
    return { id: "stats-parity", claim, status: "fail", detail: `parity rollups report ${verdicts} verdict(s) over their window, exceeding the all-time handled count of ${handled}` };
  }
  return { id: "stats-parity", claim, status: "pass", detail: `all-time handled=${handled}, windowed parity verdicts=${verdicts} -- consistent` };
}

/** The process exit code for a set of results: non-zero if ANY claim failed. Skips do not fail the run --
 *  a disabled surface is not a broken one -- but they are never silently counted as passes either. */
export function exitCodeFor(results: readonly ClaimResult[]): number {
  return results.some((result) => result.status === "fail") ? 1 : 0;
}

/** One-line summary under the table, so a caller reading only the last line still gets the counts. */
export function summarize(results: readonly ClaimResult[]): string {
  const count = (status: ClaimStatus) => results.filter((result) => result.status === status).length;
  return `${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped`;
}
