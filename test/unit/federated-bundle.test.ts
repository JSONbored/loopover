import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createD1Adapter, nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { getOrCreateAnonSecret, getOrCreateInstanceIdentitySecret, instanceId } from "../../src/selfhost/orb-collector";
import {
  FEDERATED_BUNDLE_SCHEMA_VERSION,
  buildFederatedBundle,
  canonicalizeFederatedBundleBody,
  getOrCreateFederatedSigningSecret,
  isFederatedIntelligenceEnabled,
  signFederatedBundle,
  type FederatedSignalBundle,
} from "../../src/orb/federated-bundle";
import type { FocusManifest } from "../../src/signals/focus-manifest";

/** In-memory DB with the review_audit + system_flags tables the bundle builder reads. Mirrors
 *  selfhost-orb-collector.test.ts's makeDb (same source tables, minus the export cursor this path never uses). */
function makeDb(): D1Database {
  const driver = nodeSqliteDriver(new DatabaseSync(":memory:") as never);
  driver.exec(`
    CREATE TABLE review_audit (
      id TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, target_id TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'gate_decision', decision TEXT,
      source TEXT NOT NULL DEFAULT 'gittensory-native', head_sha TEXT, summary TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE system_flags (
      key TEXT PRIMARY KEY, value TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  return createD1Adapter(driver);
}

let seq = 0;
async function audit(
  db: D1Database,
  pr: number,
  eventType: string,
  decision: string | null,
  at: string,
  summary: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, summary, created_at) VALUES (?, ?, ?, ?, ?, 'gittensory-native', ?, ?)`,
    )
    .bind(`r${seq++}`, "owner/repo", `owner/repo#${pr}`, eventType, decision, summary, at)
    .run();
}

/** One fully-resolved PR: a gate decision plus its realized human outcome (optionally reversed). */
async function resolved(
  db: D1Database,
  pr: number,
  o: {
    verdict?: string;
    outcome?: string;
    decidedAt?: string;
    outcomeAt?: string;
    summary?: string | null;
    reversal?: "reversal_reverted" | "reversal_reopened";
  } = {},
): Promise<void> {
  await audit(db, pr, "gate_decision", o.verdict ?? "merge", o.decidedAt ?? "2026-07-10T10:00:00Z", o.summary ?? null);
  await audit(db, pr, "pr_outcome", o.outcome ?? "merged", o.outcomeAt ?? "2026-07-10T12:00:00Z");
  if (o.reversal) await audit(db, pr, o.reversal, null, "2026-07-10T13:00:00Z");
}

/** A manifest carrying only the block the builder reads. */
function manifest(enabled: boolean | undefined): Pick<FocusManifest, "federatedIntelligence"> {
  return {
    federatedIntelligence: {
      present: enabled !== undefined,
      enabled: enabled ?? false,
      // The EXPORT never reads peerKeys — that allowlist gates the import side (#6480) only.
      peerKeys: [],
      collectorUrl: null,
      collectorMode: null,
    },
  };
}

/** A db that fails the test if it is touched at all — proves the opted-out path reads nothing. */
function untouchableDb(): D1Database {
  return new Proxy({} as D1Database, {
    get() {
      throw new Error("opted-out build must not touch the database");
    },
  });
}

const NOW = Date.parse("2026-07-16T00:00:00Z");

describe("isFederatedIntelligenceEnabled()", () => {
  it("is false for a null/undefined manifest, an absent block, and an explicit false", () => {
    expect(isFederatedIntelligenceEnabled(null)).toBe(false);
    expect(isFederatedIntelligenceEnabled(undefined)).toBe(false);
    expect(isFederatedIntelligenceEnabled({} as Pick<FocusManifest, "federatedIntelligence">)).toBe(false);
    expect(isFederatedIntelligenceEnabled(manifest(false))).toBe(false);
  });

  it("is true only for an explicit enabled: true", () => {
    expect(isFederatedIntelligenceEnabled(manifest(true))).toBe(true);
  });
});

describe("buildFederatedBundle() — opted out (the default posture)", () => {
  it("returns null and touches neither the database nor the network when the block is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await buildFederatedBundle(manifest(undefined), untouchableDb())).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns null for an explicit enabled: false", async () => {
    expect(await buildFederatedBundle(manifest(false), untouchableDb())).toBeNull();
  });

  it("returns null for a null manifest (no manifest loaded at all)", async () => {
    expect(await buildFederatedBundle(null, untouchableDb())).toBeNull();
  });
});

describe("buildFederatedBundle() — opted in", () => {
  it("builds a fully-populated, correctly-signed bundle and still makes no network call", async () => {
    const db = makeDb();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // 5 decided PRs = MIN_DECIDED: 3 confirmed merges, 1 reverted merge (a false positive), 1 confirmed close.
    await resolved(db, 1);
    await resolved(db, 2);
    await resolved(db, 3, { summary: "ai_slop_advisory" });
    await resolved(db, 4, { reversal: "reversal_reverted" });
    await resolved(db, 5, { verdict: "close", outcome: "closed", summary: "duplicate_pr_risk" });

    const bundle = await buildFederatedBundle(manifest(true), db, { now: NOW });
    expect(bundle).not.toBeNull();
    const b = bundle as FederatedSignalBundle;

    expect(b.schemaVersion).toBe(FEDERATED_BUNDLE_SCHEMA_VERSION);
    expect(b.windowDays).toBe(90);
    expect(b.generatedAt).toBe("2026-07-16T00:00:00.000Z");
    expect(b.decided).toBe(5);
    // 4 merge verdicts, 3 confirmed (the reverted one is a false positive) → 0.75.
    expect(b.mergePrecision).toBeCloseTo(0.75);
    expect(b.fpRate).toBeCloseTo(0.25);
    // 1 close verdict, confirmed closed → 1.0.
    expect(b.closePrecision).toBe(1);
    expect(b.fnRate).toBe(0);
    expect(b.reversalRate).toBeCloseTo(0.2); // 1 of 5 reversed
    expect(b.slopRate).toBeCloseTo(0.2); // 1 of 5 bucketed slop_advisory
    expect(b.copycatRate).toBeCloseTo(0.2); // 1 of 5 bucketed duplicate_risk
    expect(b.cycleP50Ms).toBe(7_200_000); // 2h decision → outcome
    expect(b.cycleP95Ms).toBe(7_200_000);

    // The opaque handle is the orb pipeline's, not a second identity — but (#9147) derived from the DEDICATED
    // identity secret, not the anon secret.
    expect(b.instanceId).toBe(instanceId(await getOrCreateInstanceIdentitySecret(db)));

    // Independently recompute the HMAC over the canonical body — the signature must verify against the
    // DEDICATED federated signing secret (#9147), never the anon secret.
    const { signature, ...body } = b;
    const signingSecret = await getOrCreateFederatedSigningSecret(db);
    expect(signature).toBe(createHmac("sha256", signingSecret).update(canonicalizeFederatedBundleBody(body)).digest("hex"));
    expect(signature).toMatch(/^[0-9a-f]{64}$/);

    // The export path itself never talks to anyone — transport is #6479.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("carries only the enumerated anonymized fields — adding one must fail this test on purpose", async () => {
    const db = makeDb();
    await resolved(db, 1);
    const b = (await buildFederatedBundle(manifest(true), db, { now: NOW })) as FederatedSignalBundle;
    expect(Object.keys(b).sort()).toEqual(
      [
        "closePrecision",
        "copycatRate",
        "cycleP50Ms",
        "cycleP95Ms",
        "decided",
        "fnRate",
        "fpRate",
        "generatedAt",
        "instanceId",
        "mergePrecision",
        "reversalRate",
        "schemaVersion",
        "signature",
        "slopRate",
        "windowDays",
      ].sort(),
    );
  });

  it("leaks no identifier: no repo name, PR id, login, or raw gate reason reaches the bundle", async () => {
    const db = makeDb();
    await resolved(db, 1, { summary: "duplicate_pr_risk against owner/repo#99 by octocat" });
    const b = (await buildFederatedBundle(manifest(true), db, { now: NOW })) as FederatedSignalBundle;
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/owner\/repo/);
    expect(text).not.toMatch(/octocat/);
    expect(text).not.toMatch(/duplicate_pr_risk/); // the raw reason is bucketed, never carried
    expect(text).not.toMatch(/target_id|project|repo_hash|pr_hash/);
  });

  it("counts a reopened close as a reversal and a false negative", async () => {
    const db = makeDb();
    await resolved(db, 1, { verdict: "close", outcome: "closed", reversal: "reversal_reopened" });
    const b = (await buildFederatedBundle(manifest(true), db, { now: NOW })) as FederatedSignalBundle;
    expect(b.reversalRate).toBe(1);
    expect(b.decided).toBe(1);
  });
});

describe("buildFederatedBundle() — the MIN_DECIDED eligibility bar", () => {
  it("publishes null precision/cycle below MIN_DECIDED, while still reporting the defined rates", async () => {
    const db = makeDb();
    await resolved(db, 1);
    await resolved(db, 2, { reversal: "reversal_reverted", summary: "ai_slop_advisory" });
    const b = (await buildFederatedBundle(manifest(true), db, { now: NOW })) as FederatedSignalBundle;

    expect(b.decided).toBe(2); // below MIN_DECIDED (5)
    expect(b.mergePrecision).toBeNull();
    expect(b.closePrecision).toBeNull();
    expect(b.fpRate).toBeNull();
    expect(b.fnRate).toBeNull();
    expect(b.cycleP50Ms).toBeNull();
    expect(b.cycleP95Ms).toBeNull();
    // Rates are still defined — they do not claim a precision the fleet would refuse to count.
    expect(b.reversalRate).toBeCloseTo(0.5);
    expect(b.slopRate).toBeCloseTo(0.5);
    expect(b.copycatRate).toBe(0);
  });

  it("an opted-in instance with no resolved PRs yields a signed, all-null-metric bundle rather than nothing", async () => {
    const db = makeDb();
    const b = (await buildFederatedBundle(manifest(true), db, { now: NOW })) as FederatedSignalBundle;
    expect(b).not.toBeNull();
    expect(b.decided).toBe(0);
    expect(b.mergePrecision).toBeNull();
    expect(b.reversalRate).toBe(0); // not NaN
    expect(b.slopRate).toBe(0);
    expect(b.copycatRate).toBe(0);
    expect(b.cycleP50Ms).toBeNull();
    expect(b.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("excludes PRs resolved outside the window", async () => {
    const db = makeDb();
    await resolved(db, 1, { decidedAt: "2020-01-01T10:00:00Z", outcomeAt: "2020-01-01T12:00:00Z" });
    const b = (await buildFederatedBundle(manifest(true), db, { now: NOW })) as FederatedSignalBundle;
    expect(b.decided).toBe(0);
  });
});

describe("buildFederatedBundle() — window resolution (mirrors computeFleetAnalytics)", () => {
  it("defaults to 90 days, honors a valid window, clamps at 365, and rejects a non-positive one", async () => {
    const db = makeDb();
    // exactOptionalPropertyTypes: an omitted window must be genuinely absent, not `windowDays: undefined`.
    const w = async (windowDays?: number): Promise<number> =>
      (
        (await buildFederatedBundle(
          manifest(true),
          db,
          windowDays === undefined ? { now: NOW } : { windowDays, now: NOW },
        )) as FederatedSignalBundle
      ).windowDays;
    expect(await w(undefined)).toBe(90);
    expect(await w(30)).toBe(30);
    expect(await w(9999)).toBe(365);
    expect(await w(0)).toBe(90);
    expect(await w(-5)).toBe(90);
  });

  it("defaults generatedAt to the current clock when no now is injected", async () => {
    const db = makeDb();
    const before = Date.now();
    const b = (await buildFederatedBundle(manifest(true), db)) as FederatedSignalBundle;
    expect(Date.parse(b.generatedAt)).toBeGreaterThanOrEqual(before);
  });
});

describe("buildFederatedBundle() — fail-safe", () => {
  it("returns null instead of throwing when the database read fails, so the gate is never affected", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenDb = {
      prepare() {
        throw new Error("d1 exploded");
      },
    } as unknown as D1Database;
    await expect(buildFederatedBundle(manifest(true), brokenDb)).resolves.toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("treats a driver returning no result rows as an empty window rather than crashing", async () => {
    const db = makeDb();
    const secret = await getOrCreateAnonSecret(db);
    const noRowsDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () => ({ value: secret }),
          all: async () => ({ results: undefined }),
          run: async () => ({}),
        }),
        first: async () => ({ value: secret }),
        all: async () => ({ results: undefined }),
      }),
    } as unknown as D1Database;
    const b = (await buildFederatedBundle(manifest(true), noRowsDb, { now: NOW })) as FederatedSignalBundle;
    expect(b.decided).toBe(0);
  });
});

describe("#9147: federated signing key / anon secret separation", () => {
  it("mints a federated signing secret that is never the same value as the anon secret", async () => {
    const db = makeDb();
    const anonSecret = await getOrCreateAnonSecret(db);
    const signingSecret = await getOrCreateFederatedSigningSecret(db);
    expect(signingSecret).not.toBe(anonSecret);
    expect(signingSecret).toMatch(/^[0-9a-f]{64}$/);
    // Stable across repeated reads, exactly like getOrCreateAnonSecret.
    expect(await getOrCreateFederatedSigningSecret(db)).toBe(signingSecret);
  });

  it("keeps instanceId stable when the anon secret is rotated after the identity secret already exists", async () => {
    const db = makeDb();
    await resolved(db, 1);
    const before = (await buildFederatedBundle(manifest(true), db, { now: NOW })) as FederatedSignalBundle;

    // Simulate an operator rotating the anonymization secret (e.g. after a suspected leak) — this must never
    // change the instance's federated identity, since that would break the receiver's per-instance dedup.
    await db.prepare("UPDATE system_flags SET value = ? WHERE key = 'orb:anon_secret'").bind("f".repeat(64)).run();
    expect(await getOrCreateAnonSecret(db)).toBe("f".repeat(64));

    const after = (await buildFederatedBundle(manifest(true), db, { now: NOW })) as FederatedSignalBundle;
    expect(after.instanceId).toBe(before.instanceId);
  });

  it("seeds the identity secret from the CURRENT anon secret on first use (no disruptive instanceId change on upgrade)", async () => {
    const db = makeDb();
    const anonSecret = await getOrCreateAnonSecret(db);
    // No identity-secret row exists yet — getOrCreateInstanceIdentitySecret must seed from the anon secret so
    // an instance upgrading from before #9147 keeps its existing instanceId.
    expect(await getOrCreateInstanceIdentitySecret(db)).toBe(anonSecret);
  });
});

describe("canonicalizeFederatedBundleBody() / signFederatedBundle()", () => {
  it("is insensitive to key insertion order, so a receiver can recompute the HMAC byte-for-byte", async () => {
    const db = makeDb();
    await resolved(db, 1);
    const { signature: _sig, ...body } = (await buildFederatedBundle(manifest(true), db, {
      now: NOW,
    })) as FederatedSignalBundle;

    // Same values, deliberately rebuilt in reverse key order.
    const shuffled = Object.fromEntries(Object.entries(body).reverse()) as typeof body;
    expect(canonicalizeFederatedBundleBody(shuffled)).toBe(canonicalizeFederatedBundleBody(body));
    expect(signFederatedBundle(shuffled, "k")).toBe(signFederatedBundle(body, "k"));
  });

  it("changes the signature when any signed field changes (tamper-evidence)", async () => {
    const db = makeDb();
    await resolved(db, 1);
    const { signature: _sig, ...body } = (await buildFederatedBundle(manifest(true), db, {
      now: NOW,
    })) as FederatedSignalBundle;
    expect(signFederatedBundle({ ...body, decided: body.decided + 1 }, "k")).not.toBe(signFederatedBundle(body, "k"));
    expect(signFederatedBundle(body, "other-key")).not.toBe(signFederatedBundle(body, "k"));
  });
});
