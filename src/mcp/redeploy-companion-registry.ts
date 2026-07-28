// Workers-safe registry for the redeploy-trigger capability (#7723), mirroring
// src/mcp/private-config-admin-registry.ts's setConfigAdminFunctions pattern exactly: this module holds a
// single nullable function slot and never imports node:net itself, so it's safe in the Cloudflare Workers
// bundle. Only the self-host Node entry (server.ts) fills the slot, with a real closure built from
// src/selfhost/redeploy-companion-client.ts -- that module's own node:net import never reaches the Workers
// bundle because nothing there imports it directly, only through this registry.
// Unset (cloud, or self-host without REDEPLOY_COMPANION_TOKEN/_SOCKET_PATH configured) means the function
// here stays null, and src/mcp/server.ts's admin tool -- gated separately on LOOPOVER_MCP_ADMIN_ENABLED --
// reports a clear "not configured" result rather than throwing.
import type { RedeployResult, RotateSecretResult } from "../selfhost/redeploy-companion-client";

export type RedeployTrigger = (image: string | undefined) => Promise<RedeployResult>;
/** Host-side secret rotation over the same companion socket (#9543). A separate slot from the redeploy
 *  trigger so an older companion that only serves the redeploy verb leaves this one null and the admin
 *  tool reports "not configured" instead of hanging on a verb the host doesn't understand. */
export type SecretRotator = (secret: string, value: string) => Promise<RotateSecretResult>;

let triggerRedeploy: RedeployTrigger | null = null;
let rotateSecret: SecretRotator | null = null;

export function setRedeployTrigger(trigger: RedeployTrigger | null): void {
  triggerRedeploy = trigger;
}

export function getRedeployTrigger(): RedeployTrigger | null {
  return triggerRedeploy;
}

export function setSecretRotator(rotator: SecretRotator | null): void {
  rotateSecret = rotator;
}

export function getSecretRotator(): SecretRotator | null {
  return rotateSecret;
}
