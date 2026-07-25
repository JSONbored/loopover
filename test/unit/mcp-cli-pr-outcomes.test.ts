// #6747: CLI + stdio mirrors for loopover_pr_outcome. The host MCP tool already existed; this pins the
// REST-backed stdio proxy and shell CLI against the same fixture payload.
// #8587: converted to in-process — the stdio proxy connects to the bin's exported `server` over an
// InMemoryTransport pair, and the CLI mirror calls the exported runCli with stdout captured. The fixture
// server starts once BEFORE the dynamic import (the bin reads LOOPOVER_API_URL at module load); per-test
// response overrides mutate `fixtureOptions`, which the harness reads per request. Only the exit-code /
// failure-envelope case still spawns a real subprocess.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TS5097: keep the .ts specifier out of a literal import() position (same indirection as the template).
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeFixtureServer,
  prOutcomesFixture,
  runExpectingFailure,
  startFixtureServer,
} from "./support/mcp-cli-harness";

type BinModule = {
  runCli: (args: string[]) => Promise<number | void>;
  server: { connect: (transport: unknown) => Promise<void> };
};

const capturedRequests: Array<{ url: string; method: string }> = [];
const fixtureOptions: NonNullable<Parameters<typeof startFixtureServer>[0]> = {
  onApiRequest: (request) => {
    if (request.url && request.url.includes("/pr-outcomes")) {
      capturedRequests.push({
        url: request.url ?? "",
        method: request.method ?? "GET",
      });
    }
  },
};
let mod: BinModule;
let apiUrl = "";
let configDir = "";

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-pr-outcomes-"));
  apiUrl = await startFixtureServer(fixtureOptions);
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_TOKEN = "session-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = configDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  mod = (await import(BIN_MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_TOKEN;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

beforeEach(() => {
  capturedRequests.length = 0;
});

afterEach(() => {
  delete fixtureOptions.prOutcomes;
});

async function connectClient() {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mod.server.connect(serverTransport);
  const client = new Client(
    { name: "pr-outcomes-test", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return client;
}

async function captureStdout(
  fn: () => Promise<number | void>,
): Promise<string> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

describe("loopover_pr_outcome stdio proxy (#6747)", () => {
  it("registers the tool in the stdio server tool list", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("loopover_pr_outcome");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("proxies login (+ optional limit) to GET /v1/contributors/:login/pr-outcomes", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "loopover_pr_outcome",
        arguments: { login: "JSONbored", limit: 10 },
      });
      expect(capturedRequests.length).toBe(1);
      const captured = capturedRequests[0]!;
      expect(captured.url).toContain("/v1/contributors/JSONbored/pr-outcomes");
      expect(captured.url).toContain("limit=10");
      expect(captured.method).toBe("GET");
      expect(result.isError).toBeFalsy();
      const text = JSON.stringify(result);
      expect(text).toContain("JSONbored/loopover");
      expect(text).toContain(prOutcomesFixture().summary);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe("loopover-mcp pr-outcomes CLI (#6747)", () => {
  it("--json emits exactly the payload the MCP tool surfaces for the same login (mirror parity)", async () => {
    const client = await connectClient();
    try {
      const viaTool = await client.callTool({
        name: "loopover_pr_outcome",
        arguments: { login: "JSONbored" },
      });
      const toolData = (viaTool as { structuredContent?: unknown })
        .structuredContent;
      const viaCli = JSON.parse(
        await captureStdout(() =>
          mod.runCli(["pr-outcomes", "--login", "JSONbored", "--json"]),
        ),
      );
      expect(viaCli).toEqual(prOutcomesFixture());
      if (toolData !== undefined) expect(viaCli).toEqual(toolData);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("prints the API summary and one line per outcome", async () => {
    const out = await captureStdout(() =>
      mod.runCli(["pr-outcomes", "--login", "JSONbored"]),
    );
    const fixture = prOutcomesFixture();
    expect(out).toContain(fixture.summary);
    expect(out).toContain("JSONbored/loopover#42 [merged]");
    expect(out).toContain(fixture.outcomes[0]!.attribution);
  });

  it("forwards --limit and resolves login from LOOPOVER_LOGIN / GITHUB_LOGIN", async () => {
    process.env.LOOPOVER_LOGIN = "JSONbored";
    try {
      await captureStdout(() =>
        mod.runCli(["pr-outcomes", "--json", "--limit", "5"]),
      );
    } finally {
      delete process.env.LOOPOVER_LOGIN;
    }
    expect(capturedRequests.at(-1)?.url).toContain("limit=5");

    process.env.GITHUB_LOGIN = "JSONbored";
    let viaGithubLogin = "";
    try {
      viaGithubLogin = await captureStdout(() =>
        mod.runCli(["pr-outcomes", "--json"]),
      );
    } finally {
      delete process.env.GITHUB_LOGIN;
    }
    expect(JSON.parse(viaGithubLogin)).toEqual(prOutcomesFixture());
  });

  it("fails when no login is resolvable or --limit is out of range", () => {
    const noLogin = runExpectingFailure(["pr-outcomes"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_LOGIN: "",
      GITHUB_LOGIN: "",
    });
    expect(noLogin.status).toBe(1);
    expect(`${noLogin.stdout}${noLogin.stderr}`).toMatch(
      /Pass --login <github-login> or set LOOPOVER_LOGIN\./,
    );

    const badLimit = runExpectingFailure(
      ["pr-outcomes", "--login", "JSONbored", "--limit", "0"],
      {
        LOOPOVER_API_URL: apiUrl,
        LOOPOVER_TOKEN: "session-token",
      },
    );
    expect(badLimit.status).toBe(1);
    expect(`${badLimit.stdout}${badLimit.stderr}`).toMatch(
      /integer between 1 and 100/,
    );

    const bareLimit = runExpectingFailure(
      ["pr-outcomes", "--login", "JSONbored", "--limit", "101"],
      {
        LOOPOVER_API_URL: apiUrl,
        LOOPOVER_TOKEN: "session-token",
      },
    );
    expect(bareLimit.status).toBe(1);
  });

  it("falls back when the API omits summary and prints null pull numbers / empty attributions", async () => {
    fixtureOptions.prOutcomes = {
      summary: "   ",
      outcomes: [
        {
          repoFullName: "a/b",
          pullNumber: null,
          outcome: "merged",
          attribution: "",
          deeplink: "https://x",
          recordedAt: "t",
        },
      ],
    };
    const plain = await captureStdout(() =>
      mod.runCli(["pr-outcomes", "--login", "JSONbored"]),
    );
    expect(plain).toContain("LoopOver post-merge outcomes for JSONbored.");
    expect(plain).toContain("a/b#? [merged]");
  });

  it("strips ANSI escapes from API-chosen text on the plain-text path but not from --json", async () => {
    fixtureOptions.prOutcomes = {
      summary: "\u001b[31mFAKE PASS\u001b[0m",
      outcomes: [
        {
          repoFullName: "a/b",
          pullNumber: 1,
          outcome: "merged",
          attribution: "\u001b[2Krewritten",
          deeplink: "https://x",
          recordedAt: "t",
        },
      ],
    };

    const plain = await captureStdout(() =>
      mod.runCli(["pr-outcomes", "--login", "JSONbored"]),
    );
    expect(plain).not.toContain("\u001b");
    expect(plain).toContain("FAKE PASS");
    expect(plain).toContain("rewritten");

    const asJson = await captureStdout(() =>
      mod.runCli(["pr-outcomes", "--login", "JSONbored", "--json"]),
    );
    expect(JSON.parse(asJson).summary).toBe("\u001b[31mFAKE PASS\u001b[0m");
  });

  it("ignores a bare --limit flag (no value) and still returns outcomes", async () => {
    const out = await captureStdout(() =>
      mod.runCli(["pr-outcomes", "--login", "JSONbored", "--limit", "--json"]),
    );
    expect(JSON.parse(out)).toEqual(prOutcomesFixture());
    expect(capturedRequests.at(-1)?.url).not.toContain("limit=");
  });

  it("documents itself in --help and in the shell-completion command list", async () => {
    expect(await captureStdout(() => mod.runCli(["--help"]))).toContain(
      "loopover-mcp pr-outcomes --login <github-login> [--limit N] [--json]",
    );
    expect(
      await captureStdout(() => mod.runCli(["pr-outcomes", "--help"])),
    ).toContain("Mirrors the loopover_pr_outcome MCP tool");
    expect(
      await captureStdout(() => mod.runCli(["completion", "bash"])),
    ).toContain("pr-outcomes");
  });
});
