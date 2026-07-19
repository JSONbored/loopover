import type { createTenant, destroyTenant, listTenants, TenantRecord } from "./tenant-client.js";

export type ParsedTenantCreateArgs =
  | { name: string; json: boolean; product?: string }
  | { error: string };

export type ParsedTenantNameArgs = { name: string; json: boolean } | { error: string };

export type ParsedTenantListArgs = { json: boolean } | { error: string };

export type RunTenantOptions = {
  /** Read for the control-plane opt-in gate -- defaults to `process.env` inside the client. */
  env?: Record<string, string | undefined>;
  /** Injected fetch, forwarded to the client; defaults to the real global fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Injectable client functions so tests drive the CLI without a real control plane. */
  createTenant?: typeof createTenant;
  listTenants?: typeof listTenants;
  destroyTenant?: typeof destroyTenant;
};

export function parseTenantCreateArgs(args: string[]): ParsedTenantCreateArgs;

export function parseTenantNameArgs(args: string[]): ParsedTenantNameArgs;

export function parseTenantListArgs(args: string[]): ParsedTenantListArgs;

export function runTenantCreate(args: string[], options?: RunTenantOptions): Promise<number>;

export function runTenantList(args: string[], options?: RunTenantOptions): Promise<number>;

export function runTenantDestroy(args: string[], options?: RunTenantOptions): Promise<number>;

export function runTenantCli(subcommand: string | undefined, args: string[], options?: RunTenantOptions): Promise<number>;
