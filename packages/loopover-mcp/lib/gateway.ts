// Gateway mode: the stdio server mounts the REMOTE server's tools (#9526).
//
// One stdio entry, every tool a session entitles you to. Without this a contributor configures the stdio
// server for local-git tools and separately points something at `https://api.loopover.ai/mcp` for the rest —
// two configs for what is one product.
//
// Name collisions cannot happen by construction, and that is a property of #9518's registry rather than a
// check here: post-migration a tool name is either locality `local-git` (served locally) or `remote`
// (proxied), never both, because there is ONE contract registry and one entry per name. `validate:mcp`
// asserts the invariant; this module relies on it and additionally skips anything already registered, so a
// future violation degrades to "local wins" instead of a duplicate-registration crash.
//
// Offline or unauthenticated is NOT an error. A contributor with no session, or on a plane, gets the local
// tools and one advisory — never a server that fails to start. That is the whole reason the mount is
// best-effort: the gateway is an enhancement, and an enhancement that can break startup is a liability.

/** The subset of a remote `tools/list` entry this needs. Schemas come across the wire; nothing is duplicated. */
export type RemoteToolDescriptor = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export type GatewayFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type GatewayMountInput = {
  apiUrl: string;
  /** The session token from `loopover-mcp login`. Absent ⇒ local tools only, no request attempted. */
  token: string | null;
  /** Names the local server already serves. A remote tool with one of these names is skipped, never replaced. */
  localToolNames: ReadonlySet<string>;
  fetchImpl: GatewayFetch;
  /** Bounds the discovery call so a slow or hanging remote cannot delay stdio startup. */
  timeoutMs?: number;
};

export type GatewayMountResult =
  | { status: "mounted"; tools: RemoteToolDescriptor[]; skipped: string[] }
  | { status: "unauthenticated"; advisory: string }
  | { status: "unavailable"; advisory: string };

export const GATEWAY_UNAUTHENTICATED_ADVISORY =
  "Remote tools are not mounted: no LoopOver session on this machine. Run `loopover-mcp login` and restart your client to use the full tool set. Local tools are available now.";

export const GATEWAY_DISABLED_ADVISORY =
  "Remote tools are not mounted: gateway mode was disabled with --no-remote. Local tools are available; drop the flag and restart your client to mount the remote tool set.";

function unavailableAdvisory(reason: string): string {
  return `Remote tools are not mounted: ${reason}. Local tools are available now; they will mount on the next start once the API is reachable.`;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Discover the remote tool set for this session.
 *
 * Every failure path lands on `unavailable` with a readable reason rather than throwing: an offline
 * contributor must still get a working stdio server. A non-2xx is reported by status because the body is
 * remote-controlled and has no business in a local advisory string.
 */
export async function discoverRemoteTools(input: GatewayMountInput): Promise<GatewayMountResult> {
  if (!input.token) return { status: "unauthenticated", advisory: GATEWAY_UNAUTHENTICATED_ADVISORY };

  let response: Awaited<ReturnType<GatewayFetch>>;
  try {
    response = await input.fetchImpl(`${input.apiUrl.replace(/\/+$/, "")}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: "unavailable", advisory: unavailableAdvisory(`the API was unreachable (${error instanceof Error ? error.message : String(error)})`) };
  }

  if (!response.ok) {
    return { status: "unavailable", advisory: unavailableAdvisory(`the API answered ${response.status}`) };
  }

  const payload = (await response.json().catch(() => null)) as { result?: { tools?: unknown } } | null;
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) {
    return { status: "unavailable", advisory: unavailableAdvisory("the API returned no tool list") };
  }

  const mounted: RemoteToolDescriptor[] = [];
  const skipped: string[] = [];
  for (const candidate of tools) {
    if (!candidate || typeof candidate !== "object") continue;
    const tool = candidate as RemoteToolDescriptor;
    if (typeof tool.name !== "string" || tool.name === "") continue;
    // Local wins. The registry makes this unreachable, but a duplicate registration would crash the server,
    // and degrading to "the local one" is strictly better than refusing to start.
    if (input.localToolNames.has(tool.name)) {
      skipped.push(tool.name);
      continue;
    }
    mounted.push(tool);
  }
  return { status: "mounted", tools: mounted, skipped };
}

/** `--no-remote` gives byte-identical pre-gateway behavior, for anyone who wants only local tools. */
export function gatewayDisabled(argv: readonly string[]): boolean {
  return argv.includes("--no-remote");
}

/**
 * The advisory a client sees when remote tools are not mounted, as a resource rather than an error.
 *
 * A missing session is a normal state, not a failure, so it must never surface as a tool error or a
 * non-zero exit — the client would render a broken server where the honest answer is "you have the local
 * half, here is how to get the rest".
 */
export function gatewayAdvisoryResource(result: GatewayMountResult): { status: string; advisory: string } | null {
  if (result.status === "mounted") return null;
  return { status: result.status, advisory: result.advisory };
}
