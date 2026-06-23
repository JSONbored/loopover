import { afterEach, describe, expect, it, vi } from "vitest";
import { persistSignalSnapshot } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import * as issueQualityModule from "../../src/services/issue-quality";
import * as repoOutcomeModule from "../../src/services/repo-outcome-patterns";
import * as focusManifestModule from "../../src/signals/focus-manifest-loader";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { loadDecisionPackSharedInputs } from "../../src/services/decision-pack";
import { createTestEnv } from "../helpers/d1";
import type { RepositoryRecord } from "../../src/types";

// `Env` is the ambient Cloudflare Workers global (worker-configuration.d.ts), referenced unqualified.

const REPO_A = "owner/alpha";
const REPO_B = "owner/beta";

function registeredRepo(fullName: string): RepositoryRecord {
  const [owner = "owner", name = fullName] = fullName.split("/");
  return { fullName, owner, name, isInstalled: true, isRegistered: true, isPrivate: false, defaultBranch: "main" };
}

async function seedRepoSignals(env: Env, fullName: string): Promise<void> {
  await persistSignalSnapshot(env, {
    id: `iq-${fullName}`,
    signalType: "issue-quality",
    targetKey: fullName,
    repoFullName: fullName,
    generatedAt: "2026-06-01T00:00:00.000Z",
    payload: { repoFullName: fullName, generatedAt: "2026-06-01T00:00:00.000Z", lane: { lane: "direct_pr" }, issues: [], summary: "seed" },
  });
  await persistSignalSnapshot(env, {
    id: `rop-${fullName}`,
    signalType: "repo-outcome-patterns",
    targetKey: fullName,
    repoFullName: fullName,
    generatedAt: "2026-06-01T00:00:00.000Z",
    payload: { repoFullName: fullName, generatedAt: "2026-06-01T00:00:00.000Z", totals: {}, evidenceCompleteness: { status: "complete" } },
  });
  // Default source "api_record" → the manifest cache read returns offline (no age check, no network fetch).
  await upsertRepoFocusManifest(env, fullName, { source: "api_record" });
}

describe("decision-pack shared inputs — login-independent maps hoisted out of the per-login build", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("derives the three login-independent maps exactly once and carries them in the shared struct", async () => {
    // No real network: the only outbound dependency (upstream scoring constants) degrades to defaults on 404.
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    const env = createTestEnv();
    await seedRepoSignals(env, REPO_A);
    await seedRepoSignals(env, REPO_B);
    vi.spyOn(repositoriesModule, "listRepositories").mockResolvedValue([registeredRepo(REPO_A), registeredRepo(REPO_B)]);

    // Spies keep the real implementation — we only count invocations.
    const issueQualitySpy = vi.spyOn(issueQualityModule, "loadIssueQualityReportMap");
    const outcomeSpy = vi.spyOn(repoOutcomeModule, "loadRepoOutcomePatternsMap");
    const manifestSpy = vi.spyOn(focusManifestModule, "loadRepoFocusManifests");

    const shared = await loadDecisionPackSharedInputs(env);

    // The batch loads `shared` ONCE and reuses it across every contributor, so each of these heavy
    // (DB-fanning / network-fetching) loaders must run exactly once per batch — not once per login.
    expect(issueQualitySpy).toHaveBeenCalledTimes(1);
    expect(outcomeSpy).toHaveBeenCalledTimes(1);
    expect(manifestSpy).toHaveBeenCalledTimes(1);

    // ...and the derived maps are actually present on the shared struct for the per-login build to read.
    expect(shared.issueQualityByRepo.has(REPO_A)).toBe(true);
    expect(shared.issueQualityByRepo.has(REPO_B)).toBe(true);
    expect(shared.repoOutcomePatternsByRepo.has(REPO_A)).toBe(true);
    expect(shared.repoOutcomePatternsByRepo.has(REPO_B)).toBe(true);
    expect(shared.focusManifests.size).toBe(2);
  });
});
