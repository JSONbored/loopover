// #6732: the CLI mirror for loopover_monitor_open_prs. The MCP tool and GET
// /v1/contributors/:login/open-pr-monitor already served this; only the stdio/CLI surface was missing.
// These pin the three things that can silently rot: the tool is registered, both surfaces hit the same
// route, and `monitor-open-prs --json` stays byte-identical to what the tool returns for one input.
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
  openPrMonitorFixture,
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
    if (request.url && request.url.includes("/open-pr-monitor")) {
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
  configDir = mkdtempSync(join(tmpdir(), "loopover-monitor-open-prs-"));
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
  delete fixtureOptions.openPrMonitor;
});

async function connectClient() {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mod.server.connect(serverTransport);
  const client = new Client(
    { name: "monitor-open-prs-test", version: "0.0.1" },
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

describe("loopover_monitor_open_prs stdio proxy", () => {
  it("registers the tool in the stdio server tool list", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("loopover_monitor_open_prs");
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("proxies login to /v1/contributors/:login/open-pr-monitor via apiGet and returns the monitor", async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: "loopover_monitor_open_prs",
        arguments: { login: "JSONbored" },
      });
      expect(capturedRequests.length).toBe(1);
      const captured = capturedRequests[0]!;
      expect(captured.url).toContain(
        "/v1/contributors/JSONbored/open-pr-monitor",
      );
      expect(captured.method).toBe("GET");
      expect(result.isError).toBeFalsy();
      const text = JSON.stringify(result);
      expect(text).toContain("JSONbored/loopover");
      expect(text).toContain("failing_checks");
      // The tool summary is the API's own sentence, not a second one invented client-side.
      expect(text).toContain(openPrMonitorFixture().summary);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe("loopover-mcp monitor-open-prs CLI", () => {
  it("--json emits exactly the payload the MCP tool surfaces for the same login (mirror parity)", async () => {
    const client = await connectClient();
    try {
      const viaTool = await client.callTool({
        name: "loopover_monitor_open_prs",
        arguments: { login: "JSONbored" },
      });
      const toolData = (viaTool as { structuredContent?: unknown })
        .structuredContent;
      const viaCli = JSON.parse(
        await captureStdout(() =>
          mod.runCli(["monitor-open-prs", "--login", "JSONbored", "--json"]),
        ),
      );
      expect(viaCli).toEqual(openPrMonitorFixture());
      if (toolData !== undefined) expect(viaCli).toEqual(toolData);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("prints the API summary, guidance, and a next-step line per open PR", async () => {
    const out = await captureStdout(() =>
      mod.runCli(["monitor-open-prs", "--login", "JSONbored"]),
    );
    const fixture = openPrMonitorFixture();
    expect(out).toContain(fixture.summary);
    expect(out).toContain(fixture.guidance[0]!);
    expect(out).toContain(
      "JSONbored/loopover#42 [failing_checks] fix(queue): drain stale entries",
    );
    expect(out).toContain("  - Fix the failing check, then push.");
  });

  it("resolves the login from LOOPOVER_LOGIN, then GITHUB_LOGIN, the way decision-pack does", async () => {
    process.env.LOOPOVER_LOGIN = "JSONbored";
    let viaLoopoverLogin = "";
    try {
      viaLoopoverLogin = await captureStdout(() =>
        mod.runCli(["monitor-open-prs", "--json"]),
      );
    } finally {
      delete process.env.LOOPOVER_LOGIN;
    }
    expect(JSON.parse(viaLoopoverLogin)).toEqual(openPrMonitorFixture());

    process.env.GITHUB_LOGIN = "JSONbored";
    let viaGithubLogin = "";
    try {
      viaGithubLogin = await captureStdout(() =>
        mod.runCli(["monitor-open-prs", "--json"]),
      );
    } finally {
      delete process.env.GITHUB_LOGIN;
    }
    expect(JSON.parse(viaGithubLogin)).toEqual(openPrMonitorFixture());
  });

  it("fails with the shared login-required message when no login is resolvable", () => {
    const failure = runExpectingFailure(["monitor-open-prs"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_LOGIN: "",
      GITHUB_LOGIN: "",
    });
    expect(failure.status).toBe(1);
    expect(`${failure.stdout}${failure.stderr}`).toMatch(
      /Pass --login <github-login> or set LOOPOVER_LOGIN\./,
    );
  });

  // #6261: the API composes the summary/guidance and echoes PR titles back from third-party repos, so a hostile
  // string must not be able to repaint the terminal. --json stays raw on purpose: JSON.stringify escapes U+001B.
  it("strips ANSI escapes from API-chosen text on the plain-text path but not from --json", async () => {
    fixtureOptions.openPrMonitor = {
      summary: "[31mFAKE PASS[0m",
      guidance: ["[2Krewritten"],
    };

    const plain = await captureStdout(() =>
      mod.runCli(["monitor-open-prs", "--login", "JSONbored"]),
    );
    expect(plain).not.toContain("");
    expect(plain).toContain("FAKE PASS");
    expect(plain).toContain("rewritten");

    const asJson = await captureStdout(() =>
      mod.runCli(["monitor-open-prs", "--login", "JSONbored", "--json"]),
    );
    expect(JSON.parse(asJson).summary).toBe("[31mFAKE PASS[0m");
  });

  it("documents itself in --help and in the shell-completion command list", async () => {
    expect(await captureStdout(() => mod.runCli(["--help"]))).toContain(
      "loopover-mcp monitor-open-prs --login <github-login> [--json]",
    );
    expect(
      await captureStdout(() => mod.runCli(["monitor-open-prs", "--help"])),
    ).toContain("Mirrors the loopover_monitor_open_prs MCP tool");
    expect(
      await captureStdout(() => mod.runCli(["completion", "bash"])),
    ).toContain("monitor-open-prs");
  });
});
