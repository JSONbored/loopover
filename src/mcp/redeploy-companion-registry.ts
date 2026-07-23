// Workers-safe registry for the redeploy-trigger capability (#7723), mirroring
// src/mcp/private-config-admin-registry.ts's setConfigAdminFunctions pattern exactly: this module holds a
// single nullable function slot and never imports node:net itself, so it's safe in the Cloudflare Workers
// bundle. Only the self-host Node entry (server.ts) fills the slot, with a real closure built from
// src/selfhost/redeploy-companion-client.ts -- that module's own node:net import never reaches the Workers
// bundle because nothing there imports it directly, only through this registry.
// Unset (cloud, or self-host without REDEPLOY_COMPANION_TOKEN/_SOCKET_PATH configured) means the function
// here stays null, and src/mcp/server.ts's admin tool -- gated separately on LOOPOVER_MCP_ADMIN_ENABLED --
// reports a clear "not configured" result rather than throwing.
import type { RedeployResult } from "../selfhost/redeploy-companion-client.js";

export type RedeployTrigger = (image: string | undefined) => Promise<RedeployResult>;

let triggerRedeploy: RedeployTrigger | null = null;

export function setRedeployTrigger(trigger: RedeployTrigger | null): void {
  triggerRedeploy = trigger;
}

export function getRedeployTrigger(): RedeployTrigger | null {
  return triggerRedeploy;
}
