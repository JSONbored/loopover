import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #8689: the generic `--key=value` inline-equals handler in parseOptions stored the raw string for
// every flag, so `--json=false` became the truthy string "false" and ENABLED JSON output (and
// `--exit-code=false` still escalated doctor's exit code) — the opposite of what the flags say.
// These scenarios run the CLI in-process via the exported runCli (the #8587 pattern from
// mcp-cli-basics.test.ts / mcp-cli-doctor.test.ts): the bin reads LOOPOVER_API_URL,
// LOOPOVER_NPM_REGISTRY_URL, and LOOPOVER_CONFIG_DIR at module load, so one fixture server and
// config dir are fixed before the dynamic import; call-time env (LOOPOVER_TOKEN and friends,
// LOOPOVER_SKIP_NPM_VERSION_CHECK) varies per test. Only the committed .ts source is imported.
type BinModule = { runCli: (args: string[]) => Promise<number | void> };

// TS5097: keep the .ts specifier out of a literal import() position (same indirection as the template).
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";

let sharedConfigDir = "";
let mod: BinModule;

beforeAll(async () => {
  sharedConfigDir = mkdtempSync(join(tmpdir(), "loopover-bool-flags-inprocess-"));
  const apiUrl = await startFixtureServer();
  // The bin reads these at module load, so set the env BEFORE importing (hence the dynamic import).
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_NPM_REGISTRY_URL = apiUrl;
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = sharedConfigDir;
  mod = (await import(BIN_MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (sharedConfigDir) rmSync(sharedConfigDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_NPM_REGISTRY_URL;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_CONFIG_DIR;
});

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
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
 *  these are the vars the bin reads at CALL time (not module load), so per-test variation is safe. */
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

const AUTHED = { LOOPOVER_TOKEN: "session-token", LOOPOVER_SKIP_NPM_VERSION_CHECK: "true" };
const UNAUTHED = {
  LOOPOVER_API_TOKEN: undefined,
  LOOPOVER_TOKEN: undefined,
  LOOPOVER_MCP_TOKEN: undefined,
  LOOPOVER_SKIP_NPM_VERSION_CHECK: "true",
};

describe("loopover-mcp CLI — boolean `--flag=value` parsing (#8689)", () => {
  it("disables JSON output for whoami --json=false (plain text, not JSON)", async () => {
    const out = await withEnv(AUTHED, () => captureStdout(() => mod.runCli(["whoami", "--json=false"])));
    // The plain-text arm prints just the login — never a JSON document.
    expect(out).toBe("JSONbored\n");
    expect(out.trimStart().startsWith("{")).toBe(false);
    expect(out).not.toContain('"login"');
  });

  it("keeps bare --json and --json=true enabling whoami JSON output as before", async () => {
    for (const flag of ["--json", "--json=true"]) {
      const out = await withEnv(AUTHED, () => captureStdout(() => mod.runCli(["whoami", flag])));
      const payload = JSON.parse(out) as { login: string; profile: string };
      expect(payload.login).toBe("JSONbored");
      expect(payload.profile).toBe("default");
    }
  });

  it("keeps doctor --exit-code=false at exit code 0 against a failing check", async () => {
    // No token configured -> the auth check fails -> status "needs_attention"; the explicit
    // `--exit-code=false` must keep the in-process return (the would-be process exit code) at 0.
    let exitCode: number | void = undefined;
    const out = await withEnv(UNAUTHED, () =>
      captureStdout(async () => {
        exitCode = await mod.runCli(["doctor", "--exit-code=false", "--json"]);
      }),
    );
    const payload = JSON.parse(out) as { status: string; checks: Array<{ name: string; status: string }> };
    expect(payload.status).toBe("needs_attention");
    expect(payload.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "auth", status: "fail" })]));
    expect(exitCode).toBe(0);
  });

  it("keeps bare --exit-code and --exit-code=true escalating doctor's exit code on a failing check", async () => {
    for (const flag of ["--exit-code", "--exit-code=true"]) {
      let exitCode: number | void = undefined;
      const out = await withEnv(UNAUTHED, () =>
        captureStdout(async () => {
          exitCode = await mod.runCli(["doctor", flag, "--json"]);
        }),
      );
      expect((JSON.parse(out) as { status: string }).status).toBe("needs_attention");
      expect(exitCode).toBe(1);
    }
  });

  it("still passes non-boolean inline `--key=value` options through as raw strings", async () => {
    // The boolean parse is scoped to json/exitCode: `--print=codex` keeps its string value.
    const out = await captureStdout(() => mod.runCli(["init-client", "--print=codex"]));
    expect(out).toContain("[mcp_servers.loopover]");
  });
});
