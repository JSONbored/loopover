import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-plan-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type PlanView = {
  plan: { steps: Array<{ id: string; status: string; attempts: number }> };
  progress: { status: string; total: number; completed: number };
  readySteps: Array<{ id: string }>;
  validation: { valid: boolean; errors: string[] };
};

describe("MCP plan DAG tools (#783)", () => {
  it("build_plan → record_step_result drives a multi-step plan to completion (stateless, plan passed back)", async () => {
    const client = await connect();
    const built = await client.callTool({
      name: "gittensory_build_plan",
      arguments: {
        steps: [
          { id: "a", title: "close stale PR" },
          { id: "b", title: "land PR 2", dependsOn: ["a"] },
        ],
      },
    });
    expect(built.isError).toBeFalsy();
    let view = built.structuredContent as PlanView;
    expect(view.validation).toEqual({ valid: true, errors: [] });
    expect(view.progress.status).toBe("pending");
    expect(view.readySteps.map((s) => s.id)).toEqual(["a"]); // only the root is ready

    const afterA = await client.callTool({ name: "gittensory_record_step_result", arguments: { plan: view.plan, stepId: "a", outcome: "completed" } });
    view = afterA.structuredContent as PlanView;
    expect(view.readySteps.map((s) => s.id)).toEqual(["b"]); // b unblocked
    expect(view.progress).toMatchObject({ status: "pending", completed: 1 }); // b ready but not yet running

    const afterB = await client.callTool({ name: "gittensory_record_step_result", arguments: { plan: view.plan, stepId: "b", outcome: "completed" } });
    view = afterB.structuredContent as PlanView;
    expect(view.progress).toMatchObject({ status: "completed", completed: 2, total: 2 });
  });

  it("plan_status surfaces validation errors for a bad DAG without throwing", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "gittensory_plan_status",
      arguments: { plan: { steps: [{ id: "a", title: "A", dependsOn: ["ghost"], status: "pending", attempts: 0, maxAttempts: 1 }] } },
    });
    const view = result.structuredContent as PlanView;
    expect(view.validation.valid).toBe(false);
    expect(view.validation.errors.join(" ")).toMatch(/unknown step ghost/);
  });

  it("record_step_result retries a failed step until maxAttempts", async () => {
    const client = await connect();
    const plan = { steps: [{ id: "a", title: "A", dependsOn: [], status: "pending", attempts: 0, maxAttempts: 2 }] };
    const first = (await client.callTool({ name: "gittensory_record_step_result", arguments: { plan, stepId: "a", outcome: "failed", error: "boom" } })).structuredContent as PlanView;
    expect(first.plan.steps[0]).toMatchObject({ status: "pending", attempts: 1 }); // retry
    const second = (await client.callTool({ name: "gittensory_record_step_result", arguments: { plan: first.plan, stepId: "a", outcome: "failed" } })).structuredContent as PlanView;
    expect(second.plan.steps[0]).toMatchObject({ status: "failed", attempts: 2 });
    expect(second.progress.status).toBe("failed");
  });
  it("record_step_result preserves terminal step status", async () => {
    const client = await connect();
    const plan = {
      steps: [
        { id: "a", title: "A", dependsOn: [], status: "failed", attempts: 1, maxAttempts: 1, lastError: "boom" },
        { id: "b", title: "B", dependsOn: ["a"], status: "pending", attempts: 0, maxAttempts: 1 },
      ],
    };

    const result = (await client.callTool({ name: "gittensory_record_step_result", arguments: { plan, stepId: "a", outcome: "completed" } })).structuredContent as PlanView;

    expect(result.plan.steps[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(result.progress.status).toBe("failed");
    expect(result.readySteps).toEqual([]);
  });

});
