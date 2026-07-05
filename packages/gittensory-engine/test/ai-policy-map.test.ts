import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyAiPolicyFatigueToRankInput,
  createAiPolicyFatigueCacheEntry,
  describeAiPolicyFatigueCache,
  renderAiPolicyFatigueMarkdown,
  resolveAiPolicyFatigueVerdict,
  resolveAiPolicyVerdict,
  scanAiPolicyText,
} from "../dist/index.js";

const NOW = "2026-07-05T00:00:00.000Z";

function aiPr(overrides = {}) {
  return {
    id: "pr-ai",
    state: "closed",
    authorLogin: "dependabot-ai",
    title: "AI-assisted fix for flaky tests",
    labels: ["ai-generated"],
    createdAt: "2026-07-01T00:00:00Z",
    closedAt: "2026-07-02T00:00:00Z",
    reviewDecision: "changes_requested",
    closeReason: "not_planned",
    maintainerResponse: "terse_rejection",
    ...overrides,
  };
}

test("barrel: exports AI policy fatigue APIs (#3009)", () => {
  assert.equal(typeof scanAiPolicyText, "function");
  assert.equal(typeof resolveAiPolicyVerdict, "function");
  assert.equal(typeof resolveAiPolicyFatigueVerdict, "function");
  assert.equal(typeof renderAiPolicyFatigueMarkdown, "function");
  assert.equal(typeof applyAiPolicyFatigueToRankInput, "function");
  assert.equal(typeof createAiPolicyFatigueCacheEntry, "function");
  assert.equal(typeof describeAiPolicyFatigueCache, "function");
});

test("legacy scanAiPolicyText still returns the original hard-ban shape", () => {
  assert.deepEqual(scanAiPolicyText("Please include tests.", "CONTRIBUTING.md"), {
    allowed: true,
    matchedPhrase: null,
    source: "CONTRIBUTING.md",
  });
  assert.deepEqual(scanAiPolicyText("No AI-generated pull requests.", "AI-USAGE.md"), {
    allowed: false,
    matchedPhrase: "no ai-generated pull requests",
    source: "AI-USAGE.md",
  });
});

test("resolveAiPolicyVerdict still lets non-empty AI-USAGE.md take precedence", () => {
  assert.deepEqual(
    resolveAiPolicyVerdict({
      aiUsage: "Please disclose automation usage.",
      contributing: "AI-generated PRs are rejected.",
    }),
    { allowed: true, matchedPhrase: null, source: "AI-USAGE.md" },
  );
});

test("resolveAiPolicyFatigueVerdict returns no fatigue signal for quiet metadata", () => {
  const verdict = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Please write tests and keep PRs focused." },
    pullRequests: [
      {
        id: "human-pr",
        state: "closed",
        title: "Fix typo",
        labels: ["docs"],
        authorLogin: "maintainer",
        closedAt: "2026-07-01T00:00:00Z",
        maintainerResponse: "helpful",
      },
    ],
  });

  assert.equal(verdict.allowed, true);
  assert.deepEqual(verdict.fatigue, {
    level: "none",
    priorityAdjustment: "none",
    score: 0,
    recheckAfterHours: 168,
    evidence: [],
  });
});

test("resolveAiPolicyFatigueVerdict detects fatigue-only metadata without hard skipping", () => {
  const verdict = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Please keep changes focused." },
    pullRequests: [
      aiPr({ id: "pr-1", closedAt: "2026-07-04T00:00:00Z" }),
      aiPr({ id: "pr-2", title: "LLM generated parser cleanup", closedAt: "2026-07-03T00:00:00Z" }),
      aiPr({ id: "pr-3", title: "Codex authored refactor", closedAt: "2026-07-02T00:00:00Z" }),
    ],
    docChanges: [
      {
        path: "CONTRIBUTING.md",
        changedAt: "2026-07-04T12:00:00Z",
        addedPhrases: ["Please disclose AI or automation assistance in pull requests."],
      },
    ],
  });

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.matchedPhrase, null);
  assert.equal(verdict.fatigue?.level, "defer");
  assert.equal(verdict.fatigue?.priorityAdjustment, "defer");
  assert.equal(verdict.fatigue?.recheckAfterHours, 12);
  assert.ok((verdict.fatigue?.score ?? 0) >= 0.72);
  assert.deepEqual(
    verdict.fatigue?.evidence.map((item) => item.kind),
    ["ai_attributed_closed_pr", "terse_ai_attributed_rejection_cluster", "recent_ai_doc_language"],
  );
});

test("resolveAiPolicyFatigueVerdict treats watch-level evidence as deprioritize, not skip", () => {
  const verdict = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Normal contribution guide." },
    pullRequests: [aiPr({ id: "single", maintainerResponse: "neutral", reviewDecision: "none" })],
  });

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.fatigue?.level, "watch");
  assert.equal(verdict.fatigue?.priorityAdjustment, "deprioritize");
  assert.equal(verdict.fatigue?.recheckAfterHours, 48);
  assert.equal(verdict.fatigue?.evidence[0]?.kind, "ai_attributed_closed_pr");
});

test("resolveAiPolicyFatigueVerdict keeps formal bans authoritative over fatigue", () => {
  const verdict = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: "AI-generated PRs are rejected.", contributing: null },
    pullRequests: [
      aiPr({ id: "pr-1" }),
      aiPr({ id: "pr-2" }),
      aiPr({ id: "pr-3" }),
    ],
    docChanges: [
      {
        path: "CONTRIBUTING.md",
        changedAt: "2026-07-04T00:00:00Z",
        addedText: "AI automation language",
      },
    ],
  });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.matchedPhrase, "ai-generated prs are rejected");
  assert.equal(verdict.fatigue?.level, "none");
  assert.equal(verdict.fatigue?.priorityAdjustment, "none");
  assert.equal(verdict.fatigue?.score, 0);
  assert.deepEqual(verdict.fatigue?.evidence.map((item) => item.kind), ["formal_ban_overrides"]);
});

test("resolveAiPolicyFatigueVerdict ignores doc changes that are already formal ban phrases", () => {
  const verdict = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Current policy has no formal ban." },
    docChanges: [
      {
        path: "CONTRIBUTING.md",
        changedAt: "2026-07-04T00:00:00Z",
        addedText: "No AI-generated pull requests.",
      },
    ],
  });

  assert.equal(verdict.allowed, true);
  assert.equal(verdict.fatigue?.level, "none");
  assert.deepEqual(verdict.fatigue?.evidence, []);
});

test("resolveAiPolicyFatigueVerdict recency-weights doc language", () => {
  const fresh = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Normal guide." },
    docChanges: [
      {
        path: "CONTRIBUTING.md",
        changedAt: "2026-07-04T00:00:00Z",
        addedPhrases: ["automation-assisted changes should be disclosed"],
      },
    ],
  });
  const stale = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Normal guide." },
    docChanges: [
      {
        path: "CONTRIBUTING.md",
        changedAt: "2026-01-01T00:00:00Z",
        addedPhrases: ["automation-assisted changes should be disclosed"],
      },
    ],
  });

  assert.equal(fresh.fatigue?.level, "watch");
  assert.equal(stale.fatigue?.level, "none");
  assert.ok((fresh.fatigue?.score ?? 0) > (stale.fatigue?.score ?? 0));
});

test("resolveAiPolicyFatigueVerdict reuses fresh cache entries", () => {
  const cache = createAiPolicyFatigueCacheEntry({
    repoFullName: "JSONbored/Gittensory",
    computedAt: "2026-07-04T12:00:00Z",
    verdict: {
      level: "deprioritize",
      priorityAdjustment: "deprioritize",
      score: 0.5,
      recheckAfterHours: 24,
      evidence: [
        {
          kind: "recent_ai_doc_language",
          weight: 0.5,
          summary: "cached evidence",
          observedAt: "2026-07-04T00:00:00.000Z",
        },
      ],
    },
  });
  const verdict = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Normal guide." },
    cache,
    pullRequests: [aiPr({ id: "ignored-by-cache" })],
  });

  assert.equal(cache.repoFullName, "jsonbored/gittensory");
  assert.equal(cache.computedAt, "2026-07-04T12:00:00.000Z");
  assert.equal(verdict.fatigue?.level, "deprioritize");
  assert.equal(verdict.fatigue?.score, 0.5);
  assert.deepEqual(
    verdict.fatigue?.evidence.map((item) => item.kind),
    ["cache_fresh", "recent_ai_doc_language"],
  );
});

test("describeAiPolicyFatigueCache reports fresh, expired, missing, and malformed entries", () => {
  const cache = createAiPolicyFatigueCacheEntry({
    repoFullName: "JSONbored/Gittensory",
    computedAt: "2026-07-04T12:00:00Z",
    verdict: {
      level: "watch",
      priorityAdjustment: "deprioritize",
      score: 0.25,
      recheckAfterHours: 48,
      evidence: [],
    },
  });

  assert.deepEqual(describeAiPolicyFatigueCache(cache, NOW), {
    repoFullName: "jsonbored/gittensory",
    computedAt: "2026-07-04T12:00:00.000Z",
    expiresAt: "2026-07-05T12:00:00.000Z",
    ageHours: 12,
    fresh: true,
  });
  assert.deepEqual(describeAiPolicyFatigueCache(cache, "2026-07-06T00:00:00Z"), {
    repoFullName: "jsonbored/gittensory",
    computedAt: "2026-07-04T12:00:00.000Z",
    expiresAt: "2026-07-05T12:00:00.000Z",
    ageHours: 36,
    fresh: false,
  });
  assert.deepEqual(describeAiPolicyFatigueCache(null, NOW), {
    repoFullName: "unknown",
    computedAt: null,
    expiresAt: null,
    ageHours: null,
    fresh: false,
  });
  assert.deepEqual(
    describeAiPolicyFatigueCache(
      {
        repoFullName: "owner/repo",
        computedAt: "not a date",
        verdict: { level: "none", priorityAdjustment: "none", score: 0, recheckAfterHours: 168, evidence: [] },
      },
      NOW,
    ),
    {
      repoFullName: "owner/repo",
      computedAt: null,
      expiresAt: null,
      ageHours: null,
      fresh: false,
    },
  );
});

test("createAiPolicyFatigueCacheEntry rejects malformed repo keys", () => {
  assert.throws(
    () =>
      createAiPolicyFatigueCacheEntry({
        repoFullName: "not a repo",
        computedAt: NOW,
        verdict: { level: "none", priorityAdjustment: "none", score: 0, recheckAfterHours: 168, evidence: [] },
      }),
    /owner\/name/u,
  );
});

test("resolveAiPolicyFatigueVerdict recomputes expired cache entries", () => {
  const verdict = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Normal guide." },
    cache: {
      repoFullName: "jsonbored/gittensory",
      computedAt: "2026-07-01T00:00:00Z",
      verdict: {
        level: "defer",
        priorityAdjustment: "defer",
        score: 1,
        recheckAfterHours: 12,
        evidence: [],
      },
    },
    pullRequests: [],
  });

  assert.equal(verdict.fatigue?.level, "none");
  assert.equal(verdict.fatigue?.score, 0);
  assert.deepEqual(verdict.fatigue?.evidence, []);
});

test("resolveAiPolicyFatigueVerdict recognizes AI-attribution aliases from metadata only", () => {
  const verdict = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Normal guide." },
    pullRequests: [
      aiPr({ id: "llm", title: "LLM assisted docs update", labels: [], authorLogin: "alice" }),
      aiPr({ id: "claude", title: "Refactor parser", labels: ["claude generated"], authorLogin: "bob" }),
      aiPr({ id: "automation", title: "Parser cleanup", labels: ["automation submitted"], authorLogin: "carol" }),
      aiPr({ id: "human", title: "Manual parser cleanup", labels: [], authorLogin: "dave" }),
    ],
  });

  assert.equal(verdict.fatigue?.level, "defer");
  assert.equal(verdict.fatigue?.evidence[0]?.summary, "3 closed AI-attributed PR metadata row(s) observed");
  assert.match(verdict.fatigue?.evidence[1]?.summary ?? "", /^3\/3 AI-attributed/u);
});

test("resolveAiPolicyFatigueVerdict ignores open and merged AI-attributed PRs for rejection fatigue", () => {
  const verdict = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Normal guide." },
    pullRequests: [
      aiPr({ id: "open", state: "open", closedAt: null }),
      aiPr({ id: "merged", state: "closed", mergedAt: "2026-07-04T00:00:00Z" }),
      aiPr({ id: "actual", state: "closed", mergedAt: null }),
    ],
  });

  assert.equal(verdict.fatigue?.level, "watch");
  assert.equal(verdict.fatigue?.evidence.length, 1);
  assert.equal(verdict.fatigue?.evidence[0]?.summary, "1 closed AI-attributed PR metadata row(s) observed");
});

test("resolveAiPolicyFatigueVerdict handles malformed timestamps with conservative weights", () => {
  const verdict = resolveAiPolicyFatigueVerdict({
    now: "not a date",
    docs: { aiUsage: null, contributing: "Normal guide." },
    pullRequests: [aiPr({ closedAt: "not a date", createdAt: null })],
    docChanges: [{ path: "AI-USAGE.md", changedAt: "not a date", addedText: "AI assistance should be disclosed" }],
  });

  assert.equal(verdict.allowed, true);
  assert.ok((verdict.fatigue?.score ?? 0) > 0);
  assert.equal(verdict.fatigue?.evidence[0]?.observedAt, null);
});

test("renderAiPolicyFatigueMarkdown renders deterministic observability output", () => {
  const verdict = resolveAiPolicyFatigueVerdict({
    now: NOW,
    docs: { aiUsage: null, contributing: "Normal guide." },
    pullRequests: [aiPr({ id: "pr-1" }), aiPr({ id: "pr-2" })],
  });
  const markdown = renderAiPolicyFatigueMarkdown(verdict);

  assert.ok(markdown.startsWith("# AI Policy Fatigue\n\nHard policy allowed: yes"));
  assert.match(markdown, /Policy source: CONTRIBUTING\.md/u);
  assert.match(markdown, /Fatigue level: defer/u);
  assert.match(markdown, /Priority adjustment: defer/u);
  assert.match(markdown, /## Evidence\n\n- ai\\_attributed\\_closed\\_pr:/u);
  assert.match(markdown, /terse\\_ai\\_attributed\\_rejection\\_cluster/u);
});

test("renderAiPolicyFatigueMarkdown renders none when no fatigue field is attached", () => {
  const markdown = renderAiPolicyFatigueMarkdown({ allowed: true, matchedPhrase: null, source: "none" });

  assert.match(markdown, /Fatigue level: none/u);
  assert.match(markdown, /Priority adjustment: none/u);
  assert.match(markdown, /## Evidence\n\n- none/u);
});

test("renderAiPolicyFatigueMarkdown escapes summaries and policy source fields", () => {
  const markdown = renderAiPolicyFatigueMarkdown({
    allowed: true,
    matchedPhrase: null,
    source: "CONTRIBUTING.md",
    fatigue: {
      level: "watch",
      priorityAdjustment: "deprioritize",
      score: 0.2,
      recheckAfterHours: 48,
      evidence: [
        {
          kind: "recent_ai_doc_language",
          weight: 0.2,
          summary: "AI note with `code` and *stars*\nnext",
          observedAt: "2026-07-04T00:00:00.000Z",
        },
      ],
    },
  });

  assert.ok(markdown.includes("CONTRIBUTING.md"));
  assert.match(markdown, /AI note with \\+`code\\+` and \\+\*stars\\+\* next/u);
});

test("resolveAiPolicyFatigueVerdict is byte-stable for the same metadata", () => {
  const input = {
    now: NOW,
    docs: { aiUsage: null, contributing: "Normal guide." },
    pullRequests: [aiPr({ id: "a" }), aiPr({ id: "b" })],
    docChanges: [{ path: "CONTRIBUTING.md", changedAt: "2026-07-04T00:00:00Z", addedText: "AI disclosure" }],
  } as const;

  assert.equal(JSON.stringify(resolveAiPolicyFatigueVerdict(input)), JSON.stringify(resolveAiPolicyFatigueVerdict(input)));
});

test("applyAiPolicyFatigueToRankInput leaves clean repos unchanged", () => {
  const adjusted = applyAiPolicyFatigueToRankInput(
    { potential: 0.8, feasibility: 0.7, laneFit: 1, freshness: 0.9, dupRisk: 0.1 },
    { allowed: true, matchedPhrase: null, source: "none" },
  );

  assert.deepEqual(adjusted, {
    potential: 0.8,
    feasibility: 0.7,
    laneFit: 1,
    freshness: 0.9,
    dupRisk: 0.1,
    fatigueLevel: "none",
    priorityAdjustment: "none",
    fatigueMultiplier: 1,
    deferUntilHours: null,
    reasons: [],
  });
});

test("applyAiPolicyFatigueToRankInput downranks watch and deprioritize verdicts", () => {
  const watch = applyAiPolicyFatigueToRankInput(
    { potential: 1, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0 },
    {
      allowed: true,
      matchedPhrase: null,
      source: "CONTRIBUTING.md",
      fatigue: {
        level: "watch",
        priorityAdjustment: "deprioritize",
        score: 0.2,
        recheckAfterHours: 48,
        evidence: [{ kind: "ai_attributed_closed_pr", weight: 0.2, summary: "single AI-attributed closure", observedAt: null }],
      },
    },
  );
  const deprioritize = applyAiPolicyFatigueToRankInput(
    { potential: 1, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0 },
    {
      allowed: true,
      matchedPhrase: null,
      source: "CONTRIBUTING.md",
      fatigue: {
        level: "deprioritize",
        priorityAdjustment: "deprioritize",
        score: 0.5,
        recheckAfterHours: 24,
        evidence: [{ kind: "recent_ai_doc_language", weight: 0.5, summary: "recent doc language", observedAt: null }],
      },
    },
  );

  assert.equal(watch.potential, 0.7);
  assert.equal(watch.fatigueMultiplier, 0.7);
  assert.equal(watch.deferUntilHours, null);
  assert.deepEqual(watch.reasons, ["AI-fatigue deprioritize signal (watch)", "single AI-attributed closure"]);
  assert.equal(deprioritize.potential, 0.35);
  assert.equal(deprioritize.fatigueMultiplier, 0.35);
  assert.deepEqual(deprioritize.reasons, ["AI-fatigue deprioritize signal (deprioritize)", "recent doc language"]);
});

test("applyAiPolicyFatigueToRankInput defers strong fatigue without making it a hard ban", () => {
  const adjusted = applyAiPolicyFatigueToRankInput(
    { potential: 0.9, feasibility: 0.8, laneFit: 0.7, freshness: 0.6, dupRisk: 0.2 },
    {
      allowed: true,
      matchedPhrase: null,
      source: "CONTRIBUTING.md",
      fatigue: {
        level: "defer",
        priorityAdjustment: "defer",
        score: 0.9,
        recheckAfterHours: 12,
        evidence: [
          { kind: "ai_attributed_closed_pr", weight: 0.3, summary: "closed rows", observedAt: null },
          { kind: "terse_ai_attributed_rejection_cluster", weight: 0.5, summary: "terse cluster", observedAt: null },
          { kind: "recent_ai_doc_language", weight: 0.1, summary: "doc language", observedAt: null },
          { kind: "recent_ai_doc_language", weight: 0.1, summary: "extra evidence omitted", observedAt: null },
        ],
      },
    },
  );

  assert.equal(adjusted.potential, 0.045);
  assert.equal(adjusted.feasibility, 0.8);
  assert.equal(adjusted.laneFit, 0.7);
  assert.equal(adjusted.freshness, 0.6);
  assert.equal(adjusted.dupRisk, 0.2);
  assert.equal(adjusted.priorityAdjustment, "defer");
  assert.equal(adjusted.deferUntilHours, 12);
  assert.deepEqual(adjusted.reasons, [
    "AI-fatigue defer signal (defer)",
    "closed rows",
    "terse cluster",
    "doc language",
  ]);
});

test("applyAiPolicyFatigueToRankInput still fails closed for formal hard bans", () => {
  const adjusted = applyAiPolicyFatigueToRankInput(
    { potential: 0.9, feasibility: 0.8, laneFit: 0.7, freshness: 0.6, dupRisk: 0.2 },
    { allowed: false, matchedPhrase: "no ai-generated pull requests", source: "AI-USAGE.md" },
  );

  assert.equal(adjusted.potential, 0);
  assert.equal(adjusted.dupRisk, 1);
  assert.equal(adjusted.priorityAdjustment, "defer");
  assert.equal(adjusted.deferUntilHours, null);
  assert.deepEqual(adjusted.reasons, ["formal AI policy denial from AI-USAGE.md"]);
});

test("applyAiPolicyFatigueToRankInput clamps malformed rank inputs", () => {
  const adjusted = applyAiPolicyFatigueToRankInput(
    { potential: Number.POSITIVE_INFINITY, feasibility: -1, laneFit: 2, freshness: Number.NaN, dupRisk: -0.5 },
    { allowed: true, matchedPhrase: null, source: "none" },
  );

  assert.equal(adjusted.potential, 0);
  assert.equal(adjusted.feasibility, 0);
  assert.equal(adjusted.laneFit, 1);
  assert.equal(adjusted.freshness, 0);
  assert.equal(adjusted.dupRisk, 0);
});
