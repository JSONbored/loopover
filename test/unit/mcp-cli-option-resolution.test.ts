// How the stdio CLI resolves an option's value, on both sides of every fallback (#9773).
//
// Typing `parseOptions` from `CLI_FLAG_SPEC` turned a pile of `any` reads into explicit chains -- the flag,
// then the profile session, then the env -- and a chain is only correct if each step is exercised. These
// drive the real dispatcher in-process (the #8587 pattern), because the subprocess harness the rest of the
// CLI suite uses runs the compiled `dist/`, which v8 cannot instrument: a path covered only there reads as
// uncovered, which is how a regression in one of these arms would land unnoticed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

type BinModule = {
  runCli: (args: string[]) => Promise<number | void>;
  server: Parameters<Client["connect"]>[0] extends never ? never : { connect: (transport: unknown) => Promise<void> };
};

const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

let configDir = "";
let mod: BinModule;

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-option-resolution-"));
  const apiUrl = await startFixtureServer();
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_NPM_REGISTRY_URL = apiUrl;
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = configDir;
  mod = (await import(BIN_MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  for (const key of ["LOOPOVER_API_URL", "LOOPOVER_NPM_REGISTRY_URL", "LOOPOVER_API_TIMEOUT_MS", "LOOPOVER_CONFIG_DIR"]) delete process.env[key];
});

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Run with `fetch` stubbed; return every request the CLI made, so the RESOLVED value is observable. */
async function capture(args: string[], env: Record<string, string | undefined> = {}): Promise<Array<{ url: string; body: unknown }>> {
  const requests: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: string }) => {
      requests.push({ url: String(input), body: init?.body ? (JSON.parse(init.body) as unknown) : undefined });
      return new Response(JSON.stringify({ audit: [], events: [], overall: {}, findings: [], run: { status: "queued" }, actions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await withEnv({ LOOPOVER_TOKEN: "session-token", LOOPOVER_SKIP_NPM_VERSION_CHECK: "true", ...env }, () => mod.runCli(args)).catch(() => undefined);
  } finally {
    stdout.mockRestore();
    vi.unstubAllGlobals();
  }
  return requests;
}

const NO_LOGIN_ENV = { LOOPOVER_LOGIN: undefined, GITHUB_LOGIN: undefined };

describe("the login chain, one step at a time (#9773)", () => {
  it("prefers the flag", async () => {
    const [request] = await capture(["contributor-profile", "--login", "from-flag", "--json"], { ...NO_LOGIN_ENV });
    expect(request?.url).toContain("/from-flag/");
  });

  it("falls through to LOOPOVER_LOGIN when the flag is absent", async () => {
    const [request] = await capture(["contributor-profile", "--json"], { ...NO_LOGIN_ENV, LOOPOVER_LOGIN: "from-loopover-env" });
    expect(request?.url).toContain("/from-loopover-env/");
  });

  it("falls through again to GITHUB_LOGIN", async () => {
    const [request] = await capture(["contributor-profile", "--json"], { ...NO_LOGIN_ENV, GITHUB_LOGIN: "from-github-env" });
    expect(request?.url).toContain("/from-github-env/");
  });

  it("reports the usage error when every step is empty", async () => {
    await expect(
      withEnv({ LOOPOVER_TOKEN: "session-token", ...NO_LOGIN_ENV }, () => Promise.resolve(mod.runCli(["contributor-profile", "--json"]))),
    ).rejects.toThrow(/--login/);
  });

  it("treats a bare --login as absent on a command with no profile leg", async () => {
    // `explain-repo-decision` resolves flag -> env only. A valueless flag must not become the login "true".
    const [request] = await capture(["repo-decision", "--login", "--repo", "owner/repo"], { ...NO_LOGIN_ENV, LOOPOVER_LOGIN: "env-login" });
    expect(request?.url ?? "").not.toContain("login=true");
    expect(request?.url ?? "").toContain("env-login");
  });
});

describe("a --body-file / --file option, present and absent (#9773)", () => {
  it("reads the file when the flag carries a path", async () => {
    const bodyPath = join(configDir, "body.md");
    writeFileSync(bodyPath, "body from disk");
    const [request] = await capture(["review-pr", "--login", "acme", "--repo", "owner/repo", "--pull", "1", "--body-file", bodyPath]);
    expect(JSON.stringify(request?.body)).toContain("body from disk");
  });

  it("keeps the inline --body when no --body-file is given", async () => {
    const [request] = await capture(["review-pr", "--login", "acme", "--repo", "owner/repo", "--pull", "1", "--body", "inline body"]);
    expect(JSON.stringify(request?.body)).toContain("inline body");
  });

  it("leaves the inline --body alone when --body-file carries no value", async () => {
    // Was `readCliTextFile(optionText(...) ?? "", ...)`, i.e. a read of the path "" -- an ENOENT crash
    // where the user had simply typed the flag without a path.
    const [request] = await capture(["review-pr", "--login", "acme", "--repo", "owner/repo", "--pull", "1", "--body", "inline body", "--body-file"]);
    expect(JSON.stringify(request?.body)).toContain("inline body");
  });

  it("reads --body-file for lint-pr-text and check-issue-slop, and leaves --body alone without it", async () => {
    // The same pair of arms in two more commands. Both used to read the path "" for a valueless flag.
    const filePath = join(configDir, "shared-body.md");
    writeFileSync(filePath, "text from disk");
    for (const args of [
      ["lint-pr-text", "--title", "t", "--body-file", filePath],
      ["issue-slop", "--title", "t", "--body-file", filePath],
    ]) {
      const [request] = await capture(args);
      expect(JSON.stringify(request?.body), args[0]).toContain("text from disk");
    }
    for (const args of [
      ["lint-pr-text", "--title", "t", "--body", "inline", "--body-file"],
      ["issue-slop", "--title", "t", "--body", "inline", "--body-file"],
    ]) {
      const [request] = await capture(args);
      expect(JSON.stringify(request?.body), args[0]).toContain("inline");
    }
  });

  it("reports the usage error when validate-config's --file carries no value", async () => {
    // `!options.file` let a valueless flag through -- `true` is truthy -- and the manifest was read from
    // the path "". Absent and valueless are the same thing to the person typing it.
    await expect(Promise.resolve(mod.runCli(["validate-config", "--file"]))).rejects.toThrow(/--file/);
  });
});

describe("the usage errors a valueless flag must produce (#9773)", () => {
  it("names --source when validate-config is given one the schema does not accept", async () => {
    const manifestPath = join(configDir, "manifest.json");
    writeFileSync(manifestPath, "{}");
    await expect(Promise.resolve(mod.runCli(["validate-config", "--file", manifestPath, "--source", "invented"]))).rejects.toThrow(/--source must be one of/);
  });

  it("names --title when explain-review-risk is given a valueless one", async () => {
    await expect(Promise.resolve(mod.runCli(["explain-review-risk", "--repo", "owner/repo", "--title"]))).rejects.toThrow(/--title/);
  });

  it("names --repo when repo-decision is given a valueless one", async () => {
    // `typeof repoFullName !== "string"` is the arm a bare `--repo` takes: it parses to `true`, which would
    // otherwise reach `.includes` and throw a TypeError instead of the usage error.
    await expect(
      withEnv({ LOOPOVER_TOKEN: "session-token", LOOPOVER_LOGIN: "acme" }, () => Promise.resolve(mod.runCli(["repo-decision", "--repo"]))),
    ).rejects.toThrow(/--repo owner\/repo/);
  });

  it("uses --body as the slop-risk description when --description is absent", async () => {
    const [request] = await capture(["slop-risk", "--title", "t", "--body", "from body flag"]);
    expect(JSON.stringify(request?.body)).toContain("from body flag");
  });
});

describe("--issue, however it is supplied (#9773)", () => {
  it("accepts a single occurrence", async () => {
    const [request] = await capture(["preflight", "--login", "acme", "--repo", "owner/repo", "--title", "t", "--issue", "7"]);
    expect((request?.body as { linkedIssues?: number[] })?.linkedIssues).toContain(7);
  });

  it("accepts repeated occurrences", async () => {
    const [request] = await capture(["preflight", "--login", "acme", "--repo", "owner/repo", "--title", "t", "--issue", "7", "--issue", "9"]);
    expect((request?.body as { linkedIssues?: number[] })?.linkedIssues).toEqual(expect.arrayContaining([7, 9]));
  });

  it("accepts repeated inline `--issue=N`", async () => {
    const [request] = await capture(["preflight", "--login", "acme", "--repo", "owner/repo", "--title", "t", "--issue=7", "--issue=9"]);
    expect((request?.body as { linkedIssues?: number[] })?.linkedIssues).toEqual(expect.arrayContaining([7, 9]));
  });

  it("contributes nothing when the value is not a positive integer", async () => {
    const [request] = await capture(["preflight", "--login", "acme", "--repo", "owner/repo", "--title", "t", "--issue", "not-a-number"]);
    expect((request?.body as { linkedIssues?: number[] })?.linkedIssues ?? []).not.toContain(Number.NaN);
  });
});

describe("a run id from the positional or the flag (#9773)", () => {
  it("takes the positional argument", async () => {
    const [request] = await capture(["agent", "status", "run-from-positional"]);
    expect(request?.url).toContain("run-from-positional");
  });

  it("falls back to --run-id, and treats a bare one as absent", async () => {
    const [request] = await capture(["agent", "explain", "--run-id", "run-from-flag"]);
    expect(request?.url).toContain("run-from-flag");
    await expect(Promise.resolve(mod.runCli(["agent", "status", "--run-id"]))).rejects.toThrow(/run-id/);
  });
});

describe("--branch-eligibility, parsed against the route's own schema (#9773)", () => {
  it("keeps a source the schema declares", async () => {
    const [request] = await capture([
      "preflight", "--login", "acme", "--repo", "owner/repo", "--title", "t",
      "--branch-eligibility", "ineligible", "--branch-eligibility-source", "registry",
    ]);
    expect((request?.body as { branchEligibility?: { source?: string } })?.branchEligibility?.source).toBe("registry");
  });

  it("falls back to user_supplied for a source the schema does not declare", async () => {
    const [request] = await capture([
      "preflight", "--login", "acme", "--repo", "owner/repo", "--title", "t",
      "--branch-eligibility", "ineligible", "--branch-eligibility-source", "invented",
    ]);
    expect((request?.body as { branchEligibility?: { source?: string } })?.branchEligibility?.source).toBe("user_supplied");
  });

  it("drops the whole block when the status is not one the schema accepts", async () => {
    const [request] = await capture(["preflight", "--login", "acme", "--repo", "owner/repo", "--title", "t", "--branch-eligibility", "maybe"]);
    expect((request?.body as { branchEligibility?: unknown })?.branchEligibility).toBeUndefined();
  });
});

describe("a stdio tool's optional list fields (#9773)", () => {
  /** The stdio server in-process, so a tool handler's own branches are exercised where v8 can see them. */
  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "option-resolution", version: "0.0.0" });
    await Promise.all([(mod.server as { connect: (t: unknown) => Promise<void> }).connect(serverTransport), client.connect(clientTransport)]);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  it("sends changedFiles only when changedPaths was supplied", async () => {
    const requests: Array<{ body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: { body?: string }) => {
        requests.push({ body: init?.body ? (JSON.parse(init.body) as unknown) : undefined });
        return new Response(JSON.stringify({ verdict: "pass", findings: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const savedToken = process.env.LOOPOVER_TOKEN;
    process.env.LOOPOVER_TOKEN = "session-token";
    try {
      void (await callTool("loopover_predict_gate", { login: "acme", owner: "owner", repo: "repo", title: "t", changedPaths: ["src/a.ts"] }));
      void (await callTool("loopover_predict_gate", { login: "acme", owner: "owner", repo: "repo", title: "t" }));
      // The same pair of arms in the sibling handler.
      void (await callTool("loopover_explain_gate_disposition", { login: "acme", owner: "owner", repo: "repo", title: "t", changedPaths: ["src/b.ts"] }));
      void (await callTool("loopover_explain_gate_disposition", { login: "acme", owner: "owner", repo: "repo", title: "t" }));
    } finally {
      vi.unstubAllGlobals();
      if (savedToken === undefined) delete process.env.LOOPOVER_TOKEN;
      else process.env.LOOPOVER_TOKEN = savedToken;
    }
    // The request reaching the stub at all is the assertion that the handler ran; what the stub answers
    // with is not this test's subject.
    expect(requests).toHaveLength(4);
    expect((requests[0]?.body as { changedFiles?: unknown })?.changedFiles).toEqual([{ path: "src/a.ts" }]);
    expect((requests[1]?.body as { changedFiles?: unknown })?.changedFiles).toBeUndefined();
    expect((requests[2]?.body as { changedFiles?: unknown })?.changedFiles).toEqual([{ path: "src/b.ts" }]);
    expect((requests[3]?.body as { changedFiles?: unknown })?.changedFiles).toBeUndefined();
  });
});
