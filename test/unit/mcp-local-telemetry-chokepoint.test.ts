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
const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");

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

// #10175: the three events per call now speak TWO deliberate vocabularies -- `usage_event` and the
// legacy `mcp_tool_call` keep LoopOver's snake_case keys, while `$mcp_tool_call` carries PostHog's
// reserved `$mcp_*` names because their built-in dashboards read those literally. These read
// whichever one an event uses, so the invariants below stay about BEHAVIOR (which tool, did it
// succeed) rather than about key spelling.
function toolOf(event: { event?: string; properties?: Record<string, unknown> }): unknown {
  return event.properties?.$mcp_tool_name ?? event.properties?.tool;
}
function okOf(event: { event?: string; properties?: Record<string, unknown> }): unknown {
  const isError = event.properties?.$mcp_is_error;
  return isError === undefined ? event.properties?.ok : !isError;
}

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

  it("records exactly the three allowlisted events per call once the user opts in", async () => {
    configDir = mkdtempSync(join(tmpdir(), "loopover-telemetry-on-"));
    const host = await startRecorder();
    // Opt in the way a user does -- through the real command, not by hand-writing the config file.
    execFileSync("node", [bin, "telemetry", "enable"], { env: cliEnv(host), stdio: "ignore" });
    await connect(host);

    await callLintPrText();
    await waitFor(() => received.length > 0);

    // THREE events per call as of #9525, and the count is deliberate rather than incidental:
    //   - `mcp_tool_call`, the legacy #6236 event. Still emitted because an operator's existing
    //     dashboards read it and #9525's dashboard migration (its requirement 8) lives in the
    //     PostHog project, not this repo. It goes once those dashboards read the new shapes; see
    //     the follow-up issue linked from #9525.
    //   - `usage_event`, the shared minimal event all three servers now emit.
    //   - `$mcp_tool_call`, PostHog's own MCP-Analytics family.
    // This is a transitional 3x on an opt-in CLI's event volume, which is the cost of not breaking
    // dashboards mid-migration -- worth stating plainly rather than leaving as an unexplained count.
    expect(received.map((entry) => entry.event).sort()).toEqual(["$mcp_tool_call", "mcp_tool_call", "usage_event"]);

    const legacy = received.find((entry) => entry.event === "mcp_tool_call")!;
    expect(legacy.properties?.tool).toBe("loopover_lint_pr_text");
    expect(legacy.properties?.caller_type).toBe("local");
    expect(legacy.properties?.ok).toBe(true);
    expect(typeof legacy.properties?.duration_ms).toBe("number");

    const usage = received.find((entry) => entry.event === "usage_event")!;
    expect(usage.properties?.tool).toBe("loopover_lint_pr_text");
    expect(usage.properties?.surface).toBe("stdio");
    expect(usage.properties?.category).toBe("review");
    expect(usage.properties?.ok).toBe(true);

    // The allowlist is exhaustive for everything LoopOver puts on an event, and it is applied to
    // EVERY event rather than just the first -- adding two events without extending this check is
    // exactly how a new field would have slipped onto the wire unexamined. What remains is the
    // PostHog SDK's own `$`-prefixed library metadata ($lib, $lib_version, $is_server,
    // $geoip_disable) -- vendor provenance, not anything about the user or their call. Asserted as
    // two separate sets so a future field of OURS can never hide among the vendor's.
    const allowedByEvent: Record<string, string[]> = {
      mcp_tool_call: ["caller_type", "duration_ms", "ok", "tool"],
      usage_event: ["category", "duration_ms", "ok", "surface", "tool", "transport"],
      // No `arguments`/`result`: payloads are excluded for every tool by default (#9525). This test
      // is what established that -- the first design included them, and this assertion found a real
      // commit message on the wire.
      $mcp_tool_call: ["category", "payloads_excluded", "surface", "transport"],
    };
    // #10175: the `$mcp_*` keys `$mcp_tool_call` is REQUIRED to carry, because PostHog's built-in MCP
    // dashboards read these names literally. Asserted separately from the vendor's own `$` metadata
    // so a canonical key can never be mistaken for library noise (or vice versa).
    // `$session_id`/`$mcp_server_*`/`$mcp_client_*` are absent on purpose: the stdio server has no
    // HTTP session, so it passes no analytics context.
    const canonicalByEvent: Record<string, string[]> = {
      mcp_tool_call: [],
      usage_event: [],
      $mcp_tool_call: ["$mcp_duration_ms", "$mcp_is_error", "$mcp_source", "$mcp_tool_name"],
    };
    // The PostHog SDK's own library metadata -- vendor provenance, not anything about the user.
    const vendorKeys = ["$geoip_disable", "$is_server", "$lib", "$lib_version"];
    for (const event of received) {
      const properties = Object.keys(event.properties ?? {});
      const ours = properties.filter((key) => !key.startsWith("$")).sort();
      const allowed = allowedByEvent[event.event]!;
      expect(ours.filter((key) => !allowed.includes(key)), `${event.event} carries a field outside the allowlist`).toEqual([]);
      expect(properties.filter((key) => key.startsWith("$") && !vendorKeys.includes(key)).sort()).toEqual(canonicalByEvent[event.event]!);
      expect(properties.filter((key) => vendorKeys.includes(key)).sort()).toEqual(vendorKeys);
      expect(event.properties?.$geoip_disable).toBe(true);
      // Anonymous by construction: one shared handle, never a per-user id.
      expect(event.distinct_id).toBe("loopover-mcp");
      // The call's actual content never leaves: not the PR body, not the commit message. Now
      // checked on the payload-carrying event too, which is the one that could actually leak it.
      expect(JSON.stringify(event)).not.toContain("Wires telemetry");
      expect(JSON.stringify(event)).not.toContain("feat(mcp): add telemetry chokepoint");
    }
  }, 45_000);

  it("records one event per invocation, not one per session", async () => {
    configDir = mkdtempSync(join(tmpdir(), "loopover-telemetry-count-"));
    const host = await startRecorder();
    execFileSync("node", [bin, "telemetry", "enable"], { env: cliEnv(host), stdio: "ignore" });
    await connect(host);

    await callLintPrText();
    await callLintPrText();
    await waitFor(() => received.length >= 6);

    // Two invocations x the three events per call above. The invariant this test protects is that
    // the count scales with CALLS, not that it is any particular number: a per-session or per-
    // process emitter would produce three here, not six.
    expect(received).toHaveLength(6);
    expect(received.filter((event) => event.event === "usage_event")).toHaveLength(2);
    expect(received.every((event) => toolOf(event) === "loopover_lint_pr_text")).toBe(true);
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

    await waitFor(() => received.length >= 3);
    // The same three events as the success case, plus PostHog's `$exception` when the handler threw
    // rather than answering (#9525). Every one of them reports ok=false, and the exception carries
    // the grouping properties an operator can actually act on -- the tool and the closed error code
    // -- and nothing about the call's content.
    expect(received.every((event) => event.event === "$exception" || okOf(event) === false)).toBe(true);
    expect(received.every((event) => event.event === "$exception" || toolOf(event) === "loopover_get_repo_context")).toBe(true);
    const usage = received.find((event) => event.event === "usage_event")!;
    expect(usage.properties?.error_code).toBeTypeOf("string");
  }, 45_000);
});
