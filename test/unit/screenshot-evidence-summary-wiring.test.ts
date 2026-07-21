// #screenshot-vision-summary: end-to-end regression coverage for the reordering that threads
// screenshot-table-vision's plain-language evidence summary into the SAME pass's main AI review prompt.
// Unlike screenshot-table-vision.test.ts (pure parser unit tests) and screenshot-table-vision-wiring.test.ts
// (runScreenshotTableVisionForAdvisory in isolation), this file drives the FULL webhook pipeline
// (processJob -> maybePublishPrPublicSurface) so it actually exercises the reordering inside that
// (unexported) function -- the "bridge" between the two halves, not just each half tested independently.
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertInstallation, upsertRepositorySettings } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { processJob } from "../../src/queue/processors";
import { createTestEnv } from "../helpers/d1";

async function generatePrivateKeyPem(): Promise<string> {
  const key = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const base64 = Buffer.from(exported as ArrayBuffer).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}

const REPO_FULL_NAME = "JSONbored/gittensory";
const BEFORE_URL = "https://user-images.githubusercontent.com/vision-before.png";
const AFTER_URL = "https://user-images.githubusercontent.com/vision-after.png";

function prBodyWithTable(): string {
  return `Redesigns the nav bar per the linked issue.\n\n| Before | After |\n| --- | --- |\n| ![before](${BEFORE_URL}) | ![after](${AFTER_URL}) |\n\nCloses #1`;
}

/** Wires a full webhook pass with the screenshot-table gate ON (a genuine before/after table, so the
 *  deterministic gate never violates/closes) and AI review ON (advisory, single opinion, so exactly one
 *  `env.AI.run` call carries the main review's prompt) -- `aiReviewAllAuthors: true` unlocks self-host
 *  vision without needing a separate confirmed-miner-detection fixture. `visionResponse`/`reviewResponse`
 *  are the raw JSON text each mocked binding returns; `pull` lets each test use a distinct PR number/head so
 *  D1 rows never collide across tests in this file. */
async function runWebhookPass(args: {
  pull: number;
  headSha: string;
  visionResponse: string | null;
  reviewResponse: string;
}): Promise<{ visionRun: ReturnType<typeof vi.fn>; reviewRun: ReturnType<typeof vi.fn> }> {
  const visionRun = vi.fn(async () => (args.visionResponse === null ? { response: "" } : { response: args.visionResponse }));
  const reviewRun = vi.fn(async () => ({ response: args.reviewResponse }));
  const env = createTestEnv({
    GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem(),
    AI: { run: reviewRun } as unknown as Ai,
    AI_VISION: { run: visionRun } as unknown as Ai,
    AI_SUMMARIES_ENABLED: "true",
    AI_PUBLIC_COMMENTS_ENABLED: "true",
    AI_DAILY_NEURON_BUDGET: "100000",
  });
  await upsertInstallation(env, {
    installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" }, target_type: "User", repository_selection: "all", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
    repositories: [{ name: "gittensory", full_name: REPO_FULL_NAME, private: false, owner: { login: "JSONbored" } }],
  });
  await upsertRepositorySettings(env, { repoFullName: REPO_FULL_NAME });
  await upsertRepoFocusManifest(
    env,
    REPO_FULL_NAME,
    {
      settings: {
        commentMode: "all_prs",
        publicSurface: "comment_only",
        checkRunMode: "off",
        reviewCheckMode: "required",
        aiReviewMode: "advisory",
        aiReviewAllAuthors: true,
        screenshotTableGate: { enabled: true, whenLabels: [], whenPaths: [] },
      },
    },
    "repo_file",
  );
  const pullPath = `/pulls/${args.pull}`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url === "https://api.gittensor.io/miners") return Response.json([]);
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url === BEFORE_URL) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
      if (url === AFTER_URL) return new Response(new Uint8Array([4, 5, 6]), { status: 200, headers: { "content-type": "image/png" } });
      if (url.includes(`${pullPath}/files`)) return Response.json([{ filename: "apps/ui/src/nav.tsx", status: "modified", additions: 4, deletions: 1, changes: 5, patch: "@@\n+export const Nav = () => null;" }]);
      if (url.includes(`${pullPath}/reviews`)) return Response.json([]);
      if (url.includes(`${pullPath}/commits`)) return Response.json([]);
      if (url.endsWith(pullPath)) return Response.json({ number: args.pull, state: "open", user: { login: "nav-contributor" }, head: { sha: args.headSha }, mergeable_state: "clean" });
      if (url.includes(`/commits/${args.headSha}/check-runs`)) return Response.json({ total_count: 0, check_runs: [] });
      if (url.includes(`/commits/${args.headSha}/status`)) return Response.json({ state: "success", statuses: [] });
      if (url.includes("/branches/")) return Response.json({ protected: false, protection: { required_status_checks: { contexts: [] } } });
      if (url.includes(`/issues/${args.pull}/labels`)) return Response.json([]);
      if (url.includes(`/issues/${args.pull}/comments`)) return Response.json([]);
      return Response.json({});
    }),
  );

  await processJob(env, {
    type: "github-webhook",
    deliveryId: `screenshot-evidence-summary-${args.pull}`,
    eventName: "pull_request",
    payload: {
      action: "opened",
      installation: { id: 123, account: { login: "JSONbored", id: 1, type: "User" } },
      repository: { name: "gittensory", full_name: REPO_FULL_NAME, private: false, owner: { login: "JSONbored" } },
      pull_request: {
        number: args.pull,
        title: "Redesign the nav bar",
        state: "open",
        user: { login: "nav-contributor" },
        head: { sha: args.headSha },
        labels: [],
        body: prBodyWithTable(),
        mergeable_state: "clean",
        reviewDecision: "APPROVED",
      },
    },
  });

  return { visionRun, reviewRun };
}

function reviewPromptOf(reviewRun: ReturnType<typeof vi.fn>): { system: string; user: unknown } {
  const call = reviewRun.mock.calls[0] as unknown as [string, { messages?: Array<{ role: string; content: unknown }> }] | undefined;
  const messages = call?.[1]?.messages ?? [];
  const system = (messages.find((m) => m.role === "system")?.content as string | undefined) ?? "";
  const user = messages.find((m) => m.role === "user")?.content;
  return { system, user };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("screenshot-table-vision summary reaches the main AI review prompt (#screenshot-vision-summary)", () => {
  it("threads the vision pass's evidence summary into the SAME pass's AI review system prompt (the actual bridge)", async () => {
    const { visionRun, reviewRun } = await runWebhookPass({
      pull: 201,
      headSha: "nav-sha-201",
      visionResponse: JSON.stringify({
        findings: [],
        summary: "The after screenshot shows the nav bar moved to the right, which matches the PR's stated redesign.",
      }),
      reviewResponse: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [], confidence: 1 }),
    });

    // Exactly one vision call -- the SAME call produces both the (empty) findings and the summary, never a
    // second vision API call (#cost-architecture).
    expect(visionRun).toHaveBeenCalledTimes(1);
    expect(reviewRun).toHaveBeenCalledTimes(1);

    const { system } = reviewPromptOf(reviewRun);
    expect(system).toContain("SCREENSHOT EVIDENCE");
    expect(system).toContain("matches the PR's stated redesign");
  });

  it("reordering did not change any of runAiReviewForAdvisory's other existing inputs: title/diff/repo still reach the prompt untouched", async () => {
    const { reviewRun } = await runWebhookPass({
      pull: 202,
      headSha: "nav-sha-202",
      visionResponse: JSON.stringify({ findings: [], summary: "The after screenshot shows the redesigned nav bar." }),
      reviewResponse: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [], confidence: 1 }),
    });
    const { user } = reviewPromptOf(reviewRun);
    expect(typeof user).toBe("string");
    const userText = user as string;
    expect(userText).toContain(REPO_FULL_NAME);
    expect(userText).toContain("Redesign the nav bar");
    expect(userText).toContain("export const Nav");
  });

  it("the main review call NEVER receives image content blocks from the screenshot-table-vision path (text only, #cost-architecture)", async () => {
    const { reviewRun } = await runWebhookPass({
      pull: 203,
      headSha: "nav-sha-203",
      visionResponse: JSON.stringify({ findings: [], summary: "The after screenshot shows the redesigned nav bar." }),
      reviewResponse: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [], confidence: 1 }),
    });
    const call = reviewRun.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const options = call[1];
    // The user message content is a plain string (toContentBlocks only returns an array when images are
    // attached) -- a byte-shaped image payload would show up as an array of content blocks instead.
    const messages = (options.messages as Array<{ role: string; content: unknown }>) ?? [];
    for (const message of messages) {
      expect(Array.isArray(message.content)).toBe(false);
    }
    // Belt-and-suspenders: grep the ENTIRE serialized call args for any image-shaped payload.
    const serialized = JSON.stringify(options);
    expect(serialized).not.toContain('"type":"image"');
    expect(serialized).not.toContain("base64");
    expect(options.images).toBeUndefined();
  });

  it("fallback: when the vision pass produces no summary (empty response), the review runs with NO extra context -- byte-identical to no screenshot-table at all", async () => {
    const { reviewRun } = await runWebhookPass({
      pull: 204,
      headSha: "nav-sha-204",
      // A blank self-host response degrades to "no usable output" -- no findings, no summary.
      visionResponse: null,
      reviewResponse: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [], confidence: 1 }),
    });
    const { system } = reviewPromptOf(reviewRun);
    expect(system).not.toContain("SCREENSHOT EVIDENCE");
  });

  it("fallback: the AI review is never blocked or delayed by a vision failure (unparseable response)", async () => {
    const { reviewRun } = await runWebhookPass({
      pull: 205,
      headSha: "nav-sha-205",
      visionResponse: "not json, just prose",
      reviewResponse: JSON.stringify({ assessment: "Looks fine.", blockers: [], nits: [], suggestions: [], confidence: 1 }),
    });
    expect(reviewRun).toHaveBeenCalledTimes(1);
    const { system } = reviewPromptOf(reviewRun);
    expect(system).not.toContain("SCREENSHOT EVIDENCE");
  });
});
