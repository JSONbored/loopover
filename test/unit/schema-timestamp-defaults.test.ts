import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client";
import {
  aiReviewCache,
  aiSlopCache,
  linkedIssueSatisfactionCache,
  orbRelayPending,
  repositorySettings,
  upstreamDriftReports,
  webhookEvents,
} from "../../src/db/schema";
import { createTestEnv } from "../helpers/d1";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe("timestamp column defaults", () => {
  it("inserts a real ISO timestamp (not the literal 'CURRENT_TIMESTAMP') when the column is omitted", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    // Omit receivedAt entirely — drizzle must inject a real timestamp via $defaultFn, not the static
    // string "CURRENT_TIMESTAMP" that a `.default("CURRENT_TIMESTAMP")` would have injected client-side.
    await db.insert(webhookEvents).values({ deliveryId: "ts-default-1", eventName: "push", payloadHash: "h", status: "processed" });
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.deliveryId, "ts-default-1")).limit(1);
    expect(row?.receivedAt).not.toBe("CURRENT_TIMESTAMP");
    expect(row?.receivedAt ?? "").toMatch(ISO);
  });

  it("applies the same default to createdAt/updatedAt on omit", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    await db.insert(repositorySettings).values({ repoFullName: "acme/widgets" });
    const [row] = await db.select().from(repositorySettings).where(eq(repositorySettings.repoFullName, "acme/widgets")).limit(1);
    expect(row?.createdAt).toMatch(ISO);
    expect(row?.updatedAt).toMatch(ISO);
    expect(row?.createdAt).not.toBe("CURRENT_TIMESTAMP");
  });

  it("keeps orb relay pending coalesce keys wired through the drizzle schema", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    const coalesceKey = `github-webhook:ci-completed:jsonbored/loopover@${"a".repeat(40)}#1838`;
    await db.insert(orbRelayPending).values({
      deliveryId: "relay-schema-1",
      installationId: 1838,
      eventName: "check_suite",
      rawBody: "{}",
      coalesceKey,
    });

    const [row] = await db
      .select()
      .from(orbRelayPending)
      .where(eq(orbRelayPending.deliveryId, "relay-schema-1"))
      .limit(1);
    expect(row).toMatchObject({
      deliveryId: "relay-schema-1",
      installationId: 1838,
      eventName: "check_suite",
      rawBody: "{}",
      coalesceKey,
    });
    expect(row?.createdAt).toMatch(ISO);
    expect(row?.createdAt).not.toBe("CURRENT_TIMESTAMP");
  });

  it("applies the AI review cache createdAt default on omit", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    await db.insert(aiReviewCache).values({
      repoFullName: "acme/widgets",
      pullNumber: 1,
      headSha: "sha",
      aiReviewMode: "advisory",
      notes: "ok",
      reviewerCount: 1,
    });
    const [row] = await db.select().from(aiReviewCache).where(eq(aiReviewCache.repoFullName, "acme/widgets")).limit(1);
    expect(row?.createdAt).toMatch(ISO);
    expect(row?.createdAt).not.toBe("CURRENT_TIMESTAMP");
  });

  it("applies the AI slop advisory cache createdAt default on omit (#ai-slop-cache)", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    await db.insert(aiSlopCache).values({
      repoFullName: "acme/widgets",
      pullNumber: 2,
      headSha: "sha",
      inputFingerprint: "fp-v1",
      status: "ok",
    });
    const [row] = await db.select().from(aiSlopCache).where(eq(aiSlopCache.repoFullName, "acme/widgets")).limit(1);
    expect(row?.createdAt).toMatch(ISO);
    expect(row?.createdAt).not.toBe("CURRENT_TIMESTAMP");
  });

  it("applies the linked-issue satisfaction cache createdAt default on omit (#1961/#3906)", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    await db.insert(linkedIssueSatisfactionCache).values({
      repoFullName: "acme/widgets",
      pullNumber: 3,
      headSha: "sha",
      linkedIssueNumber: 1275,
      inputFingerprint: "fp-v1",
      status: "ok",
    });
    const [row] = await db.select().from(linkedIssueSatisfactionCache).where(eq(linkedIssueSatisfactionCache.repoFullName, "acme/widgets")).limit(1);
    expect(row?.createdAt).toMatch(ISO);
    expect(row?.createdAt).not.toBe("CURRENT_TIMESTAMP");
  });

  it("applies upstreamDriftReports.updatedAt default on omit (#8369)", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    // Omit updatedAt — the schema $defaultFn must inject a real ISO timestamp (same house rule as every
    // sibling updatedAt). generatedAt stays explicit; this issue only covers the updatedAt gap.
    await db.insert(upstreamDriftReports).values({
      id: "drift-ts-default-1",
      fingerprint: "fp-ts-default-1",
      severity: "low",
      summary: "schema defaultFn regression",
      generatedAt: "2026-07-24T00:00:00.000Z",
    });
    const [row] = await db
      .select()
      .from(upstreamDriftReports)
      .where(eq(upstreamDriftReports.id, "drift-ts-default-1"))
      .limit(1);
    expect(row?.updatedAt).toMatch(ISO);
    expect(row?.updatedAt).not.toBe("CURRENT_TIMESTAMP");
    expect(row?.updatedAt).not.toBe("");
    expect(row?.generatedAt).toBe("2026-07-24T00:00:00.000Z");
  });
});
