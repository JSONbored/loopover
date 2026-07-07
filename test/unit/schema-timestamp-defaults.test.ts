import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client";
import { aiReviewCache, aiSlopCache, orbRelayPending, repositorySettings, webhookEvents } from "../../src/db/schema";
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
    // #gate-review-2727: the raw SQLite column-level DEFAULT for linked_issue_gate_mode is still 'block'
    // (migration 0023 added it that way, and SQLite has no ALTER COLUMN SET DEFAULT to fix it without a full
    // table rebuild -- see migrations/0102_fix_linked_issue_gate_mode_default.sql's header comment). This
    // pins that the raw default never actually fires: Drizzle's schema.ts `.default("advisory")` is injected
    // client-side into the generated INSERT whenever the field is omitted, same as createdAt/updatedAt above.
    expect(row?.linkedIssueGateMode).toBe("advisory");
  });

  it("keeps orb relay pending coalesce keys wired through the drizzle schema", async () => {
    const env = createTestEnv();
    const db = getDb(env.DB);
    const coalesceKey = `github-webhook:ci-completed:jsonbored/gittensory@${"a".repeat(40)}#1838`;
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
});
