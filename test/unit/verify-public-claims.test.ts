import { describe, expect, it } from "vitest";

import { canonicalJson, contentDigest, sha256Hex } from "@loopover/contract/digest";

// The checks ship in the MCP package's lib/, same as format-table.test.ts: imported dynamically from the
// package path so the module under test is the exact one the published bin loads.
async function loadClaims() {
  return import("../../packages/loopover-mcp/lib/verify-public-claims");
}

/** Build a record whose `recordDigest` is genuinely correct, the way the Worker builds one. */
async function signedRecord(overrides: Record<string, unknown> = {}) {
  const preimage = {
    schemaVersion: "1",
    subject: { kind: "agent", id: "loopover" },
    workUnit: { kind: "outcome_confirmed_precision", ruleId: "rule_a" },
    score: { decided: 10, confirmed: 9 },
    commitments: { corpusChecksum: "deadbeef" },
    ...overrides,
  };
  return { ...preimage, recordDigest: await contentDigest(preimage) };
}

describe("checkRecordDigests", () => {
  it("passes when every published digest recomputes from its own record", async () => {
    const { checkRecordDigests } = await loadClaims();
    const result = await checkRecordDigests([await signedRecord(), await signedRecord({ workUnit: { kind: "x", ruleId: "rule_b" } })]);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("2 record(s)");
  });

  it("is insensitive to the key ORDER the endpoint happened to serialize in", async () => {
    // The entire reason a digest is checkable from parsed JSON: canonicalJson sorts keys, so a payload
    // whose fields arrive in a different order must still verify.
    const { checkRecordDigests } = await loadClaims();
    const record = await signedRecord();
    const reordered = Object.fromEntries(Object.entries(record).reverse());
    expect(Object.keys(reordered)).not.toEqual(Object.keys(record));
    expect((await checkRecordDigests([reordered as never])).status).toBe("pass");
  });

  it("FAILS a record whose contents were altered after signing", async () => {
    const { checkRecordDigests } = await loadClaims();
    const record = await signedRecord();
    const tampered = { ...record, score: { decided: 10_000, confirmed: 9_999 } };
    const result = await checkRecordDigests([tampered]);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("recomputed");
  });

  it("FAILS a record publishing no digest at all, rather than skipping it", async () => {
    const { checkRecordDigests } = await loadClaims();
    const { recordDigest: _dropped, ...unsigned } = await signedRecord();
    expect((await checkRecordDigests([unsigned])).status).toBe("fail");
    // The empty-string arm is the same class of miss and must not read as "present".
    expect((await checkRecordDigests([{ ...unsigned, recordDigest: "" }])).status).toBe("fail");
  });

  it("reports an unserializable record instead of throwing and killing later claims", async () => {
    const { checkRecordDigests } = await loadClaims();
    const result = await checkRecordDigests([{ recordDigest: "abc", subject: { id: "s" }, workUnit: { ruleId: undefined }, bad: () => 1 } as never]);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not serializable");
  });

  it("skips, not passes, when nothing is published", async () => {
    const { checkRecordDigests } = await loadClaims();
    expect((await checkRecordDigests([])).status).toBe("skip");
  });
});

describe("checkCorpusCommitments", () => {
  const corpusCases = [{ ruleId: "rule_a", outcome: "o", label: "confirmed", firedAt: "2026-01-01T00:00:00.000Z", decidedAt: "2026-01-02T00:00:00.000Z" }];

  it("passes when a commitment rehashes to the downloadable corpus", async () => {
    const { checkCorpusCommitments } = await loadClaims();
    const checksum = await sha256Hex(canonicalJson(corpusCases));
    const record = await signedRecord({ commitments: { corpusChecksum: checksum } });
    const result = await checkCorpusCommitments([record], new Map([["rule_a", { cases: corpusCases, checksum }]]));
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("1 case(s) rehashed exactly");
  });

  it("recomputes from the CASES, not from the corpus's own checksum field", async () => {
    // A deployment serving cases that do not hash to the checksum it advertises must be caught; trusting
    // the advertised field would make the whole claim vacuous.
    const { checkCorpusCommitments } = await loadClaims();
    const committed = await sha256Hex(canonicalJson(corpusCases));
    const record = await signedRecord({ commitments: { corpusChecksum: committed } });
    const tamperedCases = [{ ...corpusCases[0]!, label: "reversed" }];
    const result = await checkCorpusCommitments([record], new Map([["rule_a", { cases: tamperedCases, checksum: committed }]]));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("hashes to");
  });

  it("FAILS a record that commits to the EMPTY corpus while claiming decided work", async () => {
    const { checkCorpusCommitments, emptyCorpusChecksum } = await loadClaims();
    const record = await signedRecord({ score: { decided: 42 }, commitments: { corpusChecksum: await emptyCorpusChecksum() } });
    const result = await checkCorpusCommitments([record], new Map());
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("EMPTY corpus");
    expect(result.detail).toContain("decided=42");
  });

  it("allows the empty-corpus commitment when nothing was decided", async () => {
    // decided=0 with an empty corpus is coherent, not a contradiction -- the check must not fire on it.
    const { checkCorpusCommitments, emptyCorpusChecksum } = await loadClaims();
    const record = await signedRecord({ score: { decided: 0 }, commitments: { corpusChecksum: await emptyCorpusChecksum() } });
    expect((await checkCorpusCommitments([record], new Map())).status).toBe("skip");
  });

  it("SKIPS rather than passes when no committed corpus is downloadable", async () => {
    // The regression this pins: reporting `pass` with a detail line that says "unverified" is the
    // could-not-check/therefore-fine collapse the module header rules out.
    const { checkCorpusCommitments } = await loadClaims();
    const record = await signedRecord({ commitments: { corpusChecksum: "0".repeat(64) } });
    const result = await checkCorpusCommitments([record], new Map());
    expect(result.status).toBe("skip");
    expect(result.detail).toContain("nothing could be rehashed");
  });

  it("skips when no record published a commitment at all", async () => {
    const { checkCorpusCommitments } = await loadClaims();
    const record = await signedRecord({ commitments: {} });
    expect((await checkCorpusCommitments([record], new Map())).status).toBe("skip");
  });
});

describe("checkAnchorCheckpoint", () => {
  /** A real ECDSA P-256 keypair + signature, produced exactly the way the Worker signs. */
  async function realCheckpoint() {
    // Cast: generateKey's union return and exportKey's ArrayBuffer|JsonWebKey union are both resolved by
    // the arguments used here (an asymmetric algorithm, and the "spki" format), which the lib types do not
    // narrow on.
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
    const publicKeySpki = btoa(String.fromCharCode(...spki));
    const { computeAnchorKeyId, anchorSigningInput } = await import("@loopover/contract/anchor-verify");
    const keyId = await computeAnchorKeyId(publicKeySpki);
    const payload = { v: 1 as const, ledger: "loopover.decision_ledger" as const, seq: 7, rowHash: "abc123", totalCount: 7, at: "2026-07-30T00:00:00.000Z" };
    const signingInput = anchorSigningInput(payload);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(signingInput)));
    const signed = { payload, keyId, signature: btoa(String.fromCharCode(...raw)) };
    return { signed, signingInput, keys: [{ keyId, publicKeySpki, notBefore: "2026-01-01T00:00:00.000Z", notAfter: null }] };
  }

  it("passes on a genuinely signed checkpoint verified against the published key", async () => {
    const { checkAnchorCheckpoint } = await loadClaims();
    const { signed, signingInput, keys } = await realCheckpoint();
    const result = await checkAnchorCheckpoint({ signed, signingInput }, keys);
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("seq 7");
  });

  it("FAILS when the payload was altered after signing", async () => {
    const { checkAnchorCheckpoint } = await loadClaims();
    const { signed, keys } = await realCheckpoint();
    const tampered = { ...signed, payload: { ...signed.payload, seq: 9_999 } };
    expect((await checkAnchorCheckpoint({ signed: tampered }, keys)).status).toBe("fail");
  });

  it("FAILS when the displayed signingInput is not the canonical serialization of the displayed payload", async () => {
    // The check a reader cannot perform by eye: showing one payload while signing different bytes.
    const { checkAnchorCheckpoint } = await loadClaims();
    const { signed, keys } = await realCheckpoint();
    const result = await checkAnchorCheckpoint({ signed, signingInput: '{"v":1,"seq":"something else"}' }, keys);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("signed bytes differ from displayed bytes");
  });

  it("FAILS when the checkpoint names a key that is not published", async () => {
    const { checkAnchorCheckpoint } = await loadClaims();
    const { signed, signingInput, keys } = await realCheckpoint();
    const result = await checkAnchorCheckpoint({ signed: { ...signed, keyId: "not-a-published-key" }, signingInput }, keys);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not among");
  });

  it("skips when no checkpoint is published, and when no key is published to check one against", async () => {
    const { checkAnchorCheckpoint } = await loadClaims();
    const { signed } = await realCheckpoint();
    expect((await checkAnchorCheckpoint(undefined, [])).status).toBe("skip");
    expect((await checkAnchorCheckpoint({ signed: { nonsense: true } }, [])).status).toBe("skip");
    const noKeys = await checkAnchorCheckpoint({ signed }, []);
    expect(noKeys.status).toBe("skip");
    expect(noKeys.detail).toContain("no signing key is published");
  });
});

describe("checkStatsParity", () => {
  it("passes when the windowed rollup fits inside the all-time total", async () => {
    const { checkStatsParity } = await loadClaims();
    const result = checkStatsParity({ totals: { handled: 12_882 } }, { verdicts: 40 });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("12882");
  });

  it("FAILS when the windowed rollup exceeds the all-time total beyond the race tolerance", async () => {
    const { checkStatsParity } = await loadClaims();
    expect(checkStatsParity({ totals: { handled: 10 } }, { verdicts: 500 }).status).toBe("fail");
  });

  it("absorbs a small in-flight difference rather than crying wolf", async () => {
    // The two surfaces are read at different instants against a live ledger; a verdict landing between the
    // fetches must not be reported as an accounting error.
    const { checkStatsParity } = await loadClaims();
    expect(checkStatsParity({ totals: { handled: 100 } }, { verdicts: 103 }).status).toBe("pass");
  });

  it("skips each side independently when its number is absent", async () => {
    const { checkStatsParity } = await loadClaims();
    expect(checkStatsParity({ totals: {} }, { verdicts: 1 }).detail).toContain("totals.handled");
    expect(checkStatsParity({ totals: { handled: 1 } }, {}).detail).toContain("verdict count");
    expect(checkStatsParity(undefined, undefined).status).toBe("skip");
  });
});

describe("exit code and summary", () => {
  it("exits non-zero only when a claim FAILED -- a skip is not a failure", async () => {
    const { exitCodeFor, summarize } = await loadClaims();
    const pass = { id: "a", claim: "a", status: "pass" as const, detail: "" };
    const skip = { id: "b", claim: "b", status: "skip" as const, detail: "" };
    const fail = { id: "c", claim: "c", status: "fail" as const, detail: "" };
    expect(exitCodeFor([pass, skip])).toBe(0);
    expect(exitCodeFor([pass, skip, fail])).toBe(1);
    expect(summarize([pass, skip, fail])).toBe("1 passed, 1 failed, 1 skipped");
  });
});

describe("describeRecord", () => {
  it("falls back through ruleId, subject id, then position", async () => {
    const { describeRecord } = await loadClaims();
    expect(describeRecord({ workUnit: { ruleId: "rule_a" }, subject: { id: "s" } }, 0)).toBe("rule_a");
    expect(describeRecord({ subject: { id: "s" } }, 0)).toBe("s");
    expect(describeRecord({}, 3)).toBe("record[3]");
  });
});
