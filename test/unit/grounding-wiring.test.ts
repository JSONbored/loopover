import { afterEach, describe, expect, it, vi } from "vitest";
import { runLoopOverAiReview } from "../../src/services/ai-review";
import { runAiReviewForAdvisory } from "../../src/queue/processors";
import {
  aiCiRefutationActive,
  buildCheckAggregate,
  buildReviewGroundingText,
  isGroundingEnabled,
  makeGithubFileFetcher,
} from "../../src/review/grounding-wire";
import { getCachedGroundingFileContent, putCachedGroundingFileContent, upsertCheckSummary, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import * as githubApp from "../../src/github/app";
import {
  githubRateLimitAdmissionKeyForInstallation,
  githubRateLimitAdmissionKeyForPublicToken,
  latestGitHubRestRateLimitObservation,
} from "../../src/github/client";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import type { Advisory, CheckSummaryRecord, JsonValue, PullRequestFileRecord, RepositorySettings } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// ── Test fixtures ────────────────────────────────────────────────────────────────────────────────

const notesJson = JSON.stringify({
  assessment: "Looks fine.",
  suggestions: [],
  risks: [],
  criticalDefect: { present: false, confidence: 0, title: "", detail: "" },
});

/** Capture the exact system + user prompts handed to the model so we can assert what the AI actually sees. */
function capturingAiEnv(grounding: boolean | undefined) {
  const seenUser: string[] = [];
  const seenSystem: string[] = [];
  const run = vi.fn(async (_model: string, options: { messages: Array<{ role: string; content: string }> }) => {
    const userMsg = options.messages.find((m) => m.role === "user");
    const systemMsg = options.messages.find((m) => m.role === "system");
    if (userMsg) seenUser.push(userMsg.content);
    if (systemMsg) seenSystem.push(systemMsg.content);
    return { response: notesJson };
  });
  const env = createTestEnv({
    AI: { run } as unknown as Ai,
    AI_SUMMARIES_ENABLED: "true",
    AI_PUBLIC_COMMENTS_ENABLED: "true",
    AI_DAILY_NEURON_BUDGET: "100000",
    ...(grounding === undefined ? {} : { LOOPOVER_REVIEW_GROUNDING: grounding ? "true" : "false" }),
  });
  return { env, seenUser, seenSystem, run };
}

const baseReviewInput = {
  repoFullName: "acme/widgets",
  prNumber: 7,
  title: "Add a feature",
  body: "Implements the thing.",
  diff: "### src/a.ts (modified) +1/-0\n@@\n+export const A = 1;",
  actor: "alice",
  mode: "advisory" as const,
  providerKey: null,
};

const check = (over: Partial<CheckSummaryRecord> = {}): CheckSummaryRecord => ({
  id: "acme/widgets#sha7#build",
  repoFullName: "acme/widgets",
  pullNumber: 7,
  headSha: "sha7",
  name: "build",
  status: "completed",
  conclusion: "success",
  payload: {} as Record<string, JsonValue>,
  ...over,
});

const prFile = (path: string, status = "modified"): PullRequestFileRecord => ({
  repoFullName: "acme/widgets",
  pullNumber: 7,
  path,
  status,
  additions: 1,
  deletions: 0,
  changes: 1,
  payload: {},
});

// ── isGroundingEnabled ─────────────────────────────────────────────────────────────────────────

describe("isGroundingEnabled", () => {
  it("is OFF for unset/false and ON for the truthy convention", () => {
    expect(isGroundingEnabled({})).toBe(false);
    expect(isGroundingEnabled({ LOOPOVER_REVIEW_GROUNDING: "false" })).toBe(false);
    expect(isGroundingEnabled({ LOOPOVER_REVIEW_GROUNDING: "true" })).toBe(true);
    expect(isGroundingEnabled({ LOOPOVER_REVIEW_GROUNDING: "1" })).toBe(true);
    expect(isGroundingEnabled({ LOOPOVER_REVIEW_GROUNDING: "on" })).toBe(true);
  });
});

describe("aiCiRefutationActive compatibility helper", () => {
  const env = (grounding: string, repos: string) => ({ LOOPOVER_REVIEW_GROUNDING: grounding, LOOPOVER_REVIEW_REPOS: repos }) as unknown as Env;
  const REPO = "JSONbored/metagraphed";

  it("is ON only when grounding is enabled AND the repo is convergence-allowlisted", () => {
    expect(aiCiRefutationActive(env("true", REPO), REPO)).toBe(true);
  });
  it("is OFF when grounding is enabled but the repo is NOT allowlisted", () => {
    expect(aiCiRefutationActive(env("true", "JSONbored/other"), REPO)).toBe(false);
  });
  it("is OFF when grounding is disabled even if the repo is allowlisted (short-circuits before convergence)", () => {
    expect(aiCiRefutationActive(env("false", REPO), REPO)).toBe(false);
  });
  it("is OFF when both are off", () => {
    expect(aiCiRefutationActive(env("", ""), REPO)).toBe(false);
  });
});

// ── buildCheckAggregate (CI summary source) ──────────────────────────────────────────────────────

describe("buildCheckAggregate maps loopover check summaries → the grounding aggregate", () => {
  it("returns undefined when there are no checks (no CI signal to assert)", () => {
    expect(buildCheckAggregate([])).toBeUndefined();
  });

  it("all green → state passed, every check under passing", () => {
    const agg = buildCheckAggregate([check({ name: "build" }), check({ name: "test", id: "x" })]);
    expect(agg).toEqual({ state: "passed", passing: ["build", "test"], failingDetails: [] });
  });

  it("a failing check flips state to failed and carries the output.summary reason", () => {
    const agg = buildCheckAggregate([
      check({ name: "build" }),
      check({
        name: "codecov/patch",
        id: "cov",
        conclusion: "failure",
        payload: { output: { summary: "60% of diff hit (target 97%)" } } as Record<string, JsonValue>,
      }),
    ]);
    expect(agg?.state).toBe("failed");
    expect(agg?.passing).toEqual(["build"]);
    expect(agg?.failingDetails).toEqual([{ name: "codecov/patch", summary: "60% of diff hit (target 97%)" }]);
  });

  it("an un-concluded (running) check makes state pending", () => {
    const agg = buildCheckAggregate([check({ name: "deploy", conclusion: null, status: "in_progress" })]);
    expect(agg?.state).toBe("pending");
  });
});

// ── End-to-end: flag-gated prompt grounding through runLoopOverAiReview ─────────────────────────

describe("review-grounding wired into the AI reviewer (flag LOOPOVER_REVIEW_GROUNDING)", () => {
  it("FLAG-ON: the user prompt gains CI STATUS + FULL FILE CONTENT and the system prompt gains the grounding discipline", async () => {
    const { env, seenUser, seenSystem } = capturingAiEnv(true);
    // Stub the GitHub Contents API so the real FileFetcher returns deterministic file text.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("/contents/src/a.ts") ? new Response("export const A = 1; // full file", { status: 200 }) : new Response("missing", { status: 404 }),
    );
    const grounding = await buildReviewGroundingText(env, {
      repoFullName: "acme/widgets",
      headSha: "sha7",
      files: [prFile("src/a.ts")],
      checks: [check({ name: "build" }), check({ name: "test", id: "t" })],
      installationId: null,
    });
    const result = await runLoopOverAiReview(env, { ...baseReviewInput, grounding });
    expect(result.status).toBe("ok");
    const user = seenUser[0] ?? "";
    const system = seenSystem[0] ?? "";
    // CI grounding present in the user prompt.
    expect(user).toContain("CI STATUS");
    expect(user).toContain("ALL checks PASSED");
    expect(user).toContain("PASSED: build, test");
    // Full-file grounding present in the user prompt.
    expect(user).toContain("FULL FILE CONTENT");
    expect(user).toContain("### src/a.ts");
    expect(user).toContain("export const A = 1; // full file");
    // Grounding discipline appended to the system prompt.
    expect(system).toContain("GROUNDING");
    expect(system).toContain("NEVER predict");
    fetchSpy.mockRestore();
  });

  it("FLAG-ON via runAiReviewForAdvisory: the call site loads the repo's installationId and grounds the review", async () => {
    // Drives the processors.ts call site so `isGroundingEnabled ? buildReviewGroundingText(...) : undefined`
    // runs ON, including `(await getRepository(env, repo))?.installationId ?? null`.
    const run = vi.fn(async (_model: string, _opts: Record<string, unknown>) => ({ response: notesJson }));
    const env = createTestEnv({
      LOOPOVER_REVIEW_GROUNDING: "true",
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    // Register the repo WITH an installation id so the optional-chain reads a real installationId.
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: true, owner: { login: "acme" } }, 4242);
    // Seed a changed file + a finished check so grounding has CI + file content to assemble.
    await env.DB.prepare(
      "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("acme/widgets", 7, "src/a.ts", "modified", 1, 0, 1, JSON.stringify({ patch: "@@\n+export const A = 1;" })).run();
    await upsertCheckSummary(env, check({ name: "build" }));
    // The grounding fetcher hits the GitHub Contents API; stub it so file content resolves deterministically.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("/contents/") ? new Response("export const A = 1; // full", { status: 200 }) : new Response("nope", { status: 404 }),
    );
    const adv: Advisory = {
      id: "adv-g", targetType: "pull_request", targetKey: "acme/widgets#7", repoFullName: "acme/widgets",
      pullNumber: 7, headSha: "sha7", conclusion: "neutral", severity: "info",
      title: "LoopOver advisory available", summary: "ok", findings: [], generatedAt: "2026-06-20T00:00:00.000Z",
    };
    try {
      const result = await runAiReviewForAdvisory(env, {
        mode: "live",
        settings: { aiReviewMode: "advisory" } as RepositorySettings,
        repoFullName: "acme/widgets",
        pr: { number: 7, title: "Add a feature", body: "Implements the thing." },
        author: "alice",
        confirmedContributor: true,
        advisory: adv,
      });
      expect(result?.notes ?? "").toBeDefined();
      expect(run).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("FLAG-ON via runAiReviewForAdvisory: a repo with NO installationId grounds with installationId null (?? null)", async () => {
    const run = vi.fn(async () => ({ response: notesJson }));
    const env = createTestEnv({
      LOOPOVER_REVIEW_GROUNDING: "true",
      AI: { run } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_PUBLIC_COMMENTS_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "100000",
    });
    // Grounding is "allowlistRequired" (resolveConvergedFeature): the repo must be in LOOPOVER_REVIEW_REPOS
    // regardless of the override, so this MUST use an allowlisted repo (createTestEnv's default includes
    // "acme/widgets") — an un-allowlisted repo would short-circuit groundingActive to false before this
    // branch is ever reached, silently no-op-ing the assertion below.
    // Register WITHOUT an installation id → (await getRepository(...))?.installationId is null → `?? null`.
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "acme/widgets", private: true, owner: { login: "acme" } });
    await env.DB.prepare(
      "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("acme/widgets", 7, "src/a.ts", "modified", 1, 0, 1, JSON.stringify({ patch: "@@\n+export const A = 1;" })).run();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    const adv: Advisory = {
      id: "adv-g2", targetType: "pull_request", targetKey: "acme/widgets#7", repoFullName: "acme/widgets",
      pullNumber: 7, headSha: "sha7", conclusion: "neutral", severity: "info",
      title: "LoopOver advisory available", summary: "ok", findings: [], generatedAt: "2026-06-20T00:00:00.000Z",
    };
    try {
      const result = await runAiReviewForAdvisory(env, {
        mode: "live",
        settings: { aiReviewMode: "advisory" } as RepositorySettings,
        repoFullName: "acme/widgets",
        pr: { number: 7, title: "Add a feature", body: "x" },
        author: "alice",
        confirmedContributor: true,
        advisory: adv,
      });
      expect(result?.notes ?? "").toBeDefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("FLAG-OFF (default): the prompt is byte-identical and NO file fetch is attempted", async () => {
    // With grounding undefined (the flag-OFF call site leaves it undefined), the prompt must equal the
    // no-grounding prompt — proving no section was appended.
    const off = capturingAiEnv(false);
    await runLoopOverAiReview(off.env, { ...baseReviewInput, grounding: undefined });
    const none = capturingAiEnv(undefined);
    await runLoopOverAiReview(none.env, baseReviewInput);

    expect(off.seenUser[0]).not.toContain("CI STATUS");
    expect(off.seenUser[0]).not.toContain("FULL FILE CONTENT");
    expect(off.seenSystem[0]).not.toContain("GROUNDING");
    // undefined grounding === explicit-false: identical prompts, proving flag-OFF took no new branch.
    expect(none.seenUser[0]).toBe(off.seenUser[0]);
    expect(none.seenSystem[0]).toBe(off.seenSystem[0]);
  });

  it("buildReviewGroundingText returns empty (no fetch) when the flag is OFF", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "false" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await buildReviewGroundingText(env, {
      repoFullName: "acme/widgets",
      headSha: "sha7",
      files: [prFile("src/a.ts")],
      checks: [check()],
      installationId: null,
    });
    expect(out).toEqual({ systemSuffix: "", promptSection: "" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // #review-grounding stale-base fact (metagraphed #7305-class incident): buildReviewGroundingText's OWN
  // wiring of the compare-API staleness read, on top of review-grounding.ts's already-covered pure logic.
  // Anchored on `headSha` (the PR's real current code), NOT a `baseSha` field -- GitHub keeps a PR's own
  // `base.sha` pointed at the live target-branch tip as it moves, so comparing THAT against the current
  // default branch would read ~0 regardless of how stale the PR's actual code is.
  describe("buildReviewGroundingText baseAheadBy wiring", () => {
    const failingNoDetailCheck = check({ name: "test", conclusion: "failure", payload: {} as Record<string, JsonValue> });

    it("folds BASE BRANCH STATUS into the prompt when headSha/defaultBranchRef resolve a positive ahead_by", async () => {
      const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "true", GITHUB_PUBLIC_TOKEN: "ghp_test" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes("/compare/")) {
          expect(u).toBe("https://api.github.com/repos/acme/widgets/compare/sha7...main");
          return Response.json({ ahead_by: 12 });
        }
        return new Response("not found", { status: 404 });
      });
      const out = await buildReviewGroundingText(env, {
        repoFullName: "acme/widgets",
        headSha: "sha7",
        files: [],
        checks: [failingNoDetailCheck],
        installationId: null,
        defaultBranchRef: "main",
      });
      expect(out.promptSection).toContain("BASE BRANCH STATUS");
      expect(out.promptSection).toContain("12 commits behind");
      fetchSpy.mockRestore();
    });

    it("omits BASE BRANCH STATUS when defaultBranchRef is not provided (back-compat) — no compare fetch attempted", async () => {
      const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "true", GITHUB_PUBLIC_TOKEN: "ghp_test" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
      const out = await buildReviewGroundingText(env, {
        repoFullName: "acme/widgets",
        headSha: "sha7",
        files: [],
        checks: [failingNoDetailCheck],
        installationId: null,
      });
      expect(out.promptSection).toContain("CI STATUS");
      expect(out.promptSection).not.toContain("BASE BRANCH STATUS");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("omits BASE BRANCH STATUS when headSha is not provided — no compare fetch attempted", async () => {
      const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "true", GITHUB_PUBLIC_TOKEN: "ghp_test" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
      const out = await buildReviewGroundingText(env, {
        repoFullName: "acme/widgets",
        headSha: null,
        files: [],
        checks: [failingNoDetailCheck],
        installationId: null,
        defaultBranchRef: "main",
      });
      expect(out.promptSection).not.toContain("BASE BRANCH STATUS");
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("fail-safe: a failing compare fetch degrades to no BASE BRANCH STATUS section, CI grounding still present", async () => {
      const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "true", GITHUB_PUBLIC_TOKEN: "ghp_test" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("server error", { status: 500 }));
      const out = await buildReviewGroundingText(env, {
        repoFullName: "acme/widgets",
        headSha: "sha7",
        files: [],
        checks: [failingNoDetailCheck],
        installationId: null,
        defaultBranchRef: "main",
      });
      expect(out.promptSection).toContain("CI STATUS");
      expect(out.promptSection).not.toContain("BASE BRANCH STATUS");
      fetchSpy.mockRestore();
    });

    it("resolves an installation token for the compare read when installationId is set (mint success)", async () => {
      const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "true", GITHUB_PUBLIC_TOKEN: "ghp_public" });
      const tokenSpy = vi.spyOn(githubApp, "createInstallationToken").mockResolvedValue("install-token");
      let sawAuth: string | null = null;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        if (String(url).includes("/compare/")) {
          sawAuth = new Headers(init?.headers).get("authorization");
          return Response.json({ ahead_by: 3 });
        }
        return new Response("not found", { status: 404 });
      });
      const out = await buildReviewGroundingText(env, {
        repoFullName: "acme/widgets",
        headSha: "sha7",
        files: [],
        checks: [failingNoDetailCheck],
        installationId: 12345,
        defaultBranchRef: "main",
      });
      expect(sawAuth).toBe("Bearer install-token");
      expect(out.promptSection).toContain("3 commits behind");
      tokenSpy.mockRestore();
      fetchSpy.mockRestore();
    });

    it("does not attempt a compare read when the flag is off, even with headSha/defaultBranchRef set", async () => {
      const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "false" });
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const out = await buildReviewGroundingText(env, {
        repoFullName: "acme/widgets",
        headSha: "sha7",
        files: [],
        checks: [failingNoDetailCheck],
        installationId: null,
        defaultBranchRef: "main",
      });
      expect(out).toEqual({ systemSuffix: "", promptSection: "" });
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  it("FLAG-ON e2e: full-file content is fetched (capped/prioritized) and inlined into the prompt", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "true", GITHUB_PUBLIC_TOKEN: "ghp_test" });
    // Stub the GitHub Contents API so the real FileFetcher returns deterministic file text.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/contents/src/a.ts")) return new Response("export const A = 1; // full file", { status: 200 });
      if (u.includes("/contents/README.md")) return new Response("# docs", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const out = await buildReviewGroundingText(env, {
      repoFullName: "acme/widgets",
      headSha: "sha7",
      files: [prFile("README.md"), prFile("src/a.ts")], // docs listed first; source must still come first
      checks: [check()],
      installationId: null,
    });
    expect(out.promptSection).toContain("FULL FILE CONTENT");
    expect(out.promptSection).toContain("### src/a.ts");
    expect(out.promptSection).toContain("export const A = 1; // full file");
    // Source (priority 0) inlined before docs (priority 2).
    expect(out.promptSection.indexOf("### src/a.ts")).toBeLessThan(out.promptSection.indexOf("### README.md"));
    fetchSpy.mockRestore();
  });

  it("FLAG-ON: a file record with no status still grounds (toGroundingFiles' status field is optional)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "true", GITHUB_PUBLIC_TOKEN: "ghp_test" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("export const A = 1;", { status: 200 }));
    const noStatusFile: PullRequestFileRecord = { repoFullName: "acme/widgets", pullNumber: 7, path: "src/a.ts", additions: 1, deletions: 0, changes: 1, payload: {} };
    const out = await buildReviewGroundingText(env, {
      repoFullName: "acme/widgets",
      headSha: "sha7",
      files: [noStatusFile],
      checks: [check()],
      installationId: null,
    });
    expect(out.promptSection).toContain("export const A = 1;");
    fetchSpy.mockRestore();
  });

  it("FLAG-ON fail-safe: a throwing fetch degrades to no file section (never throws), CI still grounds", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "true" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const out = await buildReviewGroundingText(env, {
      repoFullName: "acme/widgets",
      headSha: "sha7",
      files: [prFile("src/a.ts")],
      checks: [check()],
      installationId: null,
    });
    // No FULL FILE CONTENT (fetch failed) but CI grounding survives — fail-safe, not all-or-nothing.
    expect(out.promptSection).not.toContain("FULL FILE CONTENT");
    expect(out.promptSection).toContain("CI STATUS");
    expect(out.systemSuffix).toContain("GROUNDING");
    fetchSpy.mockRestore();
  });

  it("FLAG-ON: with no CI rows AND no readable files, grounding is empty (system suffix not attached)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "true" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    const out = await buildReviewGroundingText(env, {
      repoFullName: "acme/widgets",
      headSha: "sha7",
      files: [prFile("src/a.ts")],
      checks: [], // no CI signal
      installationId: null,
    });
    expect(out).toEqual({ systemSuffix: "", promptSection: "" });
    fetchSpy.mockRestore();
  });
});

// ── makeGithubFileFetcher (the injected FileFetcher) ──────────────────────────────────────────────

describe("makeGithubFileFetcher (GitHub Contents-API-backed FileFetcher)", () => {
  it("returns the raw file text on 200 and null on a non-OK response", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/contents/ok.ts")) return new Response("file body", { status: 200 });
      return new Response("missing", { status: 404 });
    });
    const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
    expect(await fetcher.getFileContent("ok.ts", "sha7")).toBe("file body");
    expect(await fetcher.getFileContent("gone.ts", "sha7")).toBeNull();
    // The request targets the Contents API at the head ref with the raw media type.
    const firstUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(firstUrl).toContain("/repos/acme/widgets/contents/ok.ts");
    expect(firstUrl).toContain("ref=sha7");
    fetchSpy.mockRestore();
  });

  it("INVARIANT (#4499): a second getFileContent call for the SAME (repo, path, ref) makes ZERO additional GitHub fetches, reusing the cached content", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
    let fetchCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/contents/cached.ts")) {
        fetchCount += 1;
        return new Response("export const cached = true;", { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });
    // A brand-new fetcher instance each time -- mirrors a fresh review pass creating its own
    // makeGithubFileFetcher via a NEW GitHub App token, while sharing the SAME durable DB.
    const first = await (await makeGithubFileFetcher(env, "acme/widgets", null)).getFileContent("cached.ts", "sha7");
    const second = await (await makeGithubFileFetcher(env, "acme/widgets", null)).getFileContent("cached.ts", "sha7");
    expect(first).toBe("export const cached = true;");
    expect(second).toBe("export const cached = true;");
    expect(fetchCount).toBe(1);
    fetchSpy.mockRestore();
  });

  describe("cache hit/miss telemetry (#4448)", () => {
    afterEach(() => resetMetrics());

    async function auditEvent(env: Env, eventType: string, repoFullName: string) {
      return env.DB.prepare("SELECT outcome, target_key FROM audit_events WHERE event_type = ? AND target_key = ?")
        .bind(eventType, repoFullName)
        .first<{ outcome: string; target_key: string }>();
    }

    it("INVARIANT: a cache HIT fires exactly the hit counter/audit-event pair, and NOT the miss pair", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("export const v = 1;", { status: 200 }));
      await (await makeGithubFileFetcher(env, "acme/telemetry", null)).getFileContent("hit.ts", "sha7"); // first call: a miss
      resetMetrics();
      await env.DB.prepare("DELETE FROM audit_events").run(); // isolate to the SECOND call's telemetry only

      const second = await (await makeGithubFileFetcher(env, "acme/telemetry", null)).getFileContent("hit.ts", "sha7"); // same (repo, path, ref) -- a hit
      expect(second).toBe("export const v = 1;");

      const rendered = await renderMetrics();
      expect(rendered).toContain("loopover_grounding_cache_hit_total 1");
      expect(rendered).not.toContain("loopover_grounding_cache_miss_total");
      const hitEvent = await auditEvent(env, "github_app.grounding_cache_hit", "acme/telemetry");
      expect(hitEvent?.outcome).toBe("completed");
      expect(await auditEvent(env, "github_app.grounding_cache_miss", "acme/telemetry")).toBeUndefined();
      fetchSpy.mockRestore();
    });

    it("INVARIANT: a cache MISS fires exactly the miss counter/audit-event pair, and NOT the hit pair", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("export const v = 1;", { status: 200 }));

      const first = await (await makeGithubFileFetcher(env, "acme/telemetry", null)).getFileContent("miss.ts", "sha7");
      expect(first).toBe("export const v = 1;");

      const rendered = await renderMetrics();
      expect(rendered).toContain("loopover_grounding_cache_miss_total 1");
      expect(rendered).not.toContain("loopover_grounding_cache_hit_total");
      const missEvent = await auditEvent(env, "github_app.grounding_cache_miss", "acme/telemetry");
      expect(missEvent?.outcome).toBe("completed");
      expect(await auditEvent(env, "github_app.grounding_cache_hit", "acme/telemetry")).toBeUndefined();
      fetchSpy.mockRestore();
    });

    it("swallows a failing cache-hit audit-event write without throwing, still returning the cached content", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("export const v = 1;", { status: 200 }));
      await (await makeGithubFileFetcher(env, "acme/telemetry", null)).getFileContent("swallow.ts", "sha7"); // populates the cache

      const writeSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));
      const second = await (await makeGithubFileFetcher(env, "acme/telemetry", null)).getFileContent("swallow.ts", "sha7"); // a cache hit
      writeSpy.mockRestore();

      expect(second).toBe("export const v = 1;"); // the failed audit write never surfaces to the caller
      fetchSpy.mockRestore();
    });

    it("swallows a failing cache-MISS audit-event write without throwing, still returning the freshly-fetched content", async () => {
      const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("export const v = 1;", { status: 200 }));

      const writeSpy = vi.spyOn(repositoriesModule, "recordAuditEvent").mockRejectedValueOnce(new Error("D1 write error"));
      const first = await (await makeGithubFileFetcher(env, "acme/telemetry", null)).getFileContent("miss-swallow.ts", "sha7"); // cold cache -- a miss
      writeSpy.mockRestore();

      expect(first).toBe("export const v = 1;"); // the failed audit write never surfaces to the caller, fetch still happens
      fetchSpy.mockRestore();
    });
  });

  it("REGRESSION (#4499, grounding-refetch incident): repeated cooldown-driven calls on an unchanged head SHA only fetch once total, not once per call", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
    let fetchCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/contents/repeat.ts")) {
        fetchCount += 1;
        return new Response("export const repeat = 1;", { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });
    // Simulates 5 separate review passes for the SAME unchanged PR head (e.g. non-push webhook events, or
    // scheduled sweep ticks past the 30-minute non-cacheable cooldown) -- previously each one re-fetched the
    // full file body from GitHub from scratch.
    for (let i = 0; i < 5; i += 1) {
      const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
      // eslint-disable-next-line no-await-in-loop -- sequential passes, mirroring separate review invocations
      const content = await fetcher.getFileContent("repeat.ts", "unchanged-sha");
      expect(content).toBe("export const repeat = 1;");
    }
    expect(fetchCount).toBe(1);
    fetchSpy.mockRestore();
  });

  it("a genuinely NEW head SHA still triggers a fresh fetch (the cache never masks a real code change)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
    const responses: Record<string, string> = { "sha-old": "export const v = 1;", "sha-new": "export const v = 2;" };
    let fetchCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      const shaMatch = /ref=(sha-\w+)/.exec(u);
      const sha = shaMatch?.[1];
      if (u.includes("/contents/changed.ts") && sha && sha in responses) {
        fetchCount += 1;
        return new Response(responses[sha], { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });
    const first = await (await makeGithubFileFetcher(env, "acme/widgets", null)).getFileContent("changed.ts", "sha-old");
    const second = await (await makeGithubFileFetcher(env, "acme/widgets", null)).getFileContent("changed.ts", "sha-new");
    expect(first).toBe("export const v = 1;");
    expect(second).toBe("export const v = 2;");
    expect(fetchCount).toBe(2);
    fetchSpy.mockRestore();
  });

  it("a failed fetch (non-OK response) is never cached, so a later retry still attempts a fresh fetch", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
    let attempt = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/contents/flaky.ts")) {
        attempt += 1;
        return attempt === 1 ? new Response("server error", { status: 500 }) : new Response("export const recovered = true;", { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });
    const first = await (await makeGithubFileFetcher(env, "acme/widgets", null)).getFileContent("flaky.ts", "sha7");
    const second = await (await makeGithubFileFetcher(env, "acme/widgets", null)).getFileContent("flaky.ts", "sha7");
    expect(first).toBeNull();
    expect(second).toBe("export const recovered = true;");
    expect(attempt).toBe(2);
    fetchSpy.mockRestore();
  });

  it("REGRESSION (#4584): a truncated fetch is never cached, so a later call with a LARGER cap for the same (repo, path, ref) still fetches fresh instead of reusing the smaller cap's placeholder", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
    const full = "export const marker = 'content_beyond_the_small_caps_boundary';";
    let fetchCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/contents/truncated.ts")) {
        fetchCount += 1;
        // An explicit Content-Length over the caller's cap (as GitHub's Contents API always sends) takes the
        // early-bail placeholder path -- matches the real exploit shape (`+1` bytes of spaces, not a real prefix).
        return new Response(full, { status: 200, headers: { "content-length": String(full.length) } });
      }
      return new Response("missing", { status: 404 });
    });
    const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
    // First caller has a small cap -- the file exceeds it, so getFileContent returns the truncation
    // placeholder (a string of spaces, maxChars+1 long), which must NOT be cached.
    const small = await fetcher.getFileContent("truncated.ts", "sha7", 5);
    expect(small).toBe(" ".repeat(6));
    // Second caller (e.g. a content scanner that reads past where the first, smaller-cap caller stopped)
    // asks for the SAME file with a cap large enough to fit the whole body. Before the fix, this would have
    // hit the cache and returned the 6-char space placeholder (which reads as "complete" against THIS
    // caller's own 100-char cap), silently hiding the real content past the original small cap.
    const large = await fetcher.getFileContent("truncated.ts", "sha7", 100);
    expect(large).toBe(full);
    expect(fetchCount).toBe(2);
    fetchSpy.mockRestore();
  });

  it("REGRESSION (#4584): a truncated fetch writes no row to grounding_file_content_cache at all", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(50), { status: 200 }));
    try {
      const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
      await fetcher.getFileContent("nocache.ts", "sha7", 10);
      expect(await getCachedGroundingFileContent(env, "acme/widgets", "nocache.ts", "sha7")).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a throwing cache READ degrades to a fresh live fetch (fail-safe, never blocks the file fetch)", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("cache read boom");
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("export const ok = true;", { status: 200 }));
    try {
      const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
      expect(await fetcher.getFileContent("cacheread.ts", "sha7")).toBe("export const ok = true;");
    } finally {
      prepareSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("a throwing cache WRITE is swallowed (fail-safe) -- the fetched content is still returned even though it couldn't be cached", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_test" });
    const realPrepare = env.DB.prepare.bind(env.DB);
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (/INSERT INTO grounding_file_content_cache/i.test(sql)) throw new Error("cache write boom");
      return realPrepare(sql);
    });
    // A fresh Response each call -- mockResolvedValue would reuse ONE Response instance across both calls, and
    // a Response body can only be read once, which would make the second call's read return empty regardless
    // of caching behavior.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("export const ok = true;", { status: 200 }));
    try {
      const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
      expect(await fetcher.getFileContent("cachewrite.ts", "sha7")).toBe("export const ok = true;");
      // The write failed, so a SECOND call must still fetch live rather than (incorrectly) finding a cached row.
      expect(await fetcher.getFileContent("cachewrite.ts", "sha7")).toBe("export const ok = true;");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      prepareSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("never throws — a fetch rejection resolves to null", async () => {
    const env = createTestEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
    expect(await fetcher.getFileContent("any.ts", "sha7")).toBeNull();
    fetchSpy.mockRestore();
  });

  it("does not read bodies whose Content-Length exceeds the per-file cap", async () => {
    const env = createTestEnv();
    const text = vi.fn(async () => "too large");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "100" }),
      text,
      body: null,
    } as unknown as Response);
    const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
    const out = await fetcher.getFileContent("big.ts", "sha7", 10);
    expect(out?.length).toBeGreaterThan(10);
    expect(text).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("streams the body and truncates once the running text exceeds the per-file cap", async () => {
    const env = createTestEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            // Left open (not closed) so getFileContent must cancel() the reader on truncation. The
            // throwing cancel() forces reader.cancel() to reject, exercising the .catch fail-safe.
            controller.enqueue(new TextEncoder().encode("x".repeat(50)));
          },
          cancel() {
            throw new Error("cancel boom");
          },
        }),
        { status: 200 },
      ),
    );
    const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
    const out = await fetcher.getFileContent("big.ts", "sha7", 10);
    // The reader loop sees the running text exceed the cap and returns maxChars + 1 chars.
    expect(out).toBe("x".repeat(11));
    fetchSpy.mockRestore();
  });

  it("streams an under-cap body to completion and returns the full text", async () => {
    const env = createTestEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("small"));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
    const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
    expect(await fetcher.getFileContent("small.ts", "sha7", 10)).toBe("small");
    fetchSpy.mockRestore();
  });

  it("over-counts a trailing partial multibyte sequence on the final flush and truncates", async () => {
    const env = createTestEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            // "abc" keeps the running length at the cap; the lone 0xE2 byte is an incomplete UTF-8
            // 3-byte lead, so the final decoder flush emits U+FFFD and pushes the total over the cap.
            controller.enqueue(new TextEncoder().encode("abc"));
            controller.enqueue(new Uint8Array([0xe2]));
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );
    const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
    const out = await fetcher.getFileContent("multibyte.ts", "sha7", 3);
    expect(out).toHaveLength(4);
    expect(out?.startsWith("abc")).toBe(true);
    fetchSpy.mockRestore();
  });

  it("falls back to text() when the response has no streamable body, truncating over-cap content", async () => {
    const env = createTestEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers(), // no content-length → skips the early Content-Length guard
      body: null,
      text: async () => "y".repeat(50),
    } as unknown as Response);
    const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
    expect(await fetcher.getFileContent("nobody.ts", "sha7", 10)).toBe("y".repeat(11));
    fetchSpy.mockRestore();
  });

  it("falls back to text() and returns the full body when no streamable body and under cap", async () => {
    const env = createTestEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: new Headers(),
      body: null,
      text: async () => "tiny",
    } as unknown as Response);
    const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
    expect(await fetcher.getFileContent("nobody-small.ts", "sha7", 10)).toBe("tiny");
    fetchSpy.mockRestore();
  });

  it("aborts the fetch via the 10s timeout and resolves to null (fail-safe)", async () => {
    vi.useFakeTimers();
    try {
      const env = createTestEnv();
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = (init as RequestInit | undefined)?.signal;
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const fetcher = await makeGithubFileFetcher(env, "acme/widgets", null);
      const pending = fetcher.getFileContent("slow.ts", "sha7");
      // Fire the abort timer; the rejected fetch is swallowed by the outer fail-safe catch.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toBeNull();
      fetchSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("attempts an installation token when given an installationId, falling back to the public token on failure", async () => {
    // No GitHub App key is configured in the test env, so createInstallationToken rejects; the wire
    // swallows it (.catch -> undefined) and the fetcher then authenticates with the public token.
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_public" });
    let sawAuth: string | null = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      sawAuth = headers.get("authorization");
      return new Response("body", { status: 200 });
    });
    const fetcher = await makeGithubFileFetcher(env, "acme/widgets", 12345);
    expect(await fetcher.getFileContent("ok.ts", "sha7")).toBe("body");
    // The installation-token path failed → it fell back to the public token, not a Bearer install token.
    expect(sawAuth).toBe("Bearer ghp_public");
    fetchSpy.mockRestore();
  });

  it("REGRESSION (#regression-safe-propagation): attributes the public-token fallback (installation-token mint failed) to key_scope=\"public-token\", not a dropped/undefined admission key", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_public" });
    const key = githubRateLimitAdmissionKeyForPublicToken();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("body", {
        status: 200,
        headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-remaining": "17",
          "x-ratelimit-reset": String(Date.parse("2026-06-24T12:10:00.000Z") / 1000),
        },
      });
    });

    try {
      // No GitHub App key is configured, so createInstallationToken rejects and the fetcher falls back to the
      // public token -- before the fix, `admissionKey` was computed ONLY on the installationId branch (before
      // the fallback reassigns `token`), so this exact path left admissionKey undefined despite the request
      // actually authenticating with a perfectly nameable token.
      const fetcher = await makeGithubFileFetcher(env, "acme/widgets", 12345);
      expect(await fetcher.getFileContent("ok.ts", "sha7")).toBe("body");
      expect(latestGitHubRestRateLimitObservation(key)).toEqual({
        remaining: 17,
        resetAt: "2026-06-24T12:10:00.000Z",
        observedAtMs: Date.parse("2026-06-24T12:00:00.000Z"),
      });
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("uses installation-token contents reads and records admission telemetry when token mint succeeds", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "ghp_public" });
    const key = githubRateLimitAdmissionKeyForInstallation(12345);
    const tokenSpy = vi.spyOn(githubApp, "createInstallationToken").mockResolvedValue("install-token");
    let sawAuth: string | null = null;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      sawAuth = headers.get("authorization");
      return new Response("private body", {
        status: 200,
        headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-remaining": "22",
          "x-ratelimit-reset": String(Date.parse("2026-06-24T12:10:00.000Z") / 1000),
        },
      });
    });

    try {
      const fetcher = await makeGithubFileFetcher(env, "acme/widgets", 12345);
      expect(await fetcher.getFileContent("ok.ts", "sha7")).toBe("private body");
      expect(tokenSpy).toHaveBeenCalledWith(env, 12345);
      expect(sawAuth).toBe("Bearer install-token");
      expect(latestGitHubRestRateLimitObservation(key)).toEqual({
        remaining: 22,
        resetAt: "2026-06-24T12:10:00.000Z",
        observedAtMs: Date.parse("2026-06-24T12:00:00.000Z"),
      });
    } finally {
      fetchSpy.mockRestore();
      tokenSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

// ── getCachedGroundingFileContent / putCachedGroundingFileContent (#4499) ───────────────────────────

describe("grounding_file_content_cache repository helpers", () => {
  it("getCachedGroundingFileContent is a miss for a nullish head SHA, without touching the DB", async () => {
    const env = createTestEnv();
    expect(await getCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", null)).toBeNull();
    expect(await getCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", undefined)).toBeNull();
  });

  it("putCachedGroundingFileContent is a no-op for a nullish head SHA -- a later real-headSha read still misses", async () => {
    const env = createTestEnv();
    await putCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", null, "should not be stored");
    await putCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", undefined, "should not be stored either");
    expect(await getCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", "sha7")).toBeNull();
  });

  it("round-trips a genuinely stored value for a real (repo, path, head SHA), and a write overwrites an existing row for the SAME key", async () => {
    const env = createTestEnv();
    await putCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", "sha7", "export const a = 1;");
    expect(await getCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", "sha7")).toBe("export const a = 1;");
    await putCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", "sha7", "export const a = 2; // updated");
    expect(await getCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", "sha7")).toBe("export const a = 2; // updated");
  });

  // #7481-class fix: a real metagraphed registry file's cache row keyed by the branch name "main" (from
  // content-lane-wire.ts's base-content check, which has no true commit SHA to key on) sat stale on the ORB
  // server for over a week, since the literal string "main" never itself changes as the branch advances, so
  // the row was NEVER naturally invalidated. These pin the TTL safety net that now bounds that staleness for
  // ANY ref -- current callers or future ones -- instead of trusting every caller to only ever pass a genuine
  // immutable commit SHA.
  it("REGRESSION (#7481-class fix): a cache row older than the TTL reads as a miss, not a stale hit", async () => {
    const env = createTestEnv();
    await putCachedGroundingFileContent(env, "acme/widgets", "registry/subnets/foo.json", "main", "stale pre-merge content");
    const staleFetchedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago > the 24h TTL
    await env.DB.prepare(
      "UPDATE grounding_file_content_cache SET fetched_at = ? WHERE repo_full_name = ? AND path = ? AND head_sha = ?",
    )
      .bind(staleFetchedAt, "acme/widgets", "registry/subnets/foo.json", "main")
      .run();
    expect(await getCachedGroundingFileContent(env, "acme/widgets", "registry/subnets/foo.json", "main")).toBeNull();
  });

  it("a row just inside the TTL window still reads as a hit (the safety net doesn't defeat the cache's real purpose)", async () => {
    const env = createTestEnv();
    await putCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", "sha7", "still fresh");
    const recentFetchedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago, well under the 24h TTL
    await env.DB.prepare(
      "UPDATE grounding_file_content_cache SET fetched_at = ? WHERE repo_full_name = ? AND path = ? AND head_sha = ?",
    )
      .bind(recentFetchedAt, "acme/widgets", "src/a.ts", "sha7")
      .run();
    expect(await getCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", "sha7")).toBe("still fresh");
  });

  it("a malformed/unparseable fetched_at is treated as a miss rather than throwing", async () => {
    const env = createTestEnv();
    await putCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", "sha7", "content");
    await env.DB.prepare(
      "UPDATE grounding_file_content_cache SET fetched_at = ? WHERE repo_full_name = ? AND path = ? AND head_sha = ?",
    )
      .bind("not-a-real-timestamp", "acme/widgets", "src/a.ts", "sha7")
      .run();
    expect(await getCachedGroundingFileContent(env, "acme/widgets", "src/a.ts", "sha7")).toBeNull();
  });
});

// ── checkSummaryText empty fallback + outer-catch fail-safe ─────────────────────────────────────────

describe("buildCheckAggregate / buildReviewGroundingText edge branches", () => {
  it("a failing check with no usable output fields carries no summary (empty-text fallback)", () => {
    // payload has no output.title/summary and no description → checkSummaryText returns "".
    const agg = buildCheckAggregate([
      check({ name: "lint", conclusion: "failure", payload: {} as Record<string, JsonValue> }),
    ]);
    expect(agg?.state).toBe("failed");
    // No `summary` key attached when the failure reason text is empty.
    expect(agg?.failingDetails).toEqual([{ name: "lint" }]);
  });

  it("FLAG-ON outer fail-safe: a throw inside the build degrades to EMPTY_GROUNDING (never throws)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_GROUNDING: "true" });
    // A file record whose path getter throws makes toGroundingFiles throw inside the try → outer catch.
    const poison = { get path(): string { throw new Error("boom"); } } as unknown as PullRequestFileRecord;
    const out = await buildReviewGroundingText(env, {
      repoFullName: "acme/widgets",
      headSha: "sha7",
      files: [poison],
      checks: [check()],
      installationId: null,
    });
    expect(out).toEqual({ systemSuffix: "", promptSection: "" });
  });
});
