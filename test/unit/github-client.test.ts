import { afterEach, describe, expect, it, vi } from "vitest";
import { forcedSelfhostMode, makeInstallationOctokit, resolveRepoActionMode, timeoutFetch } from "../../src/github/client";
import { setGlobalAgentFrozen } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

type RecordedCall = { url: string; method: string };

function stubFetchRecording(calls: RecordedCall[], body: unknown = { id: 5 }): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase() });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("makeInstallationOctokit", () => {
  it("live mode lets a write reach GitHub (no suppression hook)", async () => {
    const calls: RecordedCall[] = [];
    stubFetchRecording(calls);
    const octokit = makeInstallationOctokit(createTestEnv(), "tok", "live");
    const r = await octokit.request("POST /repos/{owner}/{repo}/check-runs", { owner: "o", repo: "r", name: "Gate", head_sha: "abc" });
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/check-runs"))).toBe(true);
    expect((r.data as unknown as { id: number }).id).toBe(5); // the real (stubbed) response, not the synthetic
  });

  it("dry_run mode suppresses a write: no fetch, synthetic check-run id -1, and an audit row", async () => {
    const calls: RecordedCall[] = [];
    stubFetchRecording(calls);
    const env = createTestEnv();
    const octokit = makeInstallationOctokit(env, "tok", "dry_run");
    const r = await octokit.request("POST /repos/{owner}/{repo}/check-runs", { owner: "o", repo: "r", name: "Gate", head_sha: "abc" });
    expect(calls.some((c) => c.method === "POST")).toBe(false); // the write never reached the network
    expect((r.data as unknown as { id: number; dryRunSuppressed: boolean }).id).toBe(-1); // truthy AND !== undefined
    expect((r.data as unknown as { dryRunSuppressed: boolean }).dryRunSuppressed).toBe(true);
    const audit = await env.DB.prepare("SELECT outcome, detail FROM audit_events WHERE event_type = ?").bind("github.write.suppressed").first<{ outcome: string; detail: string }>();
    expect(audit?.outcome).toBe("completed"); // dry_run audits as completed-shadow
    expect(audit?.detail).toContain("suppressed POST");
  });

  it("paused mode also suppresses writes and audits them as denied", async () => {
    const calls: RecordedCall[] = [];
    stubFetchRecording(calls);
    const env = createTestEnv();
    const octokit = makeInstallationOctokit(env, "tok", "paused");
    await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { owner: "o", repo: "r", issue_number: 1, name: "x" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const audit = await env.DB.prepare("SELECT outcome FROM audit_events WHERE event_type = ?").bind("github.write.suppressed").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("denied"); // paused audits as denied
  });

  it("dry_run mode lets a GET read pass through to GitHub", async () => {
    const calls: RecordedCall[] = [];
    stubFetchRecording(calls, [{ name: "existing" }]);
    const octokit = makeInstallationOctokit(createTestEnv(), "tok", "dry_run");
    await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/labels", { owner: "o", repo: "r", issue_number: 1 });
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/labels"))).toBe(true);
  });

  it("returns a route-shaped synthetic response for each suppressed write route", async () => {
    const octokit = makeInstallationOctokit(createTestEnv(), "tok", "dry_run");
    stubFetchRecording([]); // any network hit would be a bug; suppression returns before fetch

    const review = await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner: "o", repo: "r", pull_number: 1, event: "COMMENT" });
    expect((review.data as unknown as { id: number }).id).toBe(-1);

    const merge = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", { owner: "o", repo: "r", pull_number: 1 });
    expect(merge.data as unknown as { merged: boolean; sha: null }).toMatchObject({ merged: true, sha: null });

    const comment = await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", { owner: "o", repo: "r", comment_id: 7, body: "x" });
    expect(comment.data as unknown as { id: number; html_url: string }).toMatchObject({ id: -1, html_url: "" });

    const label = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { owner: "o", repo: "r", issue_number: 1, labels: ["x"] });
    expect((label.data as unknown as { dryRunSuppressed: boolean; id?: number }).dryRunSuppressed).toBe(true);
    expect((label.data as unknown as { id?: number }).id).toBeUndefined(); // the default route carries no id
  });
});

describe("forcedSelfhostMode (instance-wide self-host kill switch)", () => {
  it("maps SELFHOST_DEPLOYMENT_MODE to a forced action mode (else null)", () => {
    expect(forcedSelfhostMode({ SELFHOST_DEPLOYMENT_MODE: "dry-run" })).toBe("dry_run");
    expect(forcedSelfhostMode({ SELFHOST_DEPLOYMENT_MODE: "dry_run" })).toBe("dry_run"); // underscore variant
    expect(forcedSelfhostMode({ SELFHOST_DEPLOYMENT_MODE: "DISABLED" })).toBe("paused"); // case-insensitive
    expect(forcedSelfhostMode({ SELFHOST_DEPLOYMENT_MODE: "live" })).toBeNull();
    expect(forcedSelfhostMode({})).toBeNull();
  });

  it("forces suppression for the WHOLE instance even when the caller passes mode=live", async () => {
    const calls: RecordedCall[] = [];
    stubFetchRecording(calls);
    const env = { ...createTestEnv(), SELFHOST_DEPLOYMENT_MODE: "dry-run" };
    const octokit = makeInstallationOctokit(env, "tok", "live"); // a LIVE caller…
    const r = await octokit.request("POST /repos/{owner}/{repo}/check-runs", { owner: "o", repo: "r", name: "Gate", head_sha: "abc" });
    expect(calls.some((c) => c.method === "POST")).toBe(false); // …but the instance switch suppresses it anyway
    expect((r.data as unknown as { id: number }).id).toBe(-1);
  });

  it("'disabled' forces suppression audited as denied (vs dry-run's completed-shadow)", async () => {
    stubFetchRecording([]);
    const env = { ...createTestEnv(), SELFHOST_DEPLOYMENT_MODE: "disabled" };
    const octokit = makeInstallationOctokit(env, "tok", "live");
    await octokit.request("POST /repos/{owner}/{repo}/check-runs", { owner: "o", repo: "r", name: "Gate", head_sha: "abc" });
    const audit = await env.DB.prepare("SELECT outcome FROM audit_events WHERE event_type = ?").bind("github.write.suppressed").first<{ outcome: string }>();
    expect(audit?.outcome).toBe("denied");
  });
});

describe("resolveRepoActionMode", () => {
  it("maps the env brake, DB freeze, per-repo pause and dry-run to the same modes the executor uses", async () => {
    const env = createTestEnv();
    expect(await resolveRepoActionMode(env, { agentPaused: false, agentDryRun: false })).toBe("live");
    expect(await resolveRepoActionMode(env, { agentPaused: false, agentDryRun: true })).toBe("dry_run");
    expect(await resolveRepoActionMode(env, { agentPaused: true, agentDryRun: false })).toBe("paused");
    expect(await resolveRepoActionMode(env, null)).toBe("live"); // nullish settings → live

    expect(await resolveRepoActionMode({ ...env, AGENT_ACTIONS_PAUSED: "true" }, { agentPaused: false, agentDryRun: true })).toBe("paused"); // env brake wins

    await setGlobalAgentFrozen(env, true);
    expect(await resolveRepoActionMode(env, { agentPaused: false, agentDryRun: false })).toBe("paused"); // DB freeze wins
  });
});

describe("timeoutFetch", () => {
  it("passes an explicit caller signal straight through", async () => {
    const seen: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init);
      return new Response("ok");
    });
    const controller = new AbortController();
    await timeoutFetch("https://example.test", { signal: controller.signal });
    expect(seen[0]?.signal).toBe(controller.signal);
  });

  it("injects an AbortSignal timeout when the caller gives none", async () => {
    let injected: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_i: RequestInfo | URL, init?: RequestInit) => {
      injected = init?.signal ?? undefined;
      return new Response("ok");
    });
    await timeoutFetch("https://example.test");
    expect(injected).toBeInstanceOf(AbortSignal);
  });
});
