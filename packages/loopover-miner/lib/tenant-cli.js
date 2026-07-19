/** `tenant` CLI command group (#7275): create / list / destroy hosted tenant instances against the #7173 ORB+AMS
 * hosting control-plane's provisioning API (#7180). Thin composition layer -- argv parsing plus a call into
 * tenant-client.js, which owns the env-gated, Bearer-authed, FAIL-LOUD HTTP surface. Every failure the client
 * throws (disabled/unconfigured plane, unreachable host, non-2xx, malformed body) is reported here as a non-zero
 * exit with the client's own message; there is deliberately no silent-degrade path, because provisioning a tenant
 * is a deliberate admin action whose failure an operator must see. Lifecycle `state` values are printed verbatim
 * from the API -- this layer invents no state vocabulary of its own. */
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { createTenant, destroyTenant, listTenants } from "./tenant-client.js";

const TENANT_USAGE =
  "Usage: loopover-miner tenant <create|list|destroy> [<name>] [--product <product>] [--json]";

/** Parse `create <name> [--product <p>] [--json]`. Returns `{ name, product, json }` or `{ error }`. */
export function parseTenantCreateArgs(args) {
  let name = null;
  let product = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--product") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: TENANT_USAGE };
      product = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    if (name !== null) return { error: TENANT_USAGE };
    name = token;
  }
  if (name === null) return { error: TENANT_USAGE };
  return { name, json, ...(product !== null ? { product } : {}) };
}

/** Parse `<name> [--json]` for the single-positional commands (destroy). Returns `{ name, json }` or `{ error }`. */
export function parseTenantNameArgs(args) {
  let name = null;
  let json = false;
  for (const token of args) {
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    if (name !== null) return { error: TENANT_USAGE };
    name = token;
  }
  if (name === null) return { error: TENANT_USAGE };
  return { name, json };
}

/** Parse `list [--json]` (no positional). Returns `{ json }` or `{ error }`. */
export function parseTenantListArgs(args) {
  let json = false;
  for (const token of args) {
    if (token === "--json") {
      json = true;
      continue;
    }
    return { error: `Unknown option: ${token}` };
  }
  return { json };
}

function renderTenantRecord(record) {
  const name = typeof record.name === "string" ? record.name : "(unknown)";
  const product = typeof record.product === "string" ? record.product : "(unknown)";
  const state = typeof record.state === "string" ? record.state : "(unknown)";
  return `${name}  product=${product}  state=${state}`;
}

export async function runTenantCreate(args, options = {}) {
  const parsed = parseTenantCreateArgs(args);
  if ("error" in parsed) return reportCliFailure(argsWantJson(args), parsed.error);
  const create = options.createTenant ?? createTenant;
  try {
    const record = await create(parsed.name, {
      env: options.env,
      fetchImpl: options.fetchImpl,
      ...(parsed.product !== undefined ? { product: parsed.product } : {}),
    });
    if (parsed.json) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      console.log(`created ${renderTenantRecord(record)}`);
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export async function runTenantList(args, options = {}) {
  const parsed = parseTenantListArgs(args);
  if ("error" in parsed) return reportCliFailure(argsWantJson(args), parsed.error);
  const list = options.listTenants ?? listTenants;
  try {
    const records = await list({ env: options.env, fetchImpl: options.fetchImpl });
    if (parsed.json) {
      console.log(JSON.stringify(records, null, 2));
    } else if (records.length === 0) {
      console.log("no tenants");
    } else {
      console.log(records.map(renderTenantRecord).join("\n"));
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export async function runTenantDestroy(args, options = {}) {
  const parsed = parseTenantNameArgs(args);
  if ("error" in parsed) return reportCliFailure(argsWantJson(args), parsed.error);
  const destroy = options.destroyTenant ?? destroyTenant;
  try {
    const record = await destroy(parsed.name, { env: options.env, fetchImpl: options.fetchImpl });
    if (parsed.json) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      console.log(`destroyed ${renderTenantRecord(record)}`);
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export async function runTenantCli(subcommand, args, options = {}) {
  if (subcommand === "create") return runTenantCreate(args, options);
  if (subcommand === "list") return runTenantList(args, options);
  if (subcommand === "destroy") return runTenantDestroy(args, options);
  return reportCliFailure(argsWantJson(args), TENANT_USAGE);
}
