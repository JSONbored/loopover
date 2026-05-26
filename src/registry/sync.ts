import { and, desc, eq, notInArray } from "drizzle-orm";
import { getDb } from "../db/client";
import { registrySnapshots, repositories, syncRuns } from "../db/schema";
import type { RegistrySnapshot } from "../types";
import { errorMessage, jsonString, nowIso, repoParts } from "../utils/json";
import { normalizeRegistryPayload } from "./normalize";

const API_CANDIDATES = [
  "https://api.gittensor.io/repositories",
  "https://api.gittensor.io/api/repositories",
  "https://api.gittensor.io/api/v1/repositories",
  "https://api.gittensor.io/api/v1/master-repositories",
  "https://mirror.gittensor.io/api/v1/repositories",
  "https://mirror.gittensor.io/api/v1/master-repositories",
];

export async function refreshRegistry(env: Env): Promise<RegistrySnapshot> {
  const db = getDb(env.DB);
  const startedAt = nowIso();
  const syncId = crypto.randomUUID();
  await db.insert(syncRuns).values({
    id: syncId,
    jobType: "refresh-registry",
    status: "running",
    startedAt,
  });

  const warnings: string[] = [];
  try {
    const fallbackUrl = env.GITTENSOR_REGISTRY_URL;
    const candidates = [...API_CANDIDATES, fallbackUrl];
    for (const url of candidates) {
      const sourceKind = url === fallbackUrl ? "raw-github" : "api";
      try {
        const response = await fetch(url, {
          headers: {
            accept: "application/json",
            "user-agent": "gittensory/0.1",
          },
        });
        if (!response.ok) {
          warnings.push(`Registry probe failed: ${url} (${response.status})`);
          continue;
        }
        const payload = await response.json();
        const fetchedAt = nowIso();
        const snapshot = normalizeRegistryPayload(payload, { kind: sourceKind, url }, fetchedAt);
        snapshot.warnings.push(...warnings);
        await persistRegistrySnapshot(env, snapshot);
        await db
          .update(syncRuns)
          .set({
            status: "success",
            sourceKind,
            sourceUrl: url,
            warningsJson: jsonString(snapshot.warnings),
            completedAt: nowIso(),
          })
          .where(eq(syncRuns.id, syncId));
        return snapshot;
      } catch (error) {
        warnings.push(`Registry probe failed: ${url} (${errorMessage(error)})`);
      }
    }
    throw new Error("No registry source returned usable data.");
  } catch (error) {
    await db
      .update(syncRuns)
      .set({
        status: "error",
        warningsJson: jsonString(warnings),
        errorSummary: errorMessage(error),
        completedAt: nowIso(),
      })
      .where(eq(syncRuns.id, syncId));
    throw error;
  }
}

export async function persistRegistrySnapshot(env: Env, snapshot: RegistrySnapshot): Promise<void> {
  const db = getDb(env.DB);
  await db.insert(registrySnapshots).values({
    id: snapshot.id,
    sourceKind: snapshot.source.kind,
    sourceUrl: snapshot.source.url,
    generatedAt: snapshot.generatedAt,
    fetchedAt: snapshot.fetchedAt,
    repoCount: snapshot.repoCount,
    totalEmissionShare: snapshot.totalEmissionShare,
    warningsJson: jsonString(snapshot.warnings),
    payloadJson: jsonString(snapshot as unknown as Record<string, unknown>),
  });

  for (const repo of snapshot.repositories) {
    const parts = repoParts(repo.repo);
    await db
      .insert(repositories)
      .values({
        fullName: repo.repo,
        owner: parts.owner,
        name: parts.name,
        isRegistered: true,
        registryConfigJson: jsonString(repo as unknown as Record<string, unknown>),
        emissionShare: repo.emissionShare,
        issueDiscoveryShare: repo.issueDiscoveryShare,
        maintainerCut: repo.maintainerCut,
        labelMultipliersJson: jsonString(repo.labelMultipliers),
        lastRegistrySnapshotId: snapshot.id,
        updatedAt: nowIso(),
      })
      .onConflictDoUpdate({
        target: repositories.fullName,
        set: {
          isRegistered: true,
          registryConfigJson: jsonString(repo as unknown as Record<string, unknown>),
          emissionShare: repo.emissionShare,
          issueDiscoveryShare: repo.issueDiscoveryShare,
          maintainerCut: repo.maintainerCut,
          labelMultipliersJson: jsonString(repo.labelMultipliers),
          lastRegistrySnapshotId: snapshot.id,
          updatedAt: nowIso(),
        },
      });
  }

  const registeredFullNames = snapshot.repositories.map((repo) => repo.repo);
  if (registeredFullNames.length > 0) {
    await db
      .update(repositories)
      .set({
        isRegistered: false,
        registryConfigJson: null,
        emissionShare: null,
        issueDiscoveryShare: null,
        maintainerCut: 0,
        labelMultipliersJson: "{}",
        updatedAt: nowIso(),
      })
      .where(and(eq(repositories.isRegistered, true), notInArray(repositories.fullName, registeredFullNames)));
  }
}

export async function getLatestRegistrySnapshot(env: Env): Promise<RegistrySnapshot | null> {
  const db = getDb(env.DB);
  const [row] = await db.select().from(registrySnapshots).orderBy(desc(registrySnapshots.fetchedAt)).limit(1);
  if (!row) return null;
  return JSON.parse(row.payloadJson) as RegistrySnapshot;
}

export async function listLatestRegistrySnapshots(env: Env, limit = 2): Promise<RegistrySnapshot[]> {
  const db = getDb(env.DB);
  const rows = await db.select().from(registrySnapshots).orderBy(desc(registrySnapshots.fetchedAt)).limit(limit);
  return rows.map((row) => JSON.parse(row.payloadJson) as RegistrySnapshot);
}
