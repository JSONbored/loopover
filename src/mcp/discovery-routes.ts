// The `.well-known` discovery surfaces (#9526).
//
// COMPUTED AT REQUEST TIME from the contract registry — never a committed artifact. metagraphed learned
// that the hard way: a committed server card made every concurrent tool PR conflict on the same generated
// file. There is nothing here to regenerate, and nothing a tool PR can conflict on.
//
// One handler factory, two callers: the Worker mounts these on the cloud deployment, and the self-host app
// mounts the SAME routes over its own availability-filtered tool list. That is what makes a self-hosted
// card truthful rather than a copy of the cloud one — a `cloud`-only tool is absent from a self-host card
// because it is absent from that deployment's list, not because a second implementation remembered to
// exclude it.
import {
  buildAgentToolsIndex,
  buildAnthropicTools,
  buildOpenAiTools,
  buildServerCard,
  matchesETag,
  weakETag,
  type DiscoveryDeployment,
} from "@loopover/contract/discovery";
import { listToolDefinitions } from "@loopover/contract/tools";
import type { McpToolDefinition } from "@loopover/contract";

export type DiscoveryContext = {
  version: string;
  deployment: DiscoveryDeployment;
  baseUrl: string;
  tools: readonly McpToolDefinition[];
};

/**
 * The tools a deployment truthfully serves: `both` plus its own kind.
 *
 * Locality is deliberately NOT filtered here. A `local-git` tool is still part of the catalog a client
 * discovers — the remote simply expects the caller to supply the branch metadata rather than reading a
 * checkout — so hiding it would under-describe the server.
 */
export function toolsForDeployment(deployment: DiscoveryDeployment): McpToolDefinition[] {
  // `both` is not listed: the registry's filter treats it as the ABSENCE of a restriction, so it already
  // satisfies either constraint. Naming it here would read as if it were a third deployment.
  return listToolDefinitions({ availability: [deployment] });
}

/**
 * `generated_at` is derived from the VERSION, not the clock.
 *
 * A wall-clock timestamp would change the body on every request, changing the ETag with it and making the
 * 304 path dead code — the cache would never hit. Deriving it from the deploy means the document is stable
 * for as long as the deployment is, which is exactly the cache lifetime a reader wants.
 */
export function deterministicGeneratedAt(version: string): string {
  return `version:${version}`;
}

export type DiscoveryDocument = { body: string; etag: string };

function serialize(payload: unknown): DiscoveryDocument {
  const body = JSON.stringify(payload);
  return { body, etag: weakETag(body) };
}

export function buildDiscoveryDocuments(context: DiscoveryContext): Record<string, DiscoveryDocument> {
  const generatedAt = deterministicGeneratedAt(context.version);
  const agentToolsInput = { baseUrl: context.baseUrl, tools: context.tools, generatedAt };
  return {
    "/.well-known/mcp.json": serialize(buildServerCard({ ...context, generatedAt })),
    "/.well-known/agent-tools/index.json": serialize(buildAgentToolsIndex(agentToolsInput)),
    "/.well-known/agent-tools/openai.json": serialize(buildOpenAiTools(agentToolsInput)),
    "/.well-known/agent-tools/anthropic.json": serialize(buildAnthropicTools(agentToolsInput)),
  };
}

/**
 * Answer one discovery route: 304 when the caller already has this entity, else the document.
 *
 * `public` caching with a short max-age plus the ETag: these change only on deploy, but a stale card is
 * misleading rather than merely old, so the window stays small and revalidation is cheap.
 */
export function respondWithDocument(document: DiscoveryDocument, ifNoneMatch: string | null): Response {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    etag: document.etag,
    "cache-control": "public, max-age=300, must-revalidate",
  };
  if (matchesETag(ifNoneMatch, document.etag)) {
    // 304 carries no body by definition; the validators still travel so the cache can extend its entry.
    return new Response(null, { status: 304, headers: { etag: document.etag, "cache-control": headers["cache-control"] } });
  }
  return new Response(document.body, { status: 200, headers });
}

/**
 * Documents memoized per (deployment, baseUrl, version).
 *
 * The bodies depend only on the registry and those three facts, all fixed for the life of an isolate, so
 * building them once per origin keeps the per-request cost at a Map lookup. Keyed by baseUrl because a
 * deployment can legitimately answer on more than one origin (the configured public origin and whatever the
 * request actually arrived on), and each must advertise its OWN `/mcp` rather than the other's.
 */
const DOCUMENT_CACHE = new Map<string, Record<string, DiscoveryDocument>>();

export function discoveryDocumentsFor(context: DiscoveryContext): Record<string, DiscoveryDocument> {
  const key = `${context.deployment}|${context.version}|${context.baseUrl}`;
  let documents = DOCUMENT_CACHE.get(key);
  if (!documents) {
    documents = buildDiscoveryDocuments(context);
    DOCUMENT_CACHE.set(key, documents);
  }
  return documents;
}

/** Every path these routes answer, so a caller can register them without hardcoding the list. */
export const DISCOVERY_PATHS = [
  "/.well-known/mcp.json",
  "/.well-known/agent-tools/index.json",
  "/.well-known/agent-tools/openai.json",
  "/.well-known/agent-tools/anthropic.json",
] as const;

/** Test-only: drop the memo so one test's origin cannot leak into the next. */
export function resetDiscoveryCacheForTesting(): void {
  DOCUMENT_CACHE.clear();
}
