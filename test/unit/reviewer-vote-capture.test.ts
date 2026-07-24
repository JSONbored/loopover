import { describe, expect, it, vi } from "vitest";
import { runAiReviewForAdvisory } from "../../src/queue/processors";
import * as repositories from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";
import type { Advisory, RepositorySettings } from "../../src/types";

// #8229 stage 0: the persistence half of reviewer-vote capture. The runner-side attribution invariants
// (leg-production-time attachment, swap immunity, advisory-only emptiness) live in ai-review.test.ts;
// this file pins that an ok block-mode review writes ONE reviewer_vote audit row per reviewer with the
// provider identity as actor and the stance in metadata — and that a vote-store failure never touches
// the review result (best-effort, like every calibration write).

const REPO = "acme/widgets";

function reviewJson(present: boolean): string {
  return JSON.stringify({
    assessment: present ? "Likely defect." : "Looks fine.",
    blockers: present ? ["Race condition in src/x.ts: unguarded shared write."] : [],
    nits: [],
    suggestions: [],
    confidence: present ? 0.96 : 0.7,
  });
}

function advisory(number: number): Advisory {
  return {
    id: `adv-${number}`,
    targetType: "pull_request",
    targetKey: `${REPO}#${number}`,
    repoFullName: REPO,
    pullNumber: number,
    headSha: `sha${number}`,
    conclusion: "neutral",
    severity: "info",
    title: "LoopOver advisory available",
    summary: "ok",
    findings: [],
    generatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function voteEnv(seen: string[]): Env {
  return createTestEnv({
    AI_SUMMARIES_ENABLED: "true",
    AI_PUBLIC_COMMENTS_ENABLED: "true",
    AI_DAILY_NEURON_BUDGET: "1000000",
    AI: {
      run: vi.fn(async (model: string) => {
        if (!seen.includes(model)) seen.push(model);
        // Second DISTINCT model flags; the first stays clean — a split with distinct stances.
        return { response: reviewJson(seen.indexOf(model) === 1) };
      }),
    } as unknown as Ai,
  });
}

describe("reviewer-vote capture persistence (#8229 stage 0)", () => {
  it("persists one reviewer_vote audit row per reviewer: provider as actor, stance in metadata", async () => {
    const seen: string[] = [];
    const env = voteEnv(seen);
    await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      repoFullName: REPO,
      pr: { number: 7, title: "Add helper", body: "Adds a helper." },
      author: "alice",
      confirmedContributor: true,
      advisory: advisory(7),
    });

    const rows = await env.DB.prepare("SELECT actor, metadata_json FROM audit_events WHERE event_type = 'reviewer_vote' AND target_key = ?")
      .bind(`${REPO}#7`)
      .all<{ actor: string; metadata_json: string }>();
    const votes = (rows.results ?? [])
      .map((row) => ({ actor: row.actor, vote: (JSON.parse(row.metadata_json) as { vote: string }).vote }))
      .sort((a, b) => a.actor.localeCompare(b.actor));
    expect(votes).toHaveLength(2);
    // Exactly the two REVIEWER models (the disagreement tie-break judge may add later calls with other
    // model ids — judges never vote), each with ITS OWN stance.
    expect(new Set(votes.map((v) => v.actor))).toEqual(new Set(seen.slice(0, 2)));
    const byActor = Object.fromEntries(votes.map((v) => [v.actor, v.vote]));
    expect(byActor[seen[0]!]).toBe("non_fail");
    expect(byActor[seen[1]!]).toBe("fail");
  });

  it("a rejecting vote write is swallowed: the review outcome is untouched (best-effort discipline)", async () => {
    const seen: string[] = [];
    const env = voteEnv(seen);
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValue(new Error("vote store down"));
    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      repoFullName: REPO,
      pr: { number: 8, title: "Add helper", body: "Adds a helper." },
      author: "alice",
      confirmedContributor: true,
      advisory: advisory(8),
    });
    expect(result).toBeDefined(); // the review completed despite every vote write rejecting
    vi.restoreAllMocks();
  });
});

describe("routing shadow orchestration hook (#8229 stage 1)", () => {
  it("a dual ok review invokes the shadow (recording nothing on a sparse corpus); the review outcome is untouched", async () => {
    const seen: string[] = [];
    const env = voteEnv(seen);
    const result = await runAiReviewForAdvisory(env, {
      mode: "live",
      settings: { aiReviewMode: "block" } as RepositorySettings,
      repoFullName: REPO,
      pr: { number: 21, title: "Add helper", body: "Adds a helper." },
      author: "alice",
      confirmedContributor: true,
      advisory: advisory(21),
    });
    expect(result).toBeDefined();
    // Sparse corpus ⇒ the shadow's no-signal arm: zero reviewer_routing_shadow rows, by design.
    const shadows = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'reviewer_routing_shadow'").first<{ n: number }>();
    expect(shadows?.n).toBe(0);
    // The votes themselves persisted — the hook runs strictly after and independently of them.
    const votes = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'reviewer_vote' AND target_key = ?").bind(`${REPO}#21`).first<{ n: number }>();
    expect(votes?.n).toBe(2);
  });
});
