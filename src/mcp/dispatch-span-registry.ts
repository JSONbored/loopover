// Workers-safe registry for the MCP dispatch span (#9525), mirroring
// src/mcp/private-config-admin-registry.ts's pattern exactly: this module holds one nullable
// function slot and never imports src/selfhost/otel.ts itself, so it is safe in the Cloudflare
// Workers bundle.
//
// Only the self-host Node entry (server.ts) fills the slot, with a closure over the real
// `withOtelSpan`. Unset -- which is the cloud Worker, and any self-host without an OTel collector --
// means every tool call runs unwrapped, at zero cost. That asymmetry is deliberate and is why this
// is a registry rather than a direct import: Workers has no OTel collector to export to, and pulling
// the tracer into that bundle would cost real bytes for a capability it cannot use.
export type McpDispatchSpanRunner = <T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>) => Promise<T>;

let runner: McpDispatchSpanRunner | null = null;

/** Called once at self-host boot. */
export function setMcpDispatchSpanRunner(next: McpDispatchSpanRunner | null): void {
  runner = next;
}

/** The runner, or undefined when tracing is not available on this deployment. */
export function getMcpDispatchSpanRunner(): McpDispatchSpanRunner | undefined {
  return runner ?? undefined;
}

/** Test-only: clear the slot so one test's registration cannot leak into the next. */
export function resetMcpDispatchSpanRunnerForTest(): void {
  runner = null;
}
