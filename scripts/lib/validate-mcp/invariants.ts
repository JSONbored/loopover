// Pure invariant checks the MCP contract validator runs (#9520).
//
// Split from the driver so every branch is reachable from a unit test without booting a server; the
// driver stays thin glue over these. Each function returns a list of human-readable failures rather
// than throwing, so one run reports every problem instead of the first.
import type { McpToolDefinition } from "@loopover/contract";

export type ListedTool = {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  annotations?: { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined } | undefined;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] } | undefined;
  outputSchema?: { type?: string } | undefined;
  _meta?: { category?: string | undefined } | undefined;
};

/**
 * The registry's projection for a server and that server's real `tools/list` must be the same SET.
 *
 * Both directions matter and fail differently: a tool the registry projects but the server never
 * registered is a capability the published contract promises and nothing serves; a tool the server
 * registers outside the registry is exactly the hand-maintained declaration this program exists to
 * eliminate.
 */
export function diffToolSets(expected: readonly McpToolDefinition[], listed: readonly ListedTool[]): string[] {
  const expectedNames = new Set(expected.map((tool) => tool.name));
  const listedNames = new Set(listed.map((tool) => tool.name));
  const failures: string[] = [];
  for (const name of expectedNames) {
    if (!listedNames.has(name)) failures.push(`registry projects ${name} but the server does not register it`);
  }
  for (const name of listedNames) {
    if (!expectedNames.has(name)) failures.push(`server registers ${name} but it has no registry entry`);
  }
  return failures;
}

/** Every listed tool must advertise a description and object-typed input AND output schemas. */
export function checkAdvertisedShape(listed: readonly ListedTool[]): string[] {
  const failures: string[] = [];
  for (const tool of listed) {
    if (!tool.description || tool.description.trim().length === 0) failures.push(`${tool.name} advertises no description`);
    if (tool.inputSchema?.type !== "object") failures.push(`${tool.name} advertises a non-object inputSchema`);
    if (!tool.outputSchema) failures.push(`${tool.name} advertises no outputSchema`);
    else if (tool.outputSchema.type !== "object") failures.push(`${tool.name} advertises a non-object outputSchema`);
  }
  return failures;
}

/**
 * What a server ADVERTISES for a tool must be what the registry projects for it (#9655).
 *
 * `checkAdvertisedShape` above asks only whether a description exists, so three servers could -- and
 * did -- serve three different descriptions, titles and annotation postures from one contract entry
 * while every check stayed green. The posture is the part that matters operationally: a client that
 * gates confirmation on `destructiveHint` got nothing at all for `loopover_delete_branch` from the
 * server that performs the delete.
 *
 * Compares against the PROJECTION, which is where the `{ readOnlyHint: true, destructiveHint: false }`
 * default is applied -- so "advertises no annotations" fails here rather than being read as agreement
 * with an entry that declares none.
 */
export function checkAdvertisedMetadata(expected: readonly McpToolDefinition[], listed: readonly ListedTool[]): string[] {
  const listedByName = new Map(listed.map((tool) => [tool.name, tool]));
  const failures: string[] = [];
  for (const tool of expected) {
    const advertised = listedByName.get(tool.name);
    // A missing tool is diffToolSets' finding to report; saying it twice makes one defect look like two.
    if (!advertised) continue;
    if (advertised.title !== tool.title) failures.push(`${tool.name} advertises title ${JSON.stringify(advertised.title)}, registry says ${JSON.stringify(tool.title)}`);
    if (advertised.description !== tool.description) failures.push(`${tool.name} advertises a description the registry does not`);
    for (const hint of ["readOnlyHint", "destructiveHint"] as const) {
      if (advertised.annotations?.[hint] !== tool.annotations[hint]) {
        failures.push(`${tool.name} advertises ${hint}=${String(advertised.annotations?.[hint])}, registry says ${String(tool.annotations[hint])}`);
      }
    }
    if (advertised._meta?.category !== tool.category) {
      failures.push(`${tool.name} advertises _meta.category=${String(advertised._meta?.category)}, registry says ${String(tool.category)}`);
    }
  }
  return failures;
}

const BOUND_KEYS = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const;
const LOWER_BOUNDS = new Set<string>(["minimum", "minLength", "minItems"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => jsonDeepEqual(entry, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && jsonDeepEqual(left[key], right[key]));
}

/**
 * The MCP SDK's zod→JSON-Schema path omits `additionalProperties: false` that `z.toJSONSchema`
 * (draft-2020-12) emits for the same object. Both sides of this check are already JSON Schema, but
 * they are not produced by the same converter, so a closed object on the contract and an omitted
 * keyword on the wire are the same schema, not a widening. A present `true` (or a non-false schema)
 * is still a real difference and must not be stripped.
 */
function withoutClosedAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutClosedAdditionalProperties);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "additionalProperties" && entry === false) continue;
    out[key] = withoutClosedAdditionalProperties(entry);
  }
  return out;
}

/**
 * Whether an advertised JSON Schema subtree is identical to the contract's, or a recognised
 * narrowing of it (#10041).
 *
 * Recognised differences only: (a) a removed key under `properties`, (b) an added or tightened
 * minimum/maximum/minLength/maxLength/minItems/maxItems, (c) an `enum` that is a subset of the
 * contract's, (d) the same rules applied recursively through `items` / `properties`. Nested
 * `required` follows the top-level rule: every advertised requirement must already be required by
 * the contract (dropping a requirement is allowed; inventing one is not).
 */
function isJsonSchemaNarrowing(advertised: unknown, contract: unknown): boolean {
  advertised = withoutClosedAdditionalProperties(advertised);
  contract = withoutClosedAdditionalProperties(contract);
  if (jsonDeepEqual(advertised, contract)) return true;
  if (!isPlainObject(advertised) || !isPlainObject(contract)) return false;

  if (advertised.type !== undefined && advertised.type !== contract.type) return false;
  if (contract.type !== undefined && advertised.type === undefined) return false;

  if (advertised.enum !== undefined || contract.enum !== undefined) {
    if (!Array.isArray(contract.enum) || !Array.isArray(advertised.enum)) return false;
    if (!advertised.enum.every((value) => (contract.enum as unknown[]).some((entry) => jsonDeepEqual(entry, value)))) {
      return false;
    }
  }

  if (advertised.properties !== undefined || contract.properties !== undefined) {
    if (advertised.properties !== undefined && !isPlainObject(advertised.properties)) return false;
    if (contract.properties !== undefined && !isPlainObject(contract.properties)) return false;
    const advertisedProperties = isPlainObject(advertised.properties) ? advertised.properties : {};
    const contractProperties = isPlainObject(contract.properties) ? contract.properties : {};
    for (const key of Object.keys(advertisedProperties)) {
      if (!Object.prototype.hasOwnProperty.call(contractProperties, key)) return false;
      if (!isJsonSchemaNarrowing(advertisedProperties[key], contractProperties[key])) return false;
    }
  }

  if (advertised.items !== undefined || contract.items !== undefined) {
    if (advertised.items === undefined || contract.items === undefined) return false;
    if (!isJsonSchemaNarrowing(advertised.items, contract.items)) return false;
  }

  if (Array.isArray(advertised.required)) {
    const contractRequired = new Set(Array.isArray(contract.required) ? contract.required : []);
    for (const property of advertised.required) {
      if (typeof property !== "string" || !contractRequired.has(property)) return false;
    }
  } else if (advertised.required !== undefined) {
    return false;
  }

  for (const key of BOUND_KEYS) {
    const advertisedBound = advertised[key];
    const contractBound = contract[key];
    if (advertisedBound === undefined && contractBound === undefined) continue;
    if (typeof advertisedBound !== "number" && advertisedBound !== undefined) return false;
    if (typeof contractBound !== "number" && contractBound !== undefined) return false;
    if (advertisedBound === undefined) return false; // contract had a bound the advertisement dropped
    if (contractBound === undefined) continue; // added bound = tightening
    if (LOWER_BOUNDS.has(key) ? advertisedBound < contractBound : advertisedBound > contractBound) return false;
  }

  const handled = new Set<string>(["type", "enum", "properties", "items", "required", ...BOUND_KEYS]);
  for (const key of new Set([...Object.keys(advertised), ...Object.keys(contract)])) {
    if (handled.has(key)) continue;
    if (!jsonDeepEqual(advertised[key], contract[key])) return false;
  }
  return true;
}

/**
 * An advertised input may only NARROW the contract's, never widen it (#9662, #10041).
 *
 * `registerStdioTool`'s override is documented as one-way -- "a server may serve LESS than the contract
 * when its own route cannot honour a field... never used to widen" -- and nothing enforced it. The
 * override is typed as any `z.ZodObject` at all, and no existing check could see a widening:
 * `diffToolSets` compares names, `checkAdvertisedShape` asks only whether the schema is object-typed,
 * and the smoke arguments are synthesized FROM the advertised schema, so a widened schema simply gets
 * widened arguments and passes.
 *
 * Narrowing is the property-name / required checks below, plus a recursive comparison of every shared
 * property's JSON Schema subtree (see `isJsonSchemaNarrowing`). Making an optional contract field
 * required is therefore a widening of the caller's obligations and fails -- which is the case a
 * hand-written override is most likely to get wrong.
 */
export function checkInputNarrowing(expected: readonly McpToolDefinition[], listed: readonly ListedTool[]): string[] {
  const listedByName = new Map(listed.map((tool) => [tool.name, tool]));
  const failures: string[] = [];
  for (const tool of expected) {
    const advertised = listedByName.get(tool.name);
    // Absent is diffToolSets' finding; a schema-less advertisement is checkAdvertisedShape's.
    if (!advertised?.inputSchema) continue;
    const contractProperties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const contractPropertyNames = new Set(Object.keys(contractProperties));
    const contractRequired = new Set((tool.inputSchema as { required?: string[] }).required ?? []);
    const advertisedProperties = advertised.inputSchema.properties ?? {};
    for (const property of Object.keys(advertisedProperties)) {
      if (!contractPropertyNames.has(property)) {
        failures.push(`${tool.name} advertises input property ${property}, which its contract does not declare`);
        continue;
      }
      if (!isJsonSchemaNarrowing(advertisedProperties[property], contractProperties[property])) {
        failures.push(`${tool.name} advertises input property ${property}, which is not a narrowing of its contract`);
      }
    }
    for (const property of advertised.inputSchema.required ?? []) {
      if (!contractRequired.has(property)) failures.push(`${tool.name} requires input property ${property}, which its contract does not require`);
    }
  }
  return failures;
}

/**
 * Every registered tool must have been smoke-called.
 *
 * This is the assertion metagraphed's validator lacks, and the reason 92 of its 205 tools are never
 * exercised: without it, a tool added without a call is simply uncovered, silently. Here the
 * arguments are synthesized from the schema, so "add an entry" is not a chore anyone can forget --
 * this check catches a tool the driver SKIPPED, which only ever happens deliberately.
 */
export function checkEveryToolCalled(listed: readonly ListedTool[], called: ReadonlySet<string>): string[] {
  return listed.filter((tool) => !called.has(tool.name)).map((tool) => `${tool.name} was never smoke-called`);
}

export type VersionLockInput = {
  packageVersion: string;
  /** The compatibility constant, where one exists. Only @loopover/mcp has one; the miner's lock is
   *  the two-way one between its package and what its server advertises. */
  advertisedLatestVersion?: string | undefined;
  /** Read off a CONNECTED client, never re-read from the package.json this is compared against
   *  (#9661) -- hence `undefined` is a case: a server that advertised no version at all. */
  serverInfoVersion: string | undefined;
  /** Which server's `serverInfo` this is, so one helper can lock more than one of them. */
  serverLabel?: string;
};

/**
 * The three places the stdio server's version appears must agree.
 *
 * `LATEST_RECOMMENDED_MCP_VERSION` derives from the package.json today, so two of the three are
 * equal by construction -- but `serverInfo.version` is read independently at server construction and
 * is the one a client actually sees, so it is the one that can drift.
 */
export function checkVersionLock(input: VersionLockInput): string[] {
  const failures: string[] = [];
  if (input.advertisedLatestVersion !== undefined && input.advertisedLatestVersion !== input.packageVersion) {
    failures.push(`compatibility advertises ${input.advertisedLatestVersion} but @loopover/mcp is ${input.packageVersion}`);
  }
  const label = input.serverLabel ?? "stdio";
  // #9661: absent is its own failure. `undefined !== packageVersion` would report it as a mismatch,
  // but the two are not the same problem -- one server drifted, the other advertised nothing at all,
  // and an empty string would otherwise have to be read as a version.
  if (input.serverInfoVersion === undefined || input.serverInfoVersion.trim() === "") {
    failures.push(`${label} serverInfo advertises no version`);
  } else if (input.serverInfoVersion !== input.packageVersion) {
    failures.push(`${label} serverInfo reports ${input.serverInfoVersion} but its package is ${input.packageVersion}`);
  }
  return failures;
}

/**
 * Every path the release automation reads must exist in HEAD.
 *
 * The anti-rot guard metagraphed's validator lacks: its version automation broke silently because
 * nothing checked that the files it keys off still existed. A version lock that only compares
 * constants to each other stays green while the thing that is supposed to update them has stopped
 * running -- the constants agree precisely BECAUSE nothing is touching them.
 */
export function checkWatchedPathsExist(paths: readonly string[], exists: (path: string) => boolean): string[] {
  return paths.filter((path) => !exists(path)).map((path) => `release automation reads ${path}, which does not exist`);
}

/** Format a server's failures for the CLI, or an empty string when it has none. */
export function formatFailures(server: string, failures: readonly string[]): string {
  if (failures.length === 0) return "";
  return [`\n${server}: ${failures.length} failure(s)`, ...failures.map((failure) => `  • ${failure}`)].join("\n");
}
