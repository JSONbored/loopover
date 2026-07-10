import { describe, expect, it } from "vitest";
import { runIssueRagRetrieval, validateIssueRagInput } from "../../src/mcp/issue-rag";
import { emptyIssueRagTelemetry } from "../../src/review/issue-rag-retrieval";
import { createTestEnv } from "../helpers/d1";

describe("runIssueRagRetrieval (#4293)", () => {
  it("returns invalid_request for malformed input", async () => {
    const env = createTestEnv();
    await expect(runIssueRagRetrieval(env, { owner: "acme", repo: "demo", title: "" })).resolves.toMatchObject({
      status: "invalid_request",
      reason: "title_required",
    });
  });

  it("returns query_too_short when the composed query is below the retrieval floor", async () => {
    const env = createTestEnv();
    await expect(runIssueRagRetrieval(env, { owner: "acme", repo: "demo", title: "Tiny" })).resolves.toMatchObject({
      status: "query_too_short",
      repoFullName: "acme/demo",
      reason: "issue_query_below_retrieval_floor",
    });
  });

  it("rejects oversized repos and invalid labels", () => {
    expect(validateIssueRagInput({ owner: "acme", repo: "r".repeat(101), title: "Add observability context for self-hosted review planning failures" })).toMatchObject({
      ok: false,
      reason: "repo_too_long",
    });
    expect(
      validateIssueRagInput({
        owner: "acme",
        repo: "demo",
        title: "Add observability context for self-hosted review planning failures",
        labels: ["x".repeat(101)],
      }),
    ).toMatchObject({ ok: false, reason: "invalid_labels" });
  });

  it("covers validation branches for owner/title/body/labels/topK normalization", () => {
    expect(validateIssueRagInput({ owner: "", repo: "demo", title: "Add observability context for self-hosted review planning failures" })).toMatchObject({
      ok: false,
      reason: "owner_and_repo_required",
    });
    expect(
      validateIssueRagInput({
        owner: "acme",
        repo: "demo",
        title: "x".repeat(301),
      }),
    ).toMatchObject({ ok: false, reason: "title_too_long" });
    expect(
      validateIssueRagInput({
        owner: "acme",
        repo: "demo",
        title: "Add observability context for self-hosted review planning failures",
        body: "Body text for retrieval.",
        labels: [" ", "docs"],
        topK: 13,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_top_k" });
    expect(
      validateIssueRagInput({
        owner: "acme",
        repo: "demo",
        title: "Add observability context for self-hosted review planning failures",
        body: "Body text for retrieval.",
        labels: ["docs"],
        topK: 4,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        repoFullName: "acme/demo",
        body: "Body text for retrieval.",
        labels: ["docs"],
        topK: 4,
      },
    });
    expect(
      validateIssueRagInput({
        owner: "acme",
        repo: "demo",
        title: "Add observability context for self-hosted review planning failures",
        labels: [" ", ""],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        repoFullName: "acme/demo",
      },
    });
    expect(
      validateIssueRagInput({
        owner: 1 as unknown as string,
        repo: 2 as unknown as string,
        title: 3 as unknown as string,
      }),
    ).toMatchObject({ ok: false, reason: "owner_and_repo_required" });
  });

  it("returns ok with empty telemetry when retrieval finds no paths", async () => {
    const env = createTestEnv();
    await expect(
      runIssueRagRetrieval(env, {
        owner: "acme",
        repo: "demo",
        title: "Add observability context for self-hosted review planning failures",
      }),
    ).resolves.toMatchObject({
      status: "ok",
      repoFullName: "acme/demo",
      telemetry: emptyIssueRagTelemetry(),
    });
  });
});
