import { describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import { decideLedgerAnchorSchedule, LEDGER_ANCHOR_SEQ_THRESHOLD, resolveGitAnchorTarget, runScheduledLedgerAnchor } from "../../src/review/ledger-anchor-scheduler";
import { buildDecisionRecord, contentDigest, loadDecisionLedgerTip, persistDecisionRecord } from "../../src/review/decision-record";
import { loadPublicLedgerAnchors } from "../../src/review/ledger-anchor-persistence";
import { computeAnchorKeyId, type SignedLedgerAnchor } from "../../src/review/ledger-anchor";

// #9274 (epic #9267). decideLedgerAnchorSchedule is the pure decision this whole job hinges on -- tested
// exhaustively on its own before the orchestrator's IO/injection wiring.

describe("decideLedgerAnchorSchedule (#9274)", () => {
  const base = { isHourly: false, currentTip: { seq: 10, rowHash: "a".repeat(64) }, lastAnchor: null as { seq: number; rowHash: string } | null, seqThreshold: 256 };

  it("never anchors an empty ledger, regardless of hourly or threshold", () => {
    expect(decideLedgerAnchorSchedule({ ...base, isHourly: true, currentTip: { seq: 0, rowHash: "0".repeat(64) } })).toEqual({ shouldAnchor: false, reason: "empty_ledger" });
  });

  it("anchors on the hourly tick when the tip has never been anchored before", () => {
    expect(decideLedgerAnchorSchedule({ ...base, isHourly: true, lastAnchor: null })).toEqual({ shouldAnchor: true, reason: "hourly" });
  });

  it("anchors on the hourly tick when the tip changed since the last anchor", () => {
    expect(decideLedgerAnchorSchedule({ ...base, isHourly: true, lastAnchor: { seq: 5, rowHash: "b".repeat(64) } })).toEqual({ shouldAnchor: true, reason: "hourly" });
  });

  it("skips the hourly tick when the tip is UNCHANGED since the last anchor -- idempotent, free on quiet days", () => {
    expect(decideLedgerAnchorSchedule({ ...base, isHourly: true, lastAnchor: { seq: 10, rowHash: "a".repeat(64) } })).toEqual({ shouldAnchor: false, reason: "unchanged" });
  });

  it("skips a non-hourly tick with an unchanged tip and no threshold breach", () => {
    expect(decideLedgerAnchorSchedule({ ...base, isHourly: false, lastAnchor: { seq: 9, rowHash: "c".repeat(64) } })).toEqual({ shouldAnchor: false, reason: "unchanged" });
  });

  it("anchors immediately once the seq delta reaches the threshold, independent of the hourly clock", () => {
    const result = decideLedgerAnchorSchedule({ ...base, isHourly: false, currentTip: { seq: 300, rowHash: "d".repeat(64) }, lastAnchor: { seq: 40, rowHash: "e".repeat(64) } });
    expect(result).toEqual({ shouldAnchor: true, reason: "seq_threshold" });
  });

  it("treats a never-anchored ledger as starting from seq 0 for the threshold check -- a big first burst anchors immediately, not on the next hourly tick", () => {
    const result = decideLedgerAnchorSchedule({ ...base, isHourly: false, currentTip: { seq: LEDGER_ANCHOR_SEQ_THRESHOLD, rowHash: "f".repeat(64) }, lastAnchor: null });
    expect(result).toEqual({ shouldAnchor: true, reason: "seq_threshold" });
  });

  it("does not anchor one short of the threshold", () => {
    const result = decideLedgerAnchorSchedule({ ...base, isHourly: false, currentTip: { seq: 40 + LEDGER_ANCHOR_SEQ_THRESHOLD - 1, rowHash: "g".repeat(64) }, lastAnchor: { seq: 40, rowHash: "h".repeat(64) } });
    expect(result).toEqual({ shouldAnchor: false, reason: "unchanged" });
  });

  it("threshold takes priority even ON an hourly tick when both would otherwise fire", () => {
    const result = decideLedgerAnchorSchedule({ ...base, isHourly: true, currentTip: { seq: 400, rowHash: "i".repeat(64) }, lastAnchor: { seq: 1, rowHash: "j".repeat(64) } });
    expect(result).toEqual({ shouldAnchor: true, reason: "seq_threshold" });
  });
});

describe("resolveGitAnchorTarget", () => {
  it("returns null when owner or repo is unset -- git anchoring simply isn't configured", () => {
    expect(resolveGitAnchorTarget({})).toBeNull();
    expect(resolveGitAnchorTarget({ LOOPOVER_LEDGER_ANCHOR_GIT_OWNER: "acme" })).toBeNull();
    expect(resolveGitAnchorTarget({ LOOPOVER_LEDGER_ANCHOR_GIT_REPO: "anchors" })).toBeNull();
  });

  it("defaults branch to main and path to anchors.jsonl", () => {
    expect(resolveGitAnchorTarget({ LOOPOVER_LEDGER_ANCHOR_GIT_OWNER: "acme", LOOPOVER_LEDGER_ANCHOR_GIT_REPO: "anchors" })).toEqual({
      owner: "acme",
      repo: "anchors",
      branch: "main",
      path: "anchors.jsonl",
    });
  });

  it("honors an explicit branch and path", () => {
    expect(
      resolveGitAnchorTarget({
        LOOPOVER_LEDGER_ANCHOR_GIT_OWNER: "acme",
        LOOPOVER_LEDGER_ANCHOR_GIT_REPO: "anchors",
        LOOPOVER_LEDGER_ANCHOR_GIT_BRANCH: "anchors-branch",
        LOOPOVER_LEDGER_ANCHOR_GIT_PATH: "custom.jsonl",
      }),
    ).toEqual({ owner: "acme", repo: "anchors", branch: "anchors-branch", path: "custom.jsonl" });
  });
});

async function seedOneDecision(env: Env): Promise<void> {
  const { record, recordDigest } = await buildDecisionRecord({
    repoFullName: "acme/widgets",
    pullNumber: 1,
    headSha: "abc1",
    baseSha: null,
    action: "merge",
    reasonCode: "gate_clean",
    configDigest: await contentDigest({ gatePack: "oss-anti-slop" }),
    gatePack: "oss-anti-slop",
    ciState: null,
    modelIds: null,
    promptDigest: null,
    aiConfidence: null,
    salvageability: null,
  });
  await persistDecisionRecord(env, record, recordDigest);
}

async function keyedEnv(): Promise<{ env: Env; privateKeyPem: string; publicKeySpki: string; keyId: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const toBase64 = (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const pkcs8 = toBase64(new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer));
  const publicKeySpki = toBase64(new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer));
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${(pkcs8.match(/.{1,64}/g) ?? []).join("\n")}\n-----END PRIVATE KEY-----`;
  const keyId = await computeAnchorKeyId(publicKeySpki);
  const env = createTestEnv({
    LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: privateKeyPem,
    LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([{ keyId, publicKeySpki, notBefore: "2026-01-01T00:00:00.000Z", notAfter: null }]),
  });
  return { env, privateKeyPem, publicKeySpki, keyId };
}

describe("runScheduledLedgerAnchor (#9274)", () => {
  it("does nothing on an empty ledger", async () => {
    const { env } = await keyedEnv();
    const submitRekor = vi.fn();
    const decision = await runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor });
    expect(decision).toEqual({ shouldAnchor: false, reason: "empty_ledger" });
    expect(submitRekor).not.toHaveBeenCalled();
  });

  it("calls submitRekor on the hourly tick when the tip changed, and records nothing extra when unconfigured", async () => {
    const env = createTestEnv(); // no signing key configured
    await seedOneDecision(env);
    const submitRekor = vi.fn();
    const decision = await runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor });
    expect(decision).toEqual({ shouldAnchor: true, reason: "hourly" });
    expect(submitRekor).not.toHaveBeenCalled(); // no signing key -> skipped, honest degrade
  });

  it("signs the payload and calls submitRekor when a signing key IS configured", async () => {
    const { env } = await keyedEnv();
    await seedOneDecision(env);
    const submitRekor = vi.fn().mockResolvedValue(undefined);
    await runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor });
    expect(submitRekor).toHaveBeenCalledTimes(1);
    const [signed] = submitRekor.mock.calls[0] as [SignedLedgerAnchor, string];
    expect(signed.payload.seq).toBe(1);
    expect(signed.signature).not.toBe("");
  });

  it("attempts BOTH backends independently -- Rekor still runs even when submitGit rejects, and vice versa", async () => {
    const { env } = await keyedEnv();
    await seedOneDecision(env);
    const submitRekor = vi.fn().mockRejectedValue(new Error("rekor down"));
    const submitGit = vi.fn().mockResolvedValue(undefined);
    await runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor, submitGit });
    expect(submitRekor).toHaveBeenCalledTimes(1);
    expect(submitGit).toHaveBeenCalledTimes(1); // git still ran despite Rekor's rejection
  });

  it("a rejecting submitGit (e.g. a token-mint failure) is recorded as a failed git attempt, not an unhandled rejection", async () => {
    const { env } = await keyedEnv();
    await seedOneDecision(env);
    const submitRekor = vi.fn().mockResolvedValue(undefined);
    const submitGit = vi.fn().mockRejectedValue(new Error("failed to mint installation token"));

    await expect(runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor, submitGit })).resolves.toBeDefined();

    const { anchors } = await loadPublicLedgerAnchors(env, { backend: "git" });
    expect(anchors[0]).toMatchObject({ backend: "git", status: "failed", error: "failed to mint installation token" });
  });

  it("does not attempt git anchoring when submitGit is omitted (not configured)", async () => {
    const { env } = await keyedEnv();
    await seedOneDecision(env);
    const submitRekor = vi.fn().mockResolvedValue(undefined);
    await runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor });
    const { anchors } = await loadPublicLedgerAnchors(env, { backend: "git" });
    expect(anchors).toEqual([]);
  });

  // #9646: the required-success backend list must come from the backends this tick will ACTUALLY attempt.
  // Insert an anchor row for the tip's exact row_hash at a given backend/status.
  const recordAnchor = async (env: Env, rowHash: string, backend: string, status: "ok" | "failed") => {
    await env.DB.prepare(
      "INSERT INTO decision_ledger_anchors (id, seq, row_hash, payload_json, signature, key_id, backend, status, created_at) VALUES (?, 1, ?, '{}', 'sig', 'k1', ?, ?, ?)",
    )
      .bind(`${backend}-${status}-${Math.random()}`, rowHash, backend, status, new Date().toISOString())
      .run();
  };

  it("REGRESSION: with submitGit omitted, a tip already anchored to rekor stays quiet — no re-anchor, submitRekor called zero times (#9646)", async () => {
    const { env } = await keyedEnv();
    await seedOneDecision(env);
    const tip = await loadDecisionLedgerTip(env);
    await recordAnchor(env, tip.rowHash, "rekor", "ok");
    const submitRekor = vi.fn().mockResolvedValue(undefined);
    // git unconfigured (submitGit omitted): rekor is the ONLY required backend, and it is already ok.
    const decision = await runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor });
    expect(decision).toEqual({ shouldAnchor: false, reason: "unchanged" });
    expect(submitRekor).not.toHaveBeenCalled();
  });

  it("still retries when the rekor row is FAILED, even with submitGit omitted (#9646)", async () => {
    const { env } = await keyedEnv();
    await seedOneDecision(env);
    const tip = await loadDecisionLedgerTip(env);
    await recordAnchor(env, tip.rowHash, "rekor", "failed");
    const submitRekor = vi.fn().mockResolvedValue(undefined);
    const decision = await runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor });
    expect(decision).toEqual({ shouldAnchor: true, reason: "retry_unanchored" });
    expect(submitRekor).toHaveBeenCalledTimes(1);
  });

  it("still requires git when submitGit IS wired: rekor ok but git missing → retries and both submitters run (#9646)", async () => {
    const { env } = await keyedEnv();
    await seedOneDecision(env);
    const tip = await loadDecisionLedgerTip(env);
    await recordAnchor(env, tip.rowHash, "rekor", "ok"); // rekor done, git has no ok row
    const submitRekor = vi.fn().mockResolvedValue(undefined);
    const submitGit = vi.fn().mockResolvedValue(undefined);
    const decision = await runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor, submitGit });
    expect(decision).toEqual({ shouldAnchor: true, reason: "retry_unanchored" });
    expect(submitRekor).toHaveBeenCalledTimes(1);
    expect(submitGit).toHaveBeenCalledTimes(1);
  });

  it("skips entirely (no signing attempted) when the published key set has no unambiguous current key", async () => {
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: "irrelevant", LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([]) });
    await seedOneDecision(env);
    const submitRekor = vi.fn();
    await runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor });
    expect(submitRekor).not.toHaveBeenCalled();
  });

  it("skips entirely when a current key IS published but the private key is not configured (the other unconfigured arm)", async () => {
    const { publicKeySpki, keyId } = await keyedEnv();
    const env = createTestEnv({ LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([{ keyId, publicKeySpki, notBefore: "2026-01-01T00:00:00.000Z", notAfter: null }]) });
    await seedOneDecision(env);
    const submitRekor = vi.fn();
    await runScheduledLedgerAnchor(env, { isHourly: true }, { submitRekor });
    expect(submitRekor).not.toHaveBeenCalled();
  });

  it("uses the REAL submitToRekor by default when no submitRekor is injected", async () => {
    const { env } = await keyedEnv();
    await seedOneDecision(env);
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ x: { logIndex: 1, uuid: "u", logId: { keyId: "k" } } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await runScheduledLedgerAnchor(env, { isHourly: true }); // no deps at all -- exercises the real default
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("rekor.sigstore.dev"), expect.anything());
    const { anchors } = await loadPublicLedgerAnchors(env, { backend: "rekor" });
    expect(anchors[0]).toMatchObject({ status: "ok" });
  });
});

// #9489: loadLastLedgerAnchorAttempt deliberately returns the newest attempt REGARDLESS of status, so the
// scheduler advances to newer tips rather than hammering a stale checkpoint. But that made a FAILURE at a
// QUIET tip unrecoverable: Rekor 429s at seq N, the ledger goes quiet (a weekend), and every hourly tick then
// sees tipUnchanged and returns "unchanged" -- so the tip carries NO valid external anchor indefinitely, which
// is exactly the unanchored window this feature exists to bound. It was also backend-blind: git succeeding at
// seq N masked rekor failing at the same seq, because the newest row won regardless of which backend wrote it.
describe("retrying an unanchored tip (#9489)", () => {
  const tip = { seq: 5, rowHash: "hash-5" };
  const sameTipAnchor = { seq: 5, rowHash: "hash-5" };

  it("REGRESSION: an hourly tick RETRIES an unchanged tip that no backend has successfully anchored", () => {
    expect(
      decideLedgerAnchorSchedule({ isHourly: true, currentTip: tip, lastAnchor: sameTipAnchor, seqThreshold: 100, unanchoredBackends: ["rekor"] }),
    ).toEqual({ shouldAnchor: true, reason: "retry_unanchored" });
  });

  it("REGRESSION: a PARTIALLY anchored tip still retries, so one backend's success cannot mask another's failure", () => {
    expect(
      decideLedgerAnchorSchedule({ isHourly: true, currentTip: tip, lastAnchor: sameTipAnchor, seqThreshold: 100, unanchoredBackends: ["git"] }).shouldAnchor,
    ).toBe(true);
  });

  it("INVARIANT: a fully anchored unchanged tip stays quiet -- no re-anchoring churn", () => {
    expect(
      decideLedgerAnchorSchedule({ isHourly: true, currentTip: tip, lastAnchor: sameTipAnchor, seqThreshold: 100, unanchoredBackends: [] }),
    ).toEqual({ shouldAnchor: false, reason: "unchanged" });
  });

  it("INVARIANT: an unanchored tip does NOT force a non-hourly tick to anchor", () => {
    // The retry rides the hourly cadence rather than firing on every tick, which is what bounds the backoff.
    expect(
      decideLedgerAnchorSchedule({ isHourly: false, currentTip: tip, lastAnchor: sameTipAnchor, seqThreshold: 100, unanchoredBackends: ["rekor"] }),
    ).toEqual({ shouldAnchor: false, reason: "unchanged" });
  });

  it("INVARIANT: an empty ledger is still never anchored, whatever the backend state says", () => {
    expect(
      decideLedgerAnchorSchedule({ isHourly: true, currentTip: { seq: 0, rowHash: "genesis" }, lastAnchor: null, seqThreshold: 100, unanchoredBackends: ["rekor", "git"] }),
    ).toEqual({ shouldAnchor: false, reason: "empty_ledger" });
  });

  it("INVARIANT: omitting unanchoredBackends preserves the pre-#9489 behaviour exactly", () => {
    expect(
      decideLedgerAnchorSchedule({ isHourly: true, currentTip: tip, lastAnchor: sameTipAnchor, seqThreshold: 100 }),
    ).toEqual({ shouldAnchor: false, reason: "unchanged" });
  });
});
