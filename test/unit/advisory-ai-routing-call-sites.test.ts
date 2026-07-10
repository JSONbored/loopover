// Regression coverage for the #4364 AI_ADVISORY per-capability routing at its real call sites (as opposed to
// advisory-ai-routing-config.test.ts, which only covers the pure yml normalizer, and selfhost-ai.test.ts,
// which only covers withAdvisoryAiEnv in isolation). Each test proves the FULL wire from
// settings.advisoryAiRouting through to which env.AI vs env.AI_ADVISORY binding actually gets called.
import { describe, expect, it, vi } from "vitest";
import { runAiSlopForAdvisory } from "../../src/queue/processors";
import { createTestEnv } from "../helpers/d1";
import type { PullRequestFileRecord, RepositorySettings } from "../../src/types";
import type { buildPullRequestAdvisory } from "../../src/rules/advisory";

type Advisory = Awaited<ReturnType<typeof buildPullRequestAdvisory>>;

function settingsFixture(advisoryAiRouting?: RepositorySettings["advisoryAiRouting"]): RepositorySettings {
  return {
    aiReviewByok: false,
    aiReviewProvider: null,
    advisoryAiRouting,
  } as unknown as RepositorySettings;
}

describe("runAiSlopForAdvisory routes through AI_ADVISORY (#4364)", () => {
  const frontierRun = vi.fn(async () => ({ response: JSON.stringify({ band: "clean", rationale: "ok" }) }));
  const advisoryRun = vi.fn(async () => ({ response: JSON.stringify({ band: "clean", rationale: "ok" }) }));
  const files: PullRequestFileRecord[] = [];
  const advisory = { headSha: "abc123def456", findings: [] } as unknown as Advisory;

  it("calls env.AI_ADVISORY, not the shared frontier env.AI, when settings.advisoryAiRouting.slop is true and the binding is configured", async () => {
    frontierRun.mockClear();
    advisoryRun.mockClear();
    const env = createTestEnv({
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI: { run: frontierRun } as unknown as Ai,
      AI_ADVISORY: { run: advisoryRun } as unknown as Ai,
    });
    await runAiSlopForAdvisory(env, {
      mode: "live",
      settings: settingsFixture({ slop: true, e2eTestGen: false, planner: false, summaries: false }),
      advisory,
      repoFullName: "owner/repo",
      pr: { number: 1, title: "t" },
      author: "alice",
      files,
      deterministicBand: "clean",
      confirmedContributor: true,
      commitThresholdReached: false,
    });
    expect(advisoryRun).toHaveBeenCalled();
    expect(frontierRun).not.toHaveBeenCalled();
  });

  it("calls the shared frontier env.AI (not AI_ADVISORY) when settings.advisoryAiRouting.slop is false/unset", async () => {
    frontierRun.mockClear();
    advisoryRun.mockClear();
    const env = createTestEnv({
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI: { run: frontierRun } as unknown as Ai,
      AI_ADVISORY: { run: advisoryRun } as unknown as Ai,
    });
    await runAiSlopForAdvisory(env, {
      mode: "live",
      settings: settingsFixture(undefined),
      advisory,
      repoFullName: "owner/repo",
      pr: { number: 2, title: "t" },
      author: "alice",
      files,
      deterministicBand: "clean",
      confirmedContributor: true,
      commitThresholdReached: false,
    });
    expect(frontierRun).toHaveBeenCalled();
    expect(advisoryRun).not.toHaveBeenCalled();
  });

  it("calls the shared frontier env.AI when slop is true but AI_ADVISORY is unconfigured (fail-safe fallback)", async () => {
    frontierRun.mockClear();
    advisoryRun.mockClear();
    const env = createTestEnv({ AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true", AI: { run: frontierRun } as unknown as Ai });
    await runAiSlopForAdvisory(env, {
      mode: "live",
      settings: settingsFixture({ slop: true, e2eTestGen: false, planner: false, summaries: false }),
      advisory,
      repoFullName: "owner/repo",
      pr: { number: 3, title: "t" },
      author: "alice",
      files,
      deterministicBand: "clean",
      confirmedContributor: true,
      commitThresholdReached: false,
    });
    expect(frontierRun).toHaveBeenCalled();
    expect(advisoryRun).not.toHaveBeenCalled();
  });
});
