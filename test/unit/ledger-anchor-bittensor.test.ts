import { describe, expect, it } from "vitest";
import {
  BittensorAnchorReportRequestSchema,
  ingestBittensorAnchorReport,
  parseBittensorAnchorReport,
  type BittensorAnchorReport,
} from "../../src/review/ledger-anchor-bittensor";
import {
  buildLedgerAnchorPayload,
  computeAnchorKeyId,
  signLedgerAnchorPayload,
  LEDGER_ANCHOR_LEDGER_ID,
  LEDGER_ANCHOR_PAYLOAD_VERSION,
  type SignedLedgerAnchor,
} from "../../src/review/ledger-anchor";
import { appendDecisionLedger, loadDecisionLedgerTip } from "../../src/review/decision-record";
import { loadPublicLedgerAnchors } from "../../src/review/ledger-anchor-persistence";
import { createTestEnv } from "../helpers/d1";
import { createApp } from "../../src/api/routes";
import { verifyLedgerAnchorSignature, anchorKeyById, parseAnchorPublicKeys } from "../../src/review/ledger-anchor";

// #9277 (epic #9267): the Bittensor commitment backend's repo-side glue. The on-chain SUBMISSION runs on the
// operator's node infrastructure and is deliberately not in this repo; what IS here — and what these tests
// pin — is the validation boundary: a report only lands in the PUBLIC attempt log as `ok` when its signed
// payload verifies against a published key AND its (seq, rowHash) matches the live chain. Real ECDSA keys,
// real signatures, real D1 rows — same discipline as every sibling anchor suite.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toPem(base64: string, label: string): string {
  return `-----BEGIN ${label}-----\n${(base64.match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----`;
}

async function generateKeypair(): Promise<{ privateKeyPem: string; publicKeySpki: string; keyId: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer));
  const publicKeySpki = bytesToBase64(new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer));
  return { privateKeyPem: toPem(pkcs8, "PRIVATE KEY"), publicKeySpki, keyId: await computeAnchorKeyId(publicKeySpki) };
}

const REF = { netuid: 74, blockNumber: 5_000_001, blockHash: `0x${"ab".repeat(32)}`, hotkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty" };

/** A ledger with one real row, a published key, and a correctly signed payload for that live tip. */
async function anchoredFixture() {
  const { privateKeyPem, publicKeySpki, keyId } = await generateKeypair();
  const env = createTestEnv({
    LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([{ keyId, publicKeySpki, notBefore: "2026-01-01T00:00:00.000Z", notAfter: null }]),
  });
  await appendDecisionLedger(env, "record:o/r#1@sha1", "d".repeat(64));
  const tip = await loadDecisionLedgerTip(env);
  const signed = await signLedgerAnchorPayload(buildLedgerAnchorPayload(tip, "2026-07-28T00:00:00.000Z"), privateKeyPem, keyId);
  return { env, signed, privateKeyPem, keyId };
}

function okBody(signed: SignedLedgerAnchor): Record<string, unknown> {
  return { signed, status: "ok", backendRef: { ...REF } };
}

describe("parseBittensorAnchorReport (#9277)", () => {
  it("accepts a complete ok report and normalizes the block hash to lowercase", async () => {
    const { signed } = await anchoredFixture();
    const parsed = parseBittensorAnchorReport({ signed, status: "ok", backendRef: { ...REF, blockHash: REF.blockHash.toUpperCase().replace("0X", "0x") } });
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.report.status).toBe("ok");
    if (parsed.report.status === "ok") expect(parsed.report.backendRef.blockHash).toBe(REF.blockHash);
  });

  it("accepts a failed report with just the signed payload and an error string (bounded to 500 chars)", async () => {
    const { signed } = await anchoredFixture();
    const parsed = parseBittensorAnchorReport({ signed, status: "failed", error: `  ${"e".repeat(600)}  ` });
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.report.status).toBe("failed");
    if (parsed.report.status === "failed") expect(parsed.report.error).toHaveLength(500);
  });

  it("names the exact refused field for every malformed shape — a submitter bug is diagnosable from the 400 alone", async () => {
    const { signed } = await anchoredFixture();
    const p = signed.payload;
    const cases: Array<[unknown, string]> = [
      [null, "JSON object"],
      ["x", "JSON object"],
      [{ status: "ok" }, "signed: missing"],
      [{ signed: "x", status: "ok" }, "signed: missing"],
      [{ signed: {}, status: "ok" }, "signed.payload: missing"],
      [{ signed: { payload: { ...p, v: 99 } }, status: "ok" }, "signed.payload.v"],
      [{ signed: { payload: { ...p, ledger: "other" } }, status: "ok" }, "signed.payload.ledger"],
      [{ signed: { payload: { ...p, seq: 0 } }, status: "ok" }, "signed.payload.seq"],
      [{ signed: { payload: { ...p, seq: 1.5 } }, status: "ok" }, "signed.payload.seq"],
      [{ signed: { payload: { ...p, rowHash: "xyz" } }, status: "ok" }, "signed.payload.rowHash"],
      [{ signed: { payload: { ...p, totalCount: 0 } }, status: "ok" }, "signed.payload.totalCount"],
      [{ signed: { payload: { ...p, at: "" } }, status: "ok" }, "signed.payload.at"],
      [{ signed: { payload: p, keyId: "" }, status: "ok" }, "signed.keyId"],
      [{ signed: { payload: p, keyId: "k", signature: "x".repeat(513) }, status: "ok" }, "signed.signature"],
      [{ signed: { payload: p, keyId: "k", signature: "sig" }, status: "maybe" }, "status"],
      [{ signed: { payload: p, keyId: "k", signature: "sig" }, status: "failed" }, "error: required"],
      [{ signed: { payload: p, keyId: "k", signature: "sig" }, status: "failed", error: "  " }, "error: required"],
      [{ signed: { payload: p, keyId: "k", signature: "sig" }, status: "ok" }, "backendRef: required"],
      [{ ...okBody(signed), backendRef: { ...REF, netuid: -1 } }, "backendRef.netuid"],
      [{ ...okBody(signed), backendRef: { ...REF, netuid: 65536 } }, "backendRef.netuid"],
      [{ ...okBody(signed), backendRef: { ...REF, blockNumber: 0 } }, "backendRef.blockNumber"],
      [{ ...okBody(signed), backendRef: { ...REF, blockHash: "0x123" } }, "backendRef.blockHash"],
      [{ ...okBody(signed), backendRef: { ...REF, hotkey: "" } }, "backendRef.hotkey"],
      [{ ...okBody(signed), backendRef: { ...REF, hotkey: "h".repeat(65) } }, "backendRef.hotkey"],
    ];
    for (const [raw, expected] of cases) {
      const parsed = parseBittensorAnchorReport(raw);
      expect("error" in parsed, JSON.stringify(raw).slice(0, 80)).toBe(true);
      if ("error" in parsed) expect(parsed.error).toContain(expected);
    }
  });

  it("netuid 0 (the root subnet) is a valid netuid — the floor is 0, not 1", async () => {
    const { signed } = await anchoredFixture();
    const parsed = parseBittensorAnchorReport({ ...okBody(signed), backendRef: { ...REF, netuid: 0 } });
    expect("report" in parsed).toBe(true);
  });
});

describe("ingestBittensorAnchorReport (#9277) — the verification boundary the public log sits behind", () => {
  it("records a fully verified ok report, and it appears in the PUBLIC attempt log as backend=bittensor", async () => {
    const { env, signed } = await anchoredFixture();
    const report: BittensorAnchorReport = { signed, status: "ok", backendRef: { ...REF } };
    expect(await ingestBittensorAnchorReport(env, report)).toEqual({ recorded: true, status: "ok" });
    const listed = await loadPublicLedgerAnchors(env, { backend: "bittensor" });
    expect(listed.anchors).toHaveLength(1);
    expect(listed.anchors[0]).toMatchObject({ backend: "bittensor", status: "ok", seq: signed.payload.seq, rowHash: signed.payload.rowHash, backendRef: REF });
  });

  it("REGRESSION: an ok report signed by an UNPUBLISHED key is refused — a bearer token alone cannot forge corroboration", async () => {
    const { env, signed } = await anchoredFixture();
    const rogue = await generateKeypair();
    const forged = await signLedgerAnchorPayload(signed.payload, rogue.privateKeyPem, rogue.keyId);
    expect(await ingestBittensorAnchorReport(env, { signed: forged, status: "ok", backendRef: { ...REF } })).toEqual({ recorded: false, reason: "unknown_key" });
    // Claiming the PUBLISHED keyId over a rogue signature fails the signature check instead.
    const impersonating = { ...forged, keyId: signed.keyId };
    expect(await ingestBittensorAnchorReport(env, { signed: impersonating, status: "ok", backendRef: { ...REF } })).toEqual({ recorded: false, reason: "bad_signature" });
    expect((await loadPublicLedgerAnchors(env, { backend: "bittensor" })).anchors).toHaveLength(0);
  });

  it("REGRESSION: an ok report is bound to the LIVE chain — a wrong seq or a re-chained rowHash is refused", async () => {
    const { env, signed, privateKeyPem, keyId } = await anchoredFixture();
    // Seq beyond the live tip: no row to bind to.
    const beyond = await signLedgerAnchorPayload({ ...signed.payload, seq: 999 }, privateKeyPem, keyId);
    expect(await ingestBittensorAnchorReport(env, { signed: beyond, status: "ok", backendRef: { ...REF } })).toEqual({ recorded: false, reason: "row_not_found" });
    // Right seq, wrong hash: exactly what anchoring exists to catch — a validly signed payload for a hash
    // that is not THIS chain's row must never enter the log as corroboration.
    const rechained = await signLedgerAnchorPayload({ ...signed.payload, rowHash: "b".repeat(64) }, privateKeyPem, keyId);
    expect(await ingestBittensorAnchorReport(env, { signed: rechained, status: "ok", backendRef: { ...REF } })).toEqual({ recorded: false, reason: "row_hash_mismatch" });
  });

  it("INVARIANT: a FAILED report records without signature/row verification — a broken submitter must be publicly visible, not silently unloggable", async () => {
    const { env, signed } = await anchoredFixture();
    const rogue = await generateKeypair();
    const unverifiable = await signLedgerAnchorPayload(signed.payload, rogue.privateKeyPem, rogue.keyId);
    expect(await ingestBittensorAnchorReport(env, { signed: unverifiable, status: "failed", error: "subtensor RPC timeout after 3 attempts" })).toEqual({ recorded: true, status: "failed" });
    const listed = await loadPublicLedgerAnchors(env, { backend: "bittensor" });
    expect(listed.anchors).toHaveLength(1);
    expect(listed.anchors[0]).toMatchObject({ backend: "bittensor", status: "failed", error: "subtensor RPC timeout after 3 attempts", backendRef: null });
  });

  it("payload constants round-trip: the fixture's payload is exactly the shape the parser demands", async () => {
    const { signed } = await anchoredFixture();
    expect(signed.payload.v).toBe(LEDGER_ANCHOR_PAYLOAD_VERSION);
    expect(signed.payload.ledger).toBe(LEDGER_ANCHOR_LEDGER_ID);
    const parsed = parseBittensorAnchorReport(okBody(signed));
    expect("report" in parsed).toBe(true);
  });
});

describe("#9277 routes — the submitter's two HTTP touchpoints", () => {
  it("GET anchor-payload serves a freshly signed checkpoint an outside verifier can check, and degrades honestly", async () => {
    const app = createApp();
    const { privateKeyPem, publicKeySpki, keyId } = await generateKeypair();
    // Unconfigured signing: honest 404, not a crash and not an unsigned payload.
    const bare = createTestEnv();
    expect((await app.request("/v1/public/decision-ledger/anchor-payload", {}, bare)).status).toBe(404);
    // Configured but EMPTY ledger: nothing to anchor yet.
    const env = createTestEnv({
      LOOPOVER_LEDGER_ANCHOR_KEYS: JSON.stringify([{ keyId, publicKeySpki, notBefore: "2026-01-01T00:00:00.000Z", notAfter: null }]),
      LOOPOVER_LEDGER_ANCHOR_PRIVATE_KEY: privateKeyPem,
    });
    expect((await app.request("/v1/public/decision-ledger/anchor-payload", {}, env)).status).toBe(404);
    // With a real row: unauthenticated 200 whose signature verifies against the PUBLISHED key — the exact
    // check the off-Worker submitter (or anyone) runs before committing the hash on-chain.
    await appendDecisionLedger(env, "record:o/r#1@sha1", "d".repeat(64));
    const res = await app.request("/v1/public/decision-ledger/anchor-payload", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { signed: SignedLedgerAnchor; signingInput: string };
    expect(body.signed.payload.seq).toBe(1);
    expect(body.signingInput).toContain(LEDGER_ANCHOR_LEDGER_ID);
    const key = anchorKeyById(parseAnchorPublicKeys(env.LOOPOVER_LEDGER_ANCHOR_KEYS), body.signed.keyId);
    expect(key && (await verifyLedgerAnchorSignature(body.signed, key.publicKeySpki))).toBe(true);
  });

  it("POST anchor-attempts FAILS CLOSED with no token configured, rejects a wrong bearer, and accepts a verified report end-to-end", async () => {
    const app = createApp();
    const { env, signed } = await anchoredFixture();
    const post = (target: Env, headers: Record<string, string>, body: unknown) =>
      app.request("/v1/decision-ledger/anchor-attempts", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }, target);
    // Unset token: rejected — an unconfigured collector never accepts anonymous writes.
    expect((await post(env, {}, okBody(signed))).status).toBe(401);
    (env as { LOOPOVER_LEDGER_ANCHOR_REPORT_TOKEN?: string }).LOOPOVER_LEDGER_ANCHOR_REPORT_TOKEN = "s3cret";
    expect((await post(env, { authorization: "Bearer nope" }, okBody(signed))).status).toBe(401);
    // An oversize body is refused at the byte ceiling before any parsing.
    const oversize = await app.request(
      "/v1/decision-ledger/anchor-attempts",
      { method: "POST", body: "x", headers: { "content-type": "application/json", authorization: "Bearer s3cret", "content-length": "2097152" } },
      env,
    );
    expect(oversize.status).toBe(413);
    // Malformed JSON and malformed reports are the route's own 400s, with the parser's named reason.
    const badJson = await app.request("/v1/decision-ledger/anchor-attempts", { method: "POST", body: "{nope", headers: { "content-type": "application/json", authorization: "Bearer s3cret" } }, env);
    expect(badJson.status).toBe(400);
    // An EMPTY body is invalid JSON too, not a crash on undefined.
    const emptyBody = await app.request("/v1/decision-ledger/anchor-attempts", { method: "POST", headers: { authorization: "Bearer s3cret" } }, env);
    expect(emptyBody.status).toBe(400);
    const badReport = await post(env, { authorization: "Bearer s3cret" }, { status: "ok" });
    expect(badReport.status).toBe(400);
    expect(((await badReport.json()) as { detail: string }).detail).toContain("signed: missing");
    // An authenticated but UNVERIFIABLE ok report is 422 with the named reason — never recorded.
    const rogue = await generateKeypair();
    const forged = await signLedgerAnchorPayload(signed.payload, rogue.privateKeyPem, rogue.keyId);
    const refused = await post(env, { authorization: "Bearer s3cret" }, okBody(forged));
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe("unknown_key");
    // The genuine report lands, and the PUBLIC listing (filter widened to bittensor) serves it.
    const accepted = await post(env, { authorization: "Bearer s3cret" }, okBody(signed));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ recorded: true, status: "ok" });
    const listing = await app.request("/v1/public/decision-ledger/anchors?backend=bittensor", {}, env);
    const listed = (await listing.json()) as { anchors: Array<{ backend: string; status: string }> };
    expect(listed.anchors).toHaveLength(1);
    expect(listed.anchors[0]).toMatchObject({ backend: "bittensor", status: "ok" });
    // The widened filter keeps every sibling arm intact: named backends still filter, junk still means "all".
    for (const [query, expected] of [["?backend=rekor", 0], ["?backend=git", 0], ["?backend=ots", 0], ["?backend=nonsense", 1], ["", 1]] as const) {
      const page = await app.request(`/v1/public/decision-ledger/anchors${query}`, {}, env);
      expect(((await page.json()) as { anchors: unknown[] }).anchors).toHaveLength(expected);
    }
  });
});

// #9770: the published request schema and the runtime validator are one contract described twice --
// parseBittensorAnchorReport stays the authority (its per-field named rejections are what make a submitter
// bug diagnosable from the 400 body), and the zod schema exists so the OpenAPI document actually describes
// the shape a caller must send. This suite is the mechanism that stops them drifting: the SAME payloads go
// through both, and the two must agree on accept/reject.
describe("BittensorAnchorReportRequestSchema agrees with parseBittensorAnchorReport (#9770)", () => {
  const okBody = () => ({
    signed: {
      payload: {
        v: LEDGER_ANCHOR_PAYLOAD_VERSION,
        ledger: LEDGER_ANCHOR_LEDGER_ID,
        seq: 7,
        rowHash: "a".repeat(64),
        totalCount: 7,
        at: "2026-07-29T00:00:00.000Z",
      },
      keyId: "k1",
      signature: "c2ln",
    },
    status: "ok" as const,
    backendRef: { netuid: 42, blockNumber: 1234, blockHash: `0x${"b".repeat(64)}`, hotkey: "5Fabc" },
  });
  const failedBody = () => ({ signed: okBody().signed, status: "failed" as const, error: "commitment reverted" });

  /** Every case below is run through BOTH. `accepted` is what they must agree on. */
  const cases: Array<{ name: string; body: unknown; accepted: boolean }> = [
    { name: "a well-formed ok report", body: okBody(), accepted: true },
    { name: "a well-formed failed report", body: failedBody(), accepted: true },
    { name: "an UPPERCASE rowHash / blockHash (case-insensitive by class, not by flag)", body: { ...okBody(), signed: { ...okBody().signed, payload: { ...okBody().signed.payload, rowHash: "A".repeat(64) } }, backendRef: { ...okBody().backendRef, blockHash: `0x${"B".repeat(64)}` } }, accepted: true },
    { name: "a non-object body", body: "nope", accepted: false },
    { name: "a missing signed block", body: { status: "ok" }, accepted: false },
    { name: "a wrong payload version", body: { ...okBody(), signed: { ...okBody().signed, payload: { ...okBody().signed.payload, v: 2 } } }, accepted: false },
    { name: "a wrong ledger id", body: { ...okBody(), signed: { ...okBody().signed, payload: { ...okBody().signed.payload, ledger: "someone.else" } } }, accepted: false },
    { name: "a zero seq", body: { ...okBody(), signed: { ...okBody().signed, payload: { ...okBody().signed.payload, seq: 0 } } }, accepted: false },
    { name: "a non-integer seq", body: { ...okBody(), signed: { ...okBody().signed, payload: { ...okBody().signed.payload, seq: 1.5 } } }, accepted: false },
    { name: "a short rowHash", body: { ...okBody(), signed: { ...okBody().signed, payload: { ...okBody().signed.payload, rowHash: "abc" } } }, accepted: false },
    { name: "an empty at", body: { ...okBody(), signed: { ...okBody().signed, payload: { ...okBody().signed.payload, at: "" } } }, accepted: false },
    { name: "an over-long at", body: { ...okBody(), signed: { ...okBody().signed, payload: { ...okBody().signed.payload, at: "x".repeat(41) } } }, accepted: false },
    { name: "an empty keyId", body: { ...okBody(), signed: { ...okBody().signed, keyId: "" } }, accepted: false },
    { name: "an over-long keyId", body: { ...okBody(), signed: { ...okBody().signed, keyId: "k".repeat(65) } }, accepted: false },
    { name: "an over-long signature", body: { ...okBody(), signed: { ...okBody().signed, signature: "s".repeat(513) } }, accepted: false },
    { name: "an unknown status", body: { ...okBody(), status: "maybe" }, accepted: false },
    { name: "an ok report with no backendRef", body: { signed: okBody().signed, status: "ok" }, accepted: false },
    { name: "a failed report with no error", body: { signed: okBody().signed, status: "failed" }, accepted: false },
    { name: "a failed report with a blank error", body: { ...failedBody(), error: "   " }, accepted: false },
    { name: "a netuid above the u16 ceiling", body: { ...okBody(), backendRef: { ...okBody().backendRef, netuid: 65_536 } }, accepted: false },
    { name: "a negative netuid", body: { ...okBody(), backendRef: { ...okBody().backendRef, netuid: -1 } }, accepted: false },
    { name: "a zero blockNumber", body: { ...okBody(), backendRef: { ...okBody().backendRef, blockNumber: 0 } }, accepted: false },
    { name: "a blockHash missing its 0x prefix", body: { ...okBody(), backendRef: { ...okBody().backendRef, blockHash: "b".repeat(64) } }, accepted: false },
    { name: "a blank hotkey", body: { ...okBody(), backendRef: { ...okBody().backendRef, hotkey: "  " } }, accepted: false },
    { name: "an over-long hotkey", body: { ...okBody(), backendRef: { ...okBody().backendRef, hotkey: "h".repeat(65) } }, accepted: false },
  ];

  it.each(cases)("$name", ({ body, accepted }) => {
    const runtime = !("error" in parseBittensorAnchorReport(body));
    const published = BittensorAnchorReportRequestSchema.safeParse(body).success;
    expect(runtime).toBe(accepted);
    // The load-bearing assertion: the document never promises a shape the endpoint refuses, and never
    // refuses one the document promises.
    expect(published).toBe(runtime);
  });
});
