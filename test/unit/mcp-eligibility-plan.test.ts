import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { upsertIssueFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

const FORBIDDEN_PUBLIC_LANGUAGE = /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|raw trust|trust score|reward estimate|farming|private reviewability|scoreability|private ranking/i;

const BASE_ARGS = {
  repoFullName: "octo/demo",
  sourceTokenScore: 60,
  totalTokenScore: 80,
  sourceLines: 50,
  credibility: 1,
  metadataOnly: true,
};

async function connect(env: Env = createTestEnv()) {
  await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-eligibility-plan-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type EligibilityPlanPayload = {
  eligible: boolean;
  linkedIssueStatus: string;
  branchEligibilityStatus: string;
  blockers: string[];
  cleanupPaths: string[];
  linkedIssueProjection: string | null;
  publicSummary: string;
};

async function callPlan(client: Client, arguments_: Record<string, unknown>): Promise<EligibilityPlanPayload> {
  const result = await client.callTool({ name: "loopover_get_eligibility_plan", arguments: arguments_ });
  expect(result.isError).toBeFalsy();
  const data = result.structuredContent as EligibilityPlanPayload;
  expect(JSON.stringify(data)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  return data;
}

describe("MCP loopover_get_eligibility_plan (#2222)", () => {
  it("returns an eligible maintainer-lane plan", async () => {
    const client = await connect();
    const plan = await callPlan(client, {
      ...BASE_ARGS,
      linkedIssueMode: "maintainer",
    });
    expect(plan.eligible).toBe(true);
    expect(plan.linkedIssueStatus).toBe("not_required");
    expect(plan.branchEligibilityStatus).toBe("not_required");
    expect(plan.blockers).toEqual([]);
    expect(typeof plan.publicSummary).toBe("string");
  });

  it("returns not_required statuses (and eligible:true) when linked-issue mode is none (#7809)", async () => {
    const client = await connect();
    const plan = await callPlan(client, {
      ...BASE_ARGS,
      linkedIssueMode: "none",
    });
    // eligible now agrees with the "not required" summary rather than contradicting it (#7809).
    expect(plan.eligible).toBe(true);
    expect(plan.linkedIssueStatus).toBe("not_required");
    expect(plan.branchEligibilityStatus).toBe("not_required");
    expect(plan.publicSummary).toMatch(/not required/i);
    expect(plan.linkedIssueProjection).toBeNull();
  });

  it("returns an ineligible-branch plan for confirmed ineligible branch metadata", async () => {
    const client = await connect();
    const plan = await callPlan(client, {
      ...BASE_ARGS,
      linkedIssueMode: "standard",
      linkedIssueContext: {
        status: "validated",
        source: "official_mirror",
        issueNumbers: [55],
        solvedByPullRequests: [56],
      },
      branchEligibility: {
        status: "ineligible",
        reason: "Base branch is not a registered registry branch.",
      },
    });
    expect(plan.eligible).toBe(false);
    expect(plan.branchEligibilityStatus).toBe("ineligible");
    expect(plan.blockers.join(" ")).toMatch(/eligible branch/i);
    expect(plan.cleanupPaths.join(" ")).toMatch(/eligible branch/i);
    expect(plan.publicSummary).toMatch(/branch blocker/i);
  });

  it("returns an unvalidated-linked-issue plan for raw issue context", async () => {
    const client = await connect();
    const plan = await callPlan(client, {
      ...BASE_ARGS,
      linkedIssueMode: "standard",
      linkedIssueContext: {
        status: "raw",
        source: "user_supplied",
        issueNumbers: [12],
      },
    });
    expect(plan.eligible).toBe(false);
    expect(plan.linkedIssueStatus).toBe("raw");
    expect(plan.branchEligibilityStatus).toBe("unknown");
    expect(plan.publicSummary).toMatch(/not yet validated/i);
    expect(plan.cleanupPaths.join(" ")).toMatch(/solved-by-PR|mirror/i);
  });

  it("uses contributor-scoped issue counts when contributorLogin is supplied", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "demo", full_name: "octo/demo", private: false, owner: { login: "octo" }, default_branch: "main" });
    for (const number of [1, 2, 3]) {
      await upsertIssueFromGitHub(env, "octo/demo", {
        number,
        title: `Open contributor issue ${number}`,
        state: "open",
        user: { login: "alice" },
        labels: [],
        body: "Issue body",
      });
    }
    const server = new LoopoverMcp(env).createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "loopover-eligibility-plan-contributor-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const plan = await callPlan(client, {
      ...BASE_ARGS,
      contributorLogin: "alice",
      linkedIssueMode: "none",
    });

    expect(plan.linkedIssueStatus).toBe("not_required");
    expect(plan.branchEligibilityStatus).toBe("not_required");
  });
});
