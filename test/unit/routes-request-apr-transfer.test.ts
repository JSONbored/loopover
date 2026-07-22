import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createInstallationToken } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

// #7742: POST /v1/loop/request-apr-transfer — customer-facing request-only APR transfer. Pins the ROUTE
// contract (status codes + body validation) against the real requestAprRepoTransfer wiring; GitHub is mocked.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  createInstallationToken: vi.fn(),
}));
const mockedToken = vi.mocked(createInstallationToken);

function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {}));
}

const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/loop/request-apr-transfer";

const validBody = {
  installationId: 42,
  repoFullName: "loopover-repos/widgets",
  newOwner: "customer-acct",
  ideaComplete: true,
};

const post = (env: Env, body: unknown) =>
  createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

describe("POST /v1/loop/request-apr-transfer (#7742)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockResolvedValue("ghs_installation_token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 202 with the initiated transfer when the gate passes and GitHub accepts", async () => {
    stubFetch(() => new Response(JSON.stringify({ full_name: "customer-acct/widgets" }), { status: 202 }));
    const response = await post(createTestEnv(), validBody);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: "initiated",
      transfer: { initiated: true, status: 202, newFullName: "customer-acct/widgets" },
    });
  });

  it("returns 409 without contacting GitHub when the idea is not complete", async () => {
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls += 1;
      return new Response("{}", { status: 202 });
    });
    const response = await post(createTestEnv(), { ...validBody, ideaComplete: false });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ status: "rejected", reason: "idea_not_complete" });
    expect(fetchCalls).toBe(0);
    expect(mockedToken).not.toHaveBeenCalled();
  });

  it("returns 502 when the gate passes but GitHub rejects the transfer", async () => {
    stubFetch(() => new Response("", { status: 403 }));
    const response = await post(createTestEnv(), validBody);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      status: "failed",
      transfer: { initiated: false, status: 403, error: "transfer request failed (403)" },
    });
  });

  it("rejects an invalid or unparseable body with 400 before any GitHub call", async () => {
    let fetchCalls = 0;
    stubFetch(() => {
      fetchCalls += 1;
      return new Response("{}", { status: 202 });
    });
    const env = createTestEnv();
    for (const body of [
      {},
      { ...validBody, installationId: 0 },
      { ...validBody, installationId: -1 },
      { ...validBody, repoFullName: "" },
      { ...validBody, newOwner: "" },
      { ...validBody, ideaComplete: "yes" },
      { installationId: 1, repoFullName: "a/b", newOwner: "c" }, // missing ideaComplete
    ]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request_apr_transfer_request" });
    }
    const malformed = await createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: "{not json" }, env);
    expect(malformed.status).toBe(400);
    expect(fetchCalls).toBe(0);
    expect(mockedToken).not.toHaveBeenCalled();
  });

  it("leaks no wallet/hotkey/trust-score terms", async () => {
    stubFetch(() => new Response(JSON.stringify({ full_name: "customer-acct/widgets" }), { status: 202 }));
    const text = JSON.stringify(await (await post(createTestEnv(), validBody)).json());
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score|reward/i);
  });
});
