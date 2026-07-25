// #6745: the CLI mirror for loopover_list_notifications / loopover_mark_notifications_read. The MCP tools and the
// new GET /notifications + POST /notifications/read routes serve a contributor's notification feed; only the
// stdio/CLI surface was missing. These pin: `notifications --json` stays byte-identical to the route, the
// plain-text path lists the feed, `notifications-read` forwards --id (or marks all), and login resolution matches
// the sibling contributor commands.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TS5097: keep the .ts specifier out of a literal import() position (same indirection as the template).
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeFixtureServer,
  notificationsFixture,
  notificationsReadFixture,
  runExpectingFailure,
  startFixtureServer,
} from "./support/mcp-cli-harness";

// #8587: these scenarios run the CLI in-process (same shape as mcp-cli-contributor-profile-inprocess.test.ts)
// instead of spawning a subprocess per call. The bin reads LOOPOVER_API_URL and LOOPOVER_CONFIG_DIR at module
// load, so ONE fixture server + config dir are fixed before the dynamic import; per-test variation goes
// through `fixtureOptions` (the harness route handlers read the options object at request time) and through
// call-time env vars (LOOPOVER_LOGIN / GITHUB_LOGIN are read on every invocation). Only the two
// runExpectingFailure cases stay real subprocesses: they assert the process exit code and the CLI failure
// envelope, which only the process entrypoint produces. Only the committed .ts source is imported.
type BinModule = { runCli: (args: string[]) => Promise<number | void> };
type FixtureOptions = NonNullable<Parameters<typeof startFixtureServer>[0]>;

let apiUrl: string;
let markReadBodies: unknown[] = [];
let configDir = "";
let mod: BinModule;
const fixtureOptions: FixtureOptions = {
  onMarkNotificationsRead: (body) => markReadBodies.push(body),
};

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-notifications-inprocess-"));
  apiUrl = await startFixtureServer(fixtureOptions);
  // The bin reads these at module load, so set the env BEFORE importing (hence the dynamic import).
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_API_TOKEN = "session-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = configDir;
  mod = (await import(BIN_MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_API_TOKEN;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_CONFIG_DIR;
});

beforeEach(() => {
  markReadBodies = [];
  delete fixtureOptions.notifications;
});

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
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

/** Set (string) or delete (undefined) env vars around a call, restoring the previous values after —
 *  LOOPOVER_LOGIN / GITHUB_LOGIN are read at CALL time, so per-test variation is safe in-process. */
async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
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

describe("loopover-mcp notifications CLI", () => {
  it("--json emits exactly the feed the route returns", async () => {
    const out = await captureStdout(() =>
      mod.runCli(["notifications", "--login", "JSONbored", "--json"]),
    );
    expect(JSON.parse(out)).toEqual(notificationsFixture());
  });

  it("prints the unread count and a line per notification", async () => {
    const out = await captureStdout(() =>
      mod.runCli(["notifications", "--login", "JSONbored"]),
    );
    expect(out).toContain("LoopOver notifications for JSONbored: 1 unread.");
    expect(out).toContain(
      "JSONbored/loopover#42 Your pull request JSONbored/loopover#42 was merged.",
    );
    expect(out).toContain(
      "JSONbored/loopover#7 Changes requested on JSONbored/loopover#7.",
    );
  });

  it("resolves the login from LOOPOVER_LOGIN, then GITHUB_LOGIN, like the sibling contributor commands", async () => {
    const viaLoopoverLogin = await withEnv(
      { LOOPOVER_LOGIN: "JSONbored", GITHUB_LOGIN: undefined },
      () => captureStdout(() => mod.runCli(["notifications", "--json"])),
    );
    expect(JSON.parse(viaLoopoverLogin)).toEqual(notificationsFixture());
    const viaGithubLogin = await withEnv(
      { LOOPOVER_LOGIN: undefined, GITHUB_LOGIN: "JSONbored" },
      () => captureStdout(() => mod.runCli(["notifications", "--json"])),
    );
    expect(JSON.parse(viaGithubLogin)).toEqual(notificationsFixture());
  });

  // KEPT as a real subprocess (#8587 rule (a)): asserts the process exit code and the failure output of the
  // entrypoint's catch, which only a spawned process produces.
  it("fails with the shared login-required message when no login is resolvable", () => {
    const failure = runExpectingFailure(["notifications"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_LOGIN: "",
      GITHUB_LOGIN: "",
    });
    expect(failure.status).toBe(1);
    expect(`${failure.stdout}${failure.stderr}`).toMatch(
      /Pass --login <github-login>/,
    );
  });

  // #6261: the API chooses the notification title text, so a hostile string must not repaint the terminal.
  it("strips ANSI escapes from API-chosen text on the plain-text path but not from --json", async () => {
    const esc = String.fromCharCode(27);
    const hostileTitle = `${esc}[31mFAKE MERGE${esc}[0m`;
    // The fixture server reads fixtureOptions at request time, so this swaps the feed for a hostile one
    // without restarting the server (beforeEach clears it again).
    fixtureOptions.notifications = {
      unreadCount: 1,
      notifications: [
        {
          id: "x",
          eventType: "pull_request_merged",
          repoFullName: "acme/x",
          pullNumber: 1,
          title: hostileTitle,
          body: "b",
          deeplink: "https://x",
          status: "delivered",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    };

    const plain = await captureStdout(() =>
      mod.runCli(["notifications", "--login", "JSONbored"]),
    );
    expect(plain).not.toContain(esc);
    expect(plain).toContain("FAKE MERGE");

    const asJson = await captureStdout(() =>
      mod.runCli(["notifications", "--login", "JSONbored", "--json"]),
    );
    expect(JSON.parse(asJson).notifications[0].title).toBe(hostileTitle);
  });

  it("documents itself in --help, in its own --help, and in the shell-completion command list", async () => {
    expect(await captureStdout(() => mod.runCli(["--help"]))).toContain(
      "loopover-mcp notifications --login <github-login> [--json]",
    );
    expect(
      await captureStdout(() => mod.runCli(["notifications", "--help"])),
    ).toContain("Mirrors the loopover_list_notifications MCP tool");
    expect(
      await captureStdout(() => mod.runCli(["completion", "bash"])),
    ).toContain("notifications");
  });
});

describe("loopover-mcp notifications-read CLI", () => {
  it("--json emits exactly the { login, marked } the route returns", async () => {
    const out = await captureStdout(() =>
      mod.runCli(["notifications-read", "--login", "JSONbored", "--json"]),
    );
    expect(JSON.parse(out)).toEqual(notificationsReadFixture());
  });

  it("prints the marked count on the plain-text path", async () => {
    const out = await captureStdout(() =>
      mod.runCli(["notifications-read", "--login", "JSONbored"]),
    );
    expect(out).toContain(
      "Marked 2 LoopOver notification(s) read for JSONbored.",
    );
  });

  it("marks all (empty body) when no --id is given", async () => {
    await captureStdout(() =>
      mod.runCli(["notifications-read", "--login", "JSONbored", "--json"]),
    );
    expect(markReadBodies).toEqual([{}]);
  });

  it("forwards repeated --id flags as an ids array", async () => {
    await captureStdout(() =>
      mod.runCli([
        "notifications-read",
        "--login",
        "JSONbored",
        "--id",
        "d-42",
        "--id",
        "d-7",
        "--json",
      ]),
    );
    expect(markReadBodies).toEqual([{ ids: ["d-42", "d-7"] }]);
  });

  // KEPT as a real subprocess (#8587 rule (a)): asserts the process exit code and the failure output of the
  // entrypoint's catch, which only a spawned process produces.
  it("fails with the shared login-required message when no login is resolvable", () => {
    const failure = runExpectingFailure(["notifications-read"], {
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_LOGIN: "",
      GITHUB_LOGIN: "",
    });
    expect(failure.status).toBe(1);
    expect(`${failure.stdout}${failure.stderr}`).toMatch(
      /Pass --login <github-login>/,
    );
  });

  it("documents itself in --help, in its own --help, and in the shell-completion command list", async () => {
    expect(await captureStdout(() => mod.runCli(["--help"]))).toContain(
      "loopover-mcp notifications-read --login <github-login> [--id <delivery-id>]... [--json]",
    );
    expect(
      await captureStdout(() => mod.runCli(["notifications-read", "--help"])),
    ).toContain("Mirrors the loopover_mark_notifications_read MCP tool");
    expect(
      await captureStdout(() => mod.runCli(["completion", "bash"])),
    ).toContain("notifications-read");
  });
});
