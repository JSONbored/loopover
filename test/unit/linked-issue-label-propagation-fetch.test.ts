import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import * as appModule from "../../src/github/app";
import { fetchLinkedIssueLabelsForPropagation } from "../../src/review/linked-issue-label-propagation-fetch";

describe("fetchLinkedIssueLabelsForPropagation (#priority-linked-issue-gate)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(handler: (url: string, method: string) => Response | Promise<Response>) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => handler(input.toString(), init?.method ?? "GET"));
  }

  it("returns [] and fetches nothing when there are no linked issues", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({ env, repoFullName: "owner/repo", linkedIssues: [], installationId: 123 });
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the flattened labels for a single found linked issue", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1")) return Response.json({ number: 1, state: "open", labels: ["gittensor:priority", "help wanted"] });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({ env, repoFullName: "owner/repo", linkedIssues: [1], installationId: 123 });
    expect(result).toEqual(["gittensor:priority", "help wanted"]);
  });

  it("surfaces only the successful issue's labels when one of several linked issues fails to fetch (partial fail-open)", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      if (url.endsWith("/issues/1")) return Response.json({ number: 1, state: "open", labels: ["gittensor:priority"] });
      if (url.endsWith("/issues/2")) return new Response("server error", { status: 500 });
      return new Response("not found", { status: 404 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({ env, repoFullName: "owner/repo", linkedIssues: [1, 2], installationId: 123 });
    expect(result).toEqual(["gittensor:priority"]);
  });

  it("returns [] when every linked issue fails to fetch (fully fail-open — never applies a sensitive label without a verified source)", async () => {
    stubFetch((url) => {
      if (url.includes("/access_tokens")) return Response.json({ token: "installation-token" });
      return new Response("server error", { status: 500 });
    });
    const env = createTestEnv({});
    const result = await fetchLinkedIssueLabelsForPropagation({ env, repoFullName: "owner/repo", linkedIssues: [1, 2], installationId: 123 });
    expect(result).toEqual([]);
  });

  it("falls back to the public token and still fails open (never throws) when the installation-token mint fails", async () => {
    const spy = vi.spyOn(appModule, "createInstallationToken").mockRejectedValue(new Error("mint failed"));
    stubFetch((url) => (url.endsWith("/issues/1") ? Response.json({ number: 1, state: "open", labels: ["gittensor:priority"] }) : new Response("not found", { status: 404 })));
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    const result = await fetchLinkedIssueLabelsForPropagation({ env, repoFullName: "owner/repo", linkedIssues: [1], installationId: 123 });
    expect(result).toEqual(["gittensor:priority"]);
    spy.mockRestore();
  });
});
