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
  inputSchema?: { type?: string } | undefined;
  outputSchema?: { type?: string } | undefined;
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
  advertisedLatestVersion: string;
  serverInfoVersion: string;
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
  if (input.advertisedLatestVersion !== input.packageVersion) {
    failures.push(`compatibility advertises ${input.advertisedLatestVersion} but @loopover/mcp is ${input.packageVersion}`);
  }
  if (input.serverInfoVersion !== input.packageVersion) {
    failures.push(`stdio serverInfo reports ${input.serverInfoVersion} but @loopover/mcp is ${input.packageVersion}`);
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
