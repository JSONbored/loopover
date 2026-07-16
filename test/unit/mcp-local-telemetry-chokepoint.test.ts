import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

// #6238: wires the #6236 local telemetry wrapper into the stdio tool-dispatch chokepoint. The opt-in guarantee
// is the whole point of this surface, so these tests do not mock the PostHog SDK -- the stdio server runs as a
// real subprocess, where an in-process vi.mock could not reach it anyway. Instead they point the SDK at a local
// recorder via LOOPOVER_MCP_POSTHOG_HOST and assert what actually leaves the process. Default-off is therefore
// verified, not documented.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

type PostHogEvent = { event: string; distinct_id?: string; properties?: Record<string, unknown> };

let client: Client | null = null;
let configDir: string | null = null;
let recorder: Server | null = null;
let received: PostHogEvent[] = [];

/** A stand-in PostHog ingestion endpoint: accepts anything, records every event body it is sent.
 *  posthog-node POSTs gzipped JSON to `/batch/`, so the body is inflated before parsing -- reading it as plain
 *  UTF-8 yields garbage that silently parses to nothing, which would make every "sent nothing" assertion below
 *  pass no matter what the CLI did. */
async function startRecorder(): Promise<string> {
  received = [];
  recorder = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const text = request.headers["content-encoding"] === "gzip" ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
      const body = JSON.parse(text) as { batch?: PostHogEvent[] } & PostHogEvent;
      // posthog-node posts either a single event or a `batch` array depending on the flush path.
      if (Array.isArray(body.batch)) received.push(...body.batch);
      else if (body.event) received.push(body);
      response.statusCode = 200;
      response.end(JSON.stringify({ status: 1 }));
    });
  });
  await new Promise<void>((resolve) => recorder!.listen(0, "127.0.0.1", resolve));
  const address = recorder!.address();
  if (typeof address === "string" || !address) throw new Error("recorder failed to bind");
  return `http://127.0.0.1:${address.port}`;
}

/** Wait until `predicate` holds or the window elapses -- the SDK flushes on its own turn, not ours. */
async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function cliEnv(host: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    LOOPOVER_CONFIG_DIR: configDir!,
    LOOPOVER_MCP_POSTHOG_API_KEY: "phc-test-key",
    LOOPOVER_MCP_POSTHOG_HOST: host,
    LOOPOVER_API_TIMEOUT_MS: "1000",
    ...extra,
  } as NodeJS.ProcessEnv;
}

async function connect(host: string) {
  const transport = new StdioClientTransport({ command: "node", args: [bin, "--stdio"], env: cliEnv(host) as Record<string, string> });
  client = new Client({ name: "telemetry-chokepoint-test", version: "0.0.1" });
  await client.connect(transport);
}

/** A tool with no API round-trip, so the only thing on the wire is telemetry. */
async function callLintPrText() {
  return client!.callTool({
    name: "loopover_lint_pr_text",
    arguments: { commitMessages: ["feat(mcp): add telemetry chokepoint"], prBody: "Wires telemetry. Validated with npm test.", linkedIssue: 6238 },
  });
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = null;
  if (recorder) await new Promise<void>((resolve) => recorder!.close(() => resolve()));
  recorder = null;
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = null;
});

describe("loopover-mcp local telemetry chokepoint (#6238)", () => {
  it("sends NOTHING by default, even with an API key configured, and the tool still works", async () => {
    configDir = mkdtempSync(join(tmpdir(), "loopover-telemetry-off-"));
    const host = await startRecorder();
    await connect(host);

    const result = await callLintPrText();
    expect(result.isError).toBeFalsy();

    // Give a would-be event every chance to arrive before declaring silence.
    await waitFor(() => received.length > 0);
    expect(received).toEqual([]);
  }, 45_000);

  it("records exactly one allowlisted event per call once the user opts in", async () => {
    configDir = mkdtempSync(join(tmpdir(), "loopover-telemetry-on-"));
    const host = await startRecorder();
    // Opt in the way a user does -- through the real command, not by hand-writing the config file.
    execFileSync("node", [bin, "telemetry", "enable"], { env: cliEnv(host), stdio: "ignore" });
    await connect(host);

    await callLintPrText();
    await waitFor(() => received.length > 0);

    expect(received).toHaveLength(1);
    const event = received[0]!;
    expect(event.event).toBe("mcp_tool_call");
    expect(event.properties?.tool).toBe("loopover_lint_pr_text");
    expect(event.properties?.caller_type).toBe("local");
    expect(event.properties?.ok).toBe(true);
    expect(typeof event.properties?.duration_ms).toBe("number");

    // The allowlist is exhaustive for everything LoopOver puts on the event. What remains on the wire is the
    // PostHog SDK's own `$`-prefixed library metadata ($lib, $lib_version, $is_server, $geoip_disable) -- vendor
    // provenance, not anything about the user or their call. Asserted as two separate sets rather than one flat
    // list, so a future field of OURS can never hide among the vendor's.
    const properties = Object.keys(event.properties ?? {});
    expect(properties.filter((key) => !key.startsWith("$")).sort()).toEqual(["caller_type", "duration_ms", "ok", "tool"]);
    expect(properties.filter((key) => key.startsWith("$")).sort()).toEqual(["$geoip_disable", "$is_server", "$lib", "$lib_version"]);
    expect(event.properties?.$geoip_disable).toBe(true);
    // Anonymous by construction: one shared handle, never a per-user id.
    expect(event.distinct_id).toBe("loopover-mcp");
    // The call's actual content never leaves: not the PR body, not the commit message.
    expect(JSON.stringify(event)).not.toContain("Wires telemetry");
    expect(JSON.stringify(event)).not.toContain("feat(mcp): add telemetry chokepoint");
  }, 45_000);

  it("records one event per invocation, not one per session", async () => {
    configDir = mkdtempSync(join(tmpdir(), "loopover-telemetry-count-"));
    const host = await startRecorder();
    execFileSync("node", [bin, "telemetry", "enable"], { env: cliEnv(host), stdio: "ignore" });
    await connect(host);

    await callLintPrText();
    await callLintPrText();
    await waitFor(() => received.length >= 2);

    expect(received).toHaveLength(2);
    expect(received.every((event) => event.properties?.tool === "loopover_lint_pr_text")).toBe(true);
  }, 45_000);

  it("`telemetry disable` returns the server to sending nothing", async () => {
    configDir = mkdtempSync(join(tmpdir(), "loopover-telemetry-toggle-"));
    const host = await startRecorder();
    execFileSync("node", [bin, "telemetry", "enable"], { env: cliEnv(host), stdio: "ignore" });
    execFileSync("node", [bin, "telemetry", "disable"], { env: cliEnv(host), stdio: "ignore" });
    await connect(host);

    const result = await callLintPrText();
    expect(result.isError).toBeFalsy();
    await waitFor(() => received.length > 0);
    expect(received).toEqual([]);
  }, 45_000);

  it("a failing tool is recorded as ok=false, and still fails the same way for the caller", async () => {
    configDir = mkdtempSync(join(tmpdir(), "loopover-telemetry-fail-"));
    const host = await startRecorder();
    execFileSync("node", [bin, "telemetry", "enable"], { env: cliEnv(host), stdio: "ignore" });
    // No API server on this port, so an API-backed tool's fetch fails -- the handler throws.
    const transport = new StdioClientTransport({
      command: "node",
      args: [bin, "--stdio"],
      env: cliEnv(host, { LOOPOVER_API_URL: "http://127.0.0.1:1", LOOPOVER_TOKEN: "session-token" }) as Record<string, string>,
    });
    client = new Client({ name: "telemetry-fail-test", version: "0.0.1" });
    await client.connect(transport);

    const result = await client.callTool({ name: "loopover_get_repo_context", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBe(true);

    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
    expect(received[0]!.properties?.tool).toBe("loopover_get_repo_context");
    expect(received[0]!.properties?.ok).toBe(false);
  }, 45_000);
});
