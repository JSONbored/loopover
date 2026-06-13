import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/db/client";
import { repositorySettings, webhookEvents } from "../../src/db/schema";
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
});
