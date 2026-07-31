import { describe, expect, it } from "vitest";
import {
  buildProofAccuracy,
  buildProofAnchorStatus,
  buildProofBadgeColor,
  buildProofBadgeMessage,
  buildProofLedgerStatus,
  buildProofSummary,
  isProofPageEnabledForRepo,
  isPublicProofPageEnabled,
  loadProofSummary,
  PROOF_BOUNDARY_STATEMENT,
  PROOF_MIN_DECISIONS,
  PROOF_SAMPLE_RECORDS,
} from "../../src/review/proof-summary";
import { renderProofBadgeSvg } from "../../src/api/proof-badge";
import { createApp } from "../../src/api/routes";
import { appendDecisionLedger, persistDecisionRecord } from "../../src/review/decision-record";
import { recordAuditEvent } from "../../src/db/repositories";
import { loadPublicLedgerAnchors, recordLedgerAnchorAttempt } from "../../src/review/ledger-anchor-persistence";
import { createTestEnv } from "../helpers/d1";
import { loadProofPageRepoOverride, resolveProofPage, type ProofPageDeps } from "../../src/review/proof-summary";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import type { PublicLedgerAnchor } from "../../src/review/ledger-anchor-persistence";

// #9569: the public, shareable twin of the in-app trust panel. The properties that matter here are the ones
// that would quietly turn a verification page into a marketing page: an accuracy figure without its
// denominator and interval, a failed anchor attempt presented as an anchor, an empty ledger presented as
// "verified", or a field nobody wrote down leaking through a spread.

const CHECKED_AT = "2026-07-28T12:00:00.000Z";

function anchor(overrides: Partial<PublicLedgerAnchor> = {}): PublicLedgerAnchor {
  return {
    id: "a1",
    seq: 10,
    rowHash: "f".repeat(64),
    keyId: "k1",
    backend: "rekor",
    backendRef: { uuid: "u" },
    status: "ok",
    error: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildProofAccuracy — never a bare scalar (#9569)", () => {
  it("publishes accuracy ONLY with its coverage and a Wilson interval", () => {
    const accuracy = buildProofAccuracy(60, 59);
    expect(accuracy.state).toBe("published");
    if (accuracy.state !== "published") return;
    expect(accuracy).toMatchObject({ accuracy: 0.983, decided: 60, confirmed: 59 });
    // Wilson, not Wald: at 59/60 Wald would claim an upper bound of ~1.017 (impossible) and a lower bound
    // that overstates certainty. Wilson stays inside [0,1] and keeps an honest lower bound.
    expect(accuracy.interval.lo).toBeGreaterThan(0.9);
    expect(accuracy.interval.lo).toBeLessThan(accuracy.accuracy);
    expect(accuracy.interval.hi).toBeLessThanOrEqual(1);
  });

  it("REGRESSION: below the sample floor there is NO rate — but the count is still published", () => {
    const thin = buildProofAccuracy(PROOF_MIN_DECISIONS - 1, PROOF_MIN_DECISIONS - 1);
    expect(thin).toEqual({ state: "insufficient_data", decided: PROOF_MIN_DECISIONS - 1, minimumDecisions: PROOF_MIN_DECISIONS });
    // A perfect record over 19 decisions must NOT render as 100% — that is the exact bare-scalar claim
    // this module exists to refuse.
    expect(JSON.stringify(thin)).not.toContain("accuracy");
    // Zero and negative both degrade to a non-negative count rather than a fabricated rate.
    expect(buildProofAccuracy(0, 0)).toMatchObject({ state: "insufficient_data", decided: 0 });
    expect(buildProofAccuracy(-5, 0)).toMatchObject({ state: "insufficient_data", decided: 0 });
    // Exactly at the floor publishes.
    expect(buildProofAccuracy(PROOF_MIN_DECISIONS, PROOF_MIN_DECISIONS).state).toBe("published");
  });
});

describe("buildProofAnchorStatus (#9569)", () => {
  it("REGRESSION: a FAILED attempt is not an anchor — presenting one would claim corroboration that does not exist", () => {
    expect(buildProofAnchorStatus([anchor({ status: "failed", error: "rekor 429" })])).toEqual({ state: "not_yet_anchored" });
    expect(buildProofAnchorStatus([])).toEqual({ state: "not_yet_anchored" });
  });

  it("picks the NEWEST successful anchor regardless of list order", () => {
    const older = anchor({ id: "old", seq: 5, createdAt: "2026-07-01T00:00:00.000Z" });
    const newer = anchor({ id: "new", seq: 12, createdAt: "2026-07-25T00:00:00.000Z", backend: "git" });
    const failedNewest = anchor({ id: "bad", seq: 13, createdAt: "2026-07-27T00:00:00.000Z", status: "failed", error: "boom" });
    for (const order of [[older, newer, failedNewest], [failedNewest, newer, older]]) {
      expect(buildProofAnchorStatus(order)).toEqual({ state: "anchored", backend: "git", seq: 12, rowHash: "f".repeat(64), at: "2026-07-25T00:00:00.000Z" });
    }
  });
});

describe("buildProofLedgerStatus — honest boundary states (#9569)", () => {
  it("REGRESSION: an EMPTY ledger is `empty`, not `verified` — different claims", () => {
    expect(buildProofLedgerStatus({ ok: true, tipSeq: 0, totalCount: 0, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, CHECKED_AT)).toEqual({ state: "empty", checkedAt: CHECKED_AT });
  });

  it("verified, broken (with kind and position), and unavailable each render distinctly", () => {
    expect(buildProofLedgerStatus({ ok: true, tipSeq: 9, totalCount: 9, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, CHECKED_AT)).toEqual({
      state: "verified", tipSeq: 9, totalCount: 9, checkedAt: CHECKED_AT, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0,
    });
    expect(buildProofLedgerStatus({ ok: false, tipSeq: 9, totalCount: 9, break: { kind: "row_hash_mismatch", atSeq: 4 }, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, CHECKED_AT)).toEqual({
      state: "broken", tipSeq: 9, totalCount: 9, checkedAt: CHECKED_AT, brokenAtSeq: 4, brokenKind: "row_hash_mismatch",
    });
    // A break with no detail is still broken, marked unknown rather than silently claiming seq 0.
    expect(buildProofLedgerStatus({ ok: false, tipSeq: 9, totalCount: 9, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, CHECKED_AT)).toMatchObject({ brokenAtSeq: -1, brokenKind: "unknown" });
    // A failed read is `unavailable` — not "broken", which would accuse the operator of tampering.
    expect(buildProofLedgerStatus(null, CHECKED_AT)).toEqual({ state: "unavailable", checkedAt: CHECKED_AT });
  });
});

describe("buildProofSummary — the structural privacy boundary (#9569)", () => {
  it("REGRESSION: fields nobody named cannot travel, even when the inputs carry them", () => {
    const summary = buildProofSummary({
      repoFullName: "o/r",
      decisionCount: 30,
      decided: 30,
      confirmed: 29,
      verify: { ok: true, tipSeq: 30, totalCount: 30, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 },
      anchors: [anchor()],
      records: [
        {
          pullNumber: 1, action: "merge", reasonCode: "clean", decidedAt: CHECKED_AT, recordDigest: "d".repeat(64),
          // Hostile extras — exactly the classes the privacy boundary names. A spread-based composition
          // would carry every one of these onto an unauthenticated page.
          hotkey: "5FHneW46xGXgs5mUiveU4sbTyGBz", walletAddress: "0xdead", rewardTao: 42, trustScore: 0.9, privateRank: 3,
        } as never,
      ],
      checkedAt: CHECKED_AT,
    });
    const serialized = JSON.stringify(summary);
    for (const forbidden of ["hotkey", "walletAddress", "rewardTao", "trustScore", "privateRank", "0xdead", "5FHneW46"]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The named fields DID come through, so the test is proving allowlisting rather than an empty object.
    expect(summary.sampleRecords[0]).toEqual({ pullNumber: 1, action: "merge", reasonCode: "clean", decidedAt: CHECKED_AT, recordDigest: "d".repeat(64) });
  });

  it("bounds the sample and carries the boundary statement IN the payload", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      pullNumber: index, action: "merge", reasonCode: "clean", decidedAt: CHECKED_AT, recordDigest: String(index).repeat(2),
    }));
    const summary = buildProofSummary({
      repoFullName: "o/r", decisionCount: 25, decided: 25, confirmed: 25,
      verify: { ok: true, tipSeq: 25, totalCount: 25, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, anchors: [], records: many, checkedAt: CHECKED_AT,
    });
    expect(summary.sampleRecords).toHaveLength(PROOF_SAMPLE_RECORDS);
    // The caveat travels IN the payload, so a screenshot or embed cannot shed it the way a footer can.
    expect(summary.boundary).toBe(PROOF_BOUNDARY_STATEMENT);
    expect(summary.boundary).toContain("does not make every row checkable in real time");
  });
});

describe("proof badge (#9569)", () => {
  const summaryWith = (ledger: Parameters<typeof buildProofBadgeMessage>[0]["ledger"], anchored: boolean) =>
    ({ ledger, anchor: anchored ? { state: "anchored" } : { state: "not_yet_anchored" } }) as Parameters<typeof buildProofBadgeMessage>[0];

  it("reports the LEDGER state, never a bare accuracy percentage", () => {
    expect(buildProofBadgeMessage(summaryWith({ state: "verified", tipSeq: 1, totalCount: 1, checkedAt: CHECKED_AT, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, true))).toBe("verified · anchored");
    expect(buildProofBadgeMessage(summaryWith({ state: "verified", tipSeq: 1, totalCount: 1, checkedAt: CHECKED_AT, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, false))).toBe("verified");
    expect(buildProofBadgeMessage(summaryWith({ state: "broken", tipSeq: 1, totalCount: 1, checkedAt: CHECKED_AT, brokenAtSeq: 1, brokenKind: "k" }, false))).toBe("chain broken");
    expect(buildProofBadgeMessage(summaryWith({ state: "empty", checkedAt: CHECKED_AT }, false))).toBe("no decisions yet");
    expect(buildProofBadgeMessage(summaryWith({ state: "unavailable", checkedAt: CHECKED_AT }, false))).toBe("unavailable");
  });

  it("colors a not-yet-decided repo NEUTRALLY — it has not failed anything", () => {
    expect(buildProofBadgeColor(summaryWith({ state: "empty", checkedAt: CHECKED_AT }, false))).toBe("#9e9e9e");
    expect(buildProofBadgeColor(summaryWith({ state: "unavailable", checkedAt: CHECKED_AT }, false))).toBe("#9e9e9e");
    expect(buildProofBadgeColor(summaryWith({ state: "broken", tipSeq: 1, totalCount: 1, checkedAt: CHECKED_AT, brokenAtSeq: 1, brokenKind: "k" }, false))).toBe("#f85149");
    expect(buildProofBadgeColor(summaryWith({ state: "verified", tipSeq: 1, totalCount: 1, checkedAt: CHECKED_AT, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, true))).toBe("#3fb950");
    expect(buildProofBadgeColor(summaryWith({ state: "verified", tipSeq: 1, totalCount: 1, checkedAt: CHECKED_AT, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, false))).toBe("#2da44e");
  });

  it("renders valid SVG for both the summary and the null (unavailable) case, escaping its text", () => {
    const svg = renderProofBadgeSvg(summaryWith({ state: "verified", tipSeq: 1, totalCount: 1, checkedAt: CHECKED_AT, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, true));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("verified · anchored");
    expect(renderProofBadgeSvg(null)).toContain("unavailable");
    // The label and message reach the SVG through the shared escaper — no raw angle brackets survive.
    expect(renderProofBadgeSvg(null)).not.toMatch(/<text[^>]*>[^<]*[<>][^<]*<\/text>/);
  });
});

describe("the opt-OUT gate and its recorded default (#9569 requirement 6)", () => {
  it("the operator flag is OFF by default and truthy-string parsed", () => {
    expect(isPublicProofPageEnabled({})).toBe(false);
    expect(isPublicProofPageEnabled({ LOOPOVER_PUBLIC_PROOF: "" })).toBe(false);
    expect(isPublicProofPageEnabled({ LOOPOVER_PUBLIC_PROOF: "false" })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE"]) {
      expect(isPublicProofPageEnabled({ LOOPOVER_PUBLIC_PROOF: on })).toBe(true);
    }
  });

  it("REGRESSION: a repo defaults ON once the operator opts in, and can opt OUT — but never opt IN alone", () => {
    const on = { LOOPOVER_PUBLIC_PROOF: "true" };
    // Default ON: the data is already public, so a page over it needs no second opt-in.
    expect(isProofPageEnabledForRepo(on)).toBe(true);
    expect(isProofPageEnabledForRepo(on, { present: false, enabled: false })).toBe(true);
    // The repo's opt-out is honored.
    expect(isProofPageEnabledForRepo(on, { present: true, enabled: false })).toBe(false);
    expect(isProofPageEnabledForRepo(on, { present: true, enabled: true })).toBe(true);
    // The operator flag wins outright — a repo cannot opt INTO a surface the fleet has not enabled, which
    // is what keeps the fleet-wide switch a real switch.
    expect(isProofPageEnabledForRepo({}, { present: true, enabled: true })).toBe(false);
  });
});

describe("loadProofSummary + routes (#9569)", () => {
  async function seeded() {
    const env = createTestEnv({ LOOPOVER_PUBLIC_PROOF: "true" });
    for (let index = 1; index <= 3; index += 1) {
      await persistDecisionRecord(
        env,
        {
          schemaVersion: "5", repoFullName: "o/r", pullNumber: index, headSha: `sha${index}`, baseSha: null,
          action: "merge", reasonCode: "clean", configDigest: "c", settingsDigest: "s", gatePack: "oss-anti-slop",
          ciState: "success", modelIds: null, promptDigest: null, aiConfidence: null, aiAgreement: null,
          salvageability: null, divertedByHoldout: false, decidedAt: CHECKED_AT,
        } as never,
        `${index}`.repeat(64),
      );
      await appendDecisionLedger(env, `record:o/r#${index}@sha${index}`, `${index}`.repeat(64));
    }
    return env;
  }

  it("composes from the real tables and degrades per section rather than failing the page", async () => {
    const env = await seeded();
    const summary = await loadProofSummary(env, "o/r", {
      verifyLedger: async () => ({ ok: true, tipSeq: 3, totalCount: 3, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }),
      // A failing anchor read must degrade to not_yet_anchored, not blow up the page.
      loadAnchors: async () => { throw new Error("d1 down"); },
      now: () => CHECKED_AT,
    });
    expect(summary.decisionCount).toBe(3);
    expect(summary.anchor).toEqual({ state: "not_yet_anchored" });
    expect(summary.ledger).toMatchObject({ state: "verified", totalCount: 3 });
    // Three decisions is under the floor — no rate is claimed.
    expect(summary.accuracy.state).toBe("insufficient_data");
    expect(summary.sampleRecords.length).toBeGreaterThan(0);
    // A failing LEDGER read likewise degrades to unavailable rather than throwing.
    const degraded = await loadProofSummary(env, "o/r", {
      verifyLedger: async () => { throw new Error("d1 down"); },
      loadAnchors: async () => ({ anchors: [] }),
      now: () => CHECKED_AT,
    });
    expect(degraded.ledger).toEqual({ state: "unavailable", checkedAt: CHECKED_AT });
  });

  it("INVARIANT: every DB section degrades independently — a failing read never fabricates a figure", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_PROOF: "true" });
    // Both decision-record reads throw. The page must still compose, reporting zero decisions and no rate,
    // rather than surfacing a partial or invented number on an unauthenticated marketing surface.
    (env.DB as unknown as { prepare: () => never }).prepare = () => {
      throw new Error("d1 down");
    };
    const summary = await loadProofSummary(env, "o/r", {
      verifyLedger: async () => ({ ok: true, tipSeq: 0, totalCount: 0, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }),
      loadAnchors: async () => ({ anchors: [] }),
      now: () => CHECKED_AT,
    });
    expect(summary).toMatchObject({ decisionCount: 0, sampleRecords: [], ledger: { state: "empty" } });
    expect(summary.accuracy).toMatchObject({ state: "insufficient_data", decided: 0 });
  });

  it("a driver returning no `results` array degrades to an empty sample rather than throwing", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_PROOF: "true" });
    // A D1 driver that resolves without a `results` key — the `?? []` arm, which a real outage or a driver
    // version change can produce and which must not take the page down.
    (env.DB as unknown as { prepare: (sql: string) => unknown }).prepare = () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({}),
      }),
    });
    const summary = await loadProofSummary(env, "o/r", {
      verifyLedger: async () => ({ ok: true, tipSeq: 0, totalCount: 0, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }),
      loadAnchors: async () => ({ anchors: [] }),
      now: () => CHECKED_AT,
    });
    expect(summary.sampleRecords).toEqual([]);
    expect(summary.decisionCount).toBe(0);
  });

  it("an unknown repo yields the honest empty page rather than a 404 or a fabricated rate", async () => {
    const env = await seeded();
    const summary = await loadProofSummary(env, "nobody/nothing", {
      verifyLedger: async () => ({ ok: true, tipSeq: 0, totalCount: 0, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }),
      loadAnchors: async () => ({ anchors: [] }),
      now: () => CHECKED_AT,
    });
    expect(summary).toMatchObject({ decisionCount: 0, ledger: { state: "empty" }, anchor: { state: "not_yet_anchored" } });
    expect(summary.accuracy).toMatchObject({ state: "insufficient_data", decided: 0 });
    expect(summary.sampleRecords).toEqual([]);
  });

  it("REGRESSION: both routes 404 while the flag is OFF, and serve once it is on", async () => {
    const app = createApp();
    const off = createTestEnv();
    expect((await app.request("/v1/public/repos/o/r/proof", {}, off)).status).toBe(404);
    const badgeOff = await app.request("/v1/public/repos/o/r/proof-badge.svg", {}, off);
    expect(badgeOff.status).toBe(404);
    // Even the 404 renders a real badge — a broken image in a README is worse than an honest neutral one.
    expect(await badgeOff.text()).toContain("unavailable");
    expect(badgeOff.headers.get("content-type")).toContain("image/svg+xml");

    const on = await seeded();
    const proof = await app.request("/v1/public/repos/o/r/proof", {}, on);
    expect(proof.status).toBe(200);
    const body = (await proof.json()) as { repoFullName: string; boundary: string; decisionCount: number };
    expect(body).toMatchObject({ repoFullName: "o/r", decisionCount: 3 });
    expect(body.boundary).toBe(PROOF_BOUNDARY_STATEMENT);
    expect(proof.headers.get("cache-control")).toContain("max-age=60");

    const badge = await app.request("/v1/public/repos/o/r/proof-badge.svg", {}, on);
    expect(badge.status).toBe(200);
    expect(await badge.text()).toContain("<svg");
    expect(badge.headers.get("cache-control")).toContain("stale-while-revalidate=86400");
  });

  it("the anchor state reflects a real recorded anchor attempt end to end", async () => {
    const env = await seeded();
    await recordLedgerAnchorAttempt(env, {
      payload: { v: 1, ledger: "loopover.decision_ledger", seq: 3, rowHash: "a".repeat(64), totalCount: 3, at: CHECKED_AT },
      signature: "sig", keyId: "k1", backend: "rekor", status: "ok", backendRef: { uuid: "u" }, proofR2Key: null,
    });
    const summary = await loadProofSummary(env, "o/r", {
      verifyLedger: async () => ({ ok: true, tipSeq: 3, totalCount: 3, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }),
      loadAnchors: (target) => loadPublicLedgerAnchors(target, {}),
      now: () => CHECKED_AT,
    });
    expect(summary.anchor).toMatchObject({ state: "anchored", backend: "rekor", seq: 3 });
  });

  it("REGRESSION: a repo that opts OUT in its manifest gets 404 from BOTH routes, even with the fleet flag on", async () => {
    // The defect this test exists for: both handlers called isProofPageEnabledForRepo(c.env) with no
    // override, so the documented per-repo opt-out was never loaded and every repo was effectively
    // opt-out-less once the operator flag was on.
    const app = createApp();
    const env = await seeded();
    await upsertRepoFocusManifest(env, "o/r", { publicProof: { enabled: false } } as never);

    expect((await app.request("/v1/public/repos/o/r/proof", {}, env)).status).toBe(404);
    const badge = await app.request("/v1/public/repos/o/r/proof-badge.svg", {}, env);
    expect(badge.status).toBe(404);
    expect(await badge.text()).toContain("unavailable");

    // A DIFFERENT repo in the same fleet is unaffected — the opt-out is per repo, not a kill switch.
    expect((await app.request("/v1/public/repos/other/repo/proof", {}, env)).status).toBe(200);
  });

  it("an explicit manifest opt-IN serves, and so does a repo with no manifest block at all (opt-out default)", async () => {
    const app = createApp();
    const env = await seeded();
    await upsertRepoFocusManifest(env, "o/r", { publicProof: { enabled: true } } as never);
    expect((await app.request("/v1/public/repos/o/r/proof", {}, env)).status).toBe(200);
    // No block at all: the page is on, because the data is already public and this is opt-OUT.
    const bare = await seeded();
    expect((await app.request("/v1/public/repos/o/r/proof", {}, bare)).status).toBe(200);
  });

  it("loadProofPageRepoOverride: absent block, explicit values, and a failing load all resolve honestly", async () => {
    const env = createTestEnv();
    expect(await loadProofPageRepoOverride(env, "o/r", async () => null)).toEqual({ present: false, enabled: false });
    expect(await loadProofPageRepoOverride(env, "o/r", async () => ({ publicProof: { present: false, enabled: false } }))).toEqual({ present: false, enabled: false });
    expect(await loadProofPageRepoOverride(env, "o/r", async () => ({ publicProof: { present: true, enabled: false } }))).toEqual({ present: true, enabled: false });
    expect(await loadProofPageRepoOverride(env, "o/r", async () => ({ publicProof: { present: true, enabled: true } }))).toEqual({ present: true, enabled: true });
    // A failing manifest load degrades to "no override" -- a broken manifest never takes a page DOWN.
    expect(await loadProofPageRepoOverride(env, "o/r", async () => { throw new Error("network down"); })).toEqual({ present: false, enabled: false });
    // REGRESSION: a loader that throws SYNCHRONOUSLY (a driver-level failure before it returns a promise)
    // skips a `.catch()` entirely -- the earlier implementation let that escape to the route and 503 a
    // public page over an optional manifest read.
    const syncThrow = (() => { throw new Error("d1 down"); }) as unknown as Parameters<typeof loadProofPageRepoOverride>[2];
    expect(await loadProofPageRepoOverride(env, "o/r", syncThrow)).toEqual({ present: false, enabled: false });
  });

  it("resolveProofPage: the gate outcomes, and a TOTAL composition that degrades instead of failing", async () => {
    const env = await seeded();
    const deps: ProofPageDeps = {
      loadManifest: async () => null,
      verifyLedger: async () => ({ ok: true, tipSeq: 3, totalCount: 3, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }),
      loadAnchors: async () => ({ anchors: [] }),
      now: () => CHECKED_AT,
    };

    const ok = await resolveProofPage(env, "o/r", deps);
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.summary.decisionCount).toBe(3);

    // Fleet flag off ⇒ disabled.
    expect(await resolveProofPage(createTestEnv(), "o/r", deps)).toEqual({ status: "disabled" });

    // Per-repo opt-out ⇒ disabled even with the fleet flag on.
    expect(
      await resolveProofPage(env, "o/r", { ...deps, loadManifest: async () => ({ publicProof: { present: true, enabled: false } }) }),
    ).toEqual({ status: "disabled" });

    // REGRESSION: the composition is TOTAL. Every dependency failing at once -- manifest, ledger, anchors,
    // and the DB binding itself throwing on property access -- still resolves to a rendered page in its
    // honest neutral states, never a rejected promise. This is what makes an `unavailable` outcome
    // unnecessary rather than merely untested: there is no input that fails the composition.
    const hostile = createTestEnv({ LOOPOVER_PUBLIC_PROOF: "true" });
    Object.defineProperty(hostile, "DB", {
      get() {
        throw new Error("binding unavailable");
      },
    });
    const degraded = await resolveProofPage(hostile, "o/r", {
      loadManifest: async () => { throw new Error("manifest down"); },
      verifyLedger: async () => { throw new Error("ledger down"); },
      loadAnchors: async () => { throw new Error("anchors down"); },
      now: () => CHECKED_AT,
    });
    expect(degraded.status).toBe("ok");
    if (degraded.status !== "ok") return;
    expect(degraded.summary).toMatchObject({
      decisionCount: 0,
      sampleRecords: [],
      ledger: { state: "unavailable", checkedAt: CHECKED_AT },
      anchor: { state: "not_yet_anchored" },
    });
    expect(degraded.summary.accuracy).toMatchObject({ state: "insufficient_data", decided: 0 });
  });

  it("REGRESSION: both surfaces render the SAME resolver outcome, so page and badge cannot disagree", async () => {
    const app = createApp();
    // A repo opted out in its manifest: the page 404s and the badge 404s with a neutral SVG, from one
    // decision. The gate previously lived inline in both bodies and only one honored the opt-out.
    const env = await seeded();
    await upsertRepoFocusManifest(env, "o/r", { publicProof: { enabled: false } } as never);
    expect((await app.request("/v1/public/repos/o/r/proof", {}, env)).status).toBe(404);
    const badge = await app.request("/v1/public/repos/o/r/proof-badge.svg", {}, env);
    expect(badge.status).toBe(404);
    expect(badge.headers.get("content-type")).toContain("image/svg+xml");
    expect(await badge.text()).toContain("unavailable");

    // And with every DB read failing, BOTH still serve 200 over the degraded page rather than erroring.
    const broken = await seeded();
    Object.defineProperty(broken, "DB", {
      get() {
        throw new Error("binding unavailable");
      },
    });
    expect((await app.request("/v1/public/repos/o/r/proof", {}, broken)).status).toBe(200);
    expect((await app.request("/v1/public/repos/o/r/proof-badge.svg", {}, broken)).status).toBe(200);
  });
});

describe("#10012: accuracy is derived from real reversals, and the badge surfaces declared exclusions", () => {
  const okVerify = (over: Partial<{ prunedRecords: number; waivedContentMismatches: number; waivedUnchainedRecords: number }> = {}) =>
    async () => ({ ok: true as const, tipSeq: 25, totalCount: 25, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0, ...over });
  const noAnchors = async () => ({ anchors: [] });

  async function seedDecisions(env: ReturnType<typeof createTestEnv>, count: number): Promise<void> {
    for (let index = 1; index <= count; index += 1) {
      await persistDecisionRecord(
        env,
        {
          schemaVersion: "5", repoFullName: "o/r", pullNumber: index, headSha: `sha${index}`, baseSha: null,
          action: "merge", reasonCode: "clean", configDigest: "c", settingsDigest: "s", gatePack: "oss-anti-slop",
          ciState: "success", modelIds: null, promptDigest: null, aiConfidence: null, aiAgreement: null,
          salvageability: null, divertedByHoldout: false, decidedAt: CHECKED_AT,
        } as never,
        String(index).padStart(64, "0"),
      );
    }
  }

  const reverse = (env: ReturnType<typeof createTestEnv>, pullNumber: number) =>
    recordAuditEvent(env, { eventType: "reversal_reverted", actor: null, targetKey: `o/r#${pullNumber}`, outcome: "completed", detail: "reverted", metadata: { repoFullName: "o/r", pullNumber } });

  it("REGRESSION: the published accuracy is derived from real reversals, not from reason_code — 25 decisions, 2 reversed → 0.92", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_PROOF: "true" });
    await seedDecisions(env, 25);
    await reverse(env, 3);
    await reverse(env, 17);
    const summary = await loadProofSummary(env, "o/r", { verifyLedger: okVerify(), loadAnchors: noAnchors, now: () => CHECKED_AT });
    expect(summary.accuracy).toMatchObject({ state: "published", decided: 25, confirmed: 23, accuracy: 0.92 });
  });

  it("25 decisions with ZERO reversals still publishes accuracy 1 — the perfect case stays expressible", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_PROOF: "true" });
    await seedDecisions(env, 25);
    const summary = await loadProofSummary(env, "o/r", { verifyLedger: okVerify(), loadAnchors: noAnchors, now: () => CHECKED_AT });
    expect(summary.accuracy).toMatchObject({ state: "published", decided: 25, confirmed: 25, accuracy: 1 });
  });

  it("a failing reversal read degrades to insufficient_data, never publishing a fabricated rate", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_PROOF: "true" });
    await seedDecisions(env, 25);
    // Make only the reversal anti-join read throw; the decided/count read and the rest still compose.
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (sql.includes("reversal_reverted")) throw new Error("d1 down");
      return realPrepare(sql);
    }) as never;
    const summary = await loadProofSummary(env, "o/r", { verifyLedger: okVerify(), loadAnchors: noAnchors, now: () => CHECKED_AT });
    expect(summary.accuracy.state).toBe("insufficient_data");
  });

  it("the badge renders 'verified · N excluded' + neutral colour when the ledger carries declared exclusions", () => {
    const summary = { ledger: { state: "verified" as const, tipSeq: 1, totalCount: 1, checkedAt: CHECKED_AT, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 231 }, anchor: { state: "anchored" as const } } as Parameters<typeof buildProofBadgeMessage>[0];
    expect(buildProofBadgeMessage(summary)).toBe("verified · 231 excluded");
    expect(buildProofBadgeColor(summary)).toBe("#9e9e9e");
  });

  it("a clean ledger with zero exclusions keeps today's exact badge strings and colours", () => {
    const anchored = { ledger: { state: "verified" as const, tipSeq: 1, totalCount: 1, checkedAt: CHECKED_AT, prunedRecords: 0, waivedContentMismatches: 0, waivedUnchainedRecords: 0 }, anchor: { state: "anchored" as const } } as Parameters<typeof buildProofBadgeMessage>[0];
    expect(buildProofBadgeMessage(anchored)).toBe("verified · anchored");
    expect(buildProofBadgeColor(anchored)).toBe("#3fb950");
  });
});