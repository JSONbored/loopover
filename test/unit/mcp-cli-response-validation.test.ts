import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bin } from "./support/mcp-cli-harness";

// #9521 under #9519's recorded posture: responses are validated against the published schema at the
// apiFetch boundary — a mismatch is REPORTED (stderr, once per path) and the payload passes through
// untouched by default; LOOPOVER_VALIDATE_RESPONSES makes it throw, which is what CI and the self-host
// container run with. These drive the real compiled bin against a server returning a payload the
// document does not describe, in both modes.

let server: Server;
let apiUrl = "";
let responseBody: Record<string, unknown>;

// /v1/lint/pr-text is in CLI_RESPONSE_SCHEMAS; LintPrTextResponse declares every field optional, so the
// mismatch here is a WRONG-TYPED field (score as a string), which is exactly the renamed/retyped-field
// drift the client exists to catch — while the CLI's own rendering still degrades instead of crashing.
const MISMATCHED_LINT_RESPONSE = { verdict: "strong", score: "ninety-seven" };

beforeAll(async () => {
  responseBody = MISMATCHED_LINT_RESPONSE;
  server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(responseBody));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  apiUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Async spawn, matching the harness's runAsync: a SYNC spawn would block this worker's event loop, and the
// fixture server lives on it -- the child's fetch would then hang unanswered until its own timeout aborts it.
function runLint(env: Record<string, string> = {}) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, "lint-pr-text", "--commit", "feat: x", "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LOOPOVER_API_URL: apiUrl,
          LOOPOVER_TOKEN: "fixture-token",
          LOOPOVER_SKIP_NPM_VERSION_CHECK: "1",
          LOOPOVER_API_TIMEOUT_MS: "2000",
          // A fresh, empty config dir, matching the shared harness's run(): without it the spawned bin
          // reads the developer's real profile.
          LOOPOVER_CONFIG_DIR: mkdtempSync(join(tmpdir(), "loopover-cli-validation-")),
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ status: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe("response validation at the apiFetch boundary (#9521/#9519)", () => {
  it("default posture: warns on stderr naming the endpoint and field, and the payload passes through UNTOUCHED", async () => {
    const result = await runLint();
    // The command still succeeds — "never 500ing an otherwise-good response" is the recorded posture,
    // and the payload is returned as the server sent it, not zod's parse: stripping unknown keys would
    // silently delete fields the document under-describes today.
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(MISMATCHED_LINT_RESPONSE);
    expect(result.stderr).toContain("did not match the published schema for /v1/lint/pr-text");
    // The first offending field is named, so the warning is actionable without re-running anything.
    expect(result.stderr).toContain("score");
  });

  it("LOOPOVER_VALIDATE_RESPONSES=1 (CI / self-host): the same mismatch fails the command, naming the schema", async () => {
    const result = await runLint({ LOOPOVER_VALIDATE_RESPONSES: "1" });
    expect(result.status).not.toBe(0);
    // --json failures land on stdout as the {ok:false} envelope (the CLI's json contract), not stderr.
    expect(result.stdout).toContain("did not match the published schema for /v1/lint/pr-text");
  });

  it("strict mode passes untouched when the response DOES match the schema", async () => {
    const valid = {
      generatedAt: "2026-07-28T00:00:00.000Z",
      verdict: "strong",
      score: 97,
      summary: "ok",
      commitFindings: [],
      bodyFindings: [],
      traceabilityFindings: [],
      fixes: [],
    };
    responseBody = valid;
    try {
      const result = await runLint({ LOOPOVER_VALIDATE_RESPONSES: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("did not match");
      expect(JSON.parse(result.stdout)).toEqual(valid);
    } finally {
      responseBody = MISMATCHED_LINT_RESPONSE;
    }
  });
});

// In-process variant of the same posture (#8587 pattern): the subprocess suite above proves the wiring in
// the real compiled bin, but v8 cannot see a child process, and the bin is Codecov-graded -- so the
// boundary functions are ALSO driven through the imported source. The bin reads LOOPOVER_API_URL at module
// load; a fresh local server plus a dynamic import fixes that here, same as mcp-cli-bool-flag-parsing.
describe("response validation, in-process", () => {
  type BinModule = {
    runCli: (args: string[]) => Promise<number | void>;
    resetResponseSchemaReportingForTesting: () => void;
  };
  const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

  let inProcessServer: Server;
  let inProcessBody: Record<string, unknown> = MISMATCHED_LINT_RESPONSE;
  let mod: BinModule;
  let configDir = "";

  beforeAll(async () => {
    inProcessServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(inProcessBody));
    });
    await new Promise<void>((resolve) => inProcessServer.listen(0, "127.0.0.1", resolve));
    const address = inProcessServer.address();
    configDir = mkdtempSync(join(tmpdir(), "loopover-cli-validation-inprocess-"));
    process.env.LOOPOVER_API_URL = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
    process.env.LOOPOVER_TOKEN = "fixture-token";
    process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
    process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
    process.env.LOOPOVER_CONFIG_DIR = configDir;
    mod = (await import(BIN_MODULE)) as unknown as BinModule;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => inProcessServer.close(() => resolve()));
    for (const key of ["LOOPOVER_API_URL", "LOOPOVER_TOKEN", "LOOPOVER_SKIP_NPM_VERSION_CHECK", "LOOPOVER_API_TIMEOUT_MS", "LOOPOVER_CONFIG_DIR", "LOOPOVER_VALIDATE_RESPONSES"]) {
      delete process.env[key];
    }
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  async function captureLint(json = true): Promise<{ stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      out.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      err.push(String(chunk));
      return true;
    });
    try {
      await mod.runCli(json ? ["lint-pr-text", "--commit", "feat: x", "--json"] : ["lint-pr-text", "--commit", "feat: x"]);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    return { stdout: out.join(""), stderr: err.join("") };
  }

  it("warns once per path, passes the payload through, and the memo dedupes a second call", async () => {
    delete process.env.LOOPOVER_VALIDATE_RESPONSES;
    mod.resetResponseSchemaReportingForTesting();
    inProcessBody = MISMATCHED_LINT_RESPONSE;
    const first = await captureLint();
    expect(JSON.parse(first.stdout)).toEqual(MISMATCHED_LINT_RESPONSE);
    expect(first.stderr).toContain("did not match the published schema for /v1/lint/pr-text");
    // Second call on the same path: the memo suppresses the repeat, so a polling loop cannot flood stderr.
    const second = await captureLint();
    expect(second.stderr).not.toContain("did not match");
  });

  it("throws under LOOPOVER_VALIDATE_RESPONSES, and a MATCHING response still passes in strict mode", async () => {
    mod.resetResponseSchemaReportingForTesting();
    process.env.LOOPOVER_VALIDATE_RESPONSES = "1";
    inProcessBody = MISMATCHED_LINT_RESPONSE;
    try {
      await expect(captureLint()).rejects.toThrow(/did not match the published schema for \/v1\/lint\/pr-text/);
      inProcessBody = { verdict: "strong", score: 97, summary: "ok" };
      const result = await captureLint();
      expect(JSON.parse(result.stdout)).toEqual(inProcessBody);
      expect(result.stderr).not.toContain("did not match");
    } finally {
      delete process.env.LOOPOVER_VALIDATE_RESPONSES;
    }
  });

  it("plain-text rendering treats an unspecced list field as empty when absent, and prints it when real", async () => {
    // unspeccedList's two sides (#9521): `fixes` is z.unknown() in the published schema, so the renderer
    // must not assert an element type -- absent renders nothing, a real array renders line per entry.
    mod.resetResponseSchemaReportingForTesting();
    delete process.env.LOOPOVER_VALIDATE_RESPONSES;
    inProcessBody = { verdict: "strong", score: 97, summary: "ok" };
    const withoutFixes = await captureLint(false);
    expect(withoutFixes.stdout).toContain("PR text lint: strong (score 97)");
    expect(withoutFixes.stdout).not.toContain("- ");
    inProcessBody = { verdict: "weak", score: 40, summary: "needs work", fixes: ["add a body"] };
    const withFixes = await captureLint(false);
    expect(withFixes.stdout).toContain("- add a body");
  });

  it("leaves an UNDOCUMENTED path entirely unvalidated (the /v1/auth/session shape is #9531's)", async () => {
    mod.resetResponseSchemaReportingForTesting();
    delete process.env.LOOPOVER_VALIDATE_RESPONSES;
    // whoami hits /v1/auth/session, which the document describes inline -- absent from the table, so even
    // an arbitrary body must produce no schema warning.
    inProcessBody = { anything: true };
    const out: string[] = [];
    const err: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      out.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
      err.push(String(chunk));
      return true;
    });
    try {
      await mod.runCli(["whoami", "--json"]).catch(() => undefined);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    expect(err.join("")).not.toContain("did not match");
  });
});
