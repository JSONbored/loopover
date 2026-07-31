import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentToolsIndexSchema,
  AnthropicToolsSchema,
  OpenAiToolsSchema,
  SERVER_CARD_NAME,
  ServerCardSchema,
  buildAgentToolsIndex,
  buildAnthropicTools,
  buildOpenAiTools,
  buildServerCard,
  matchesETag,
  weakETag,
} from "@loopover/contract/discovery";
import { listToolDefinitions } from "@loopover/contract/tools";
import {
  DISCOVERY_PATHS,
  buildDiscoveryDocuments,
  deterministicGeneratedAt,
  discoveryDocumentsFor,
  resetDiscoveryCacheForTesting,
  respondWithDocument,
  toolsForDeployment,
} from "../../src/mcp/discovery-routes";
import { buildOpenApiSpec } from "../../src/openapi/spec";

// #9526: the discovery surfaces are COMPUTED, never committed — metagraphed's committed server card made
// every concurrent tool PR conflict on one generated file. So there is no golden fixture to compare here;
// what these pin are the properties that make the computed answer trustworthy: it describes the deployment
// that is answering, it is stable enough to cache, and it never under- or over-states the tool set.

const TOOLS = listToolDefinitions({ availability: ["cloud"] });
const CONTEXT = { version: "3.15.2", deployment: "cloud" as const, baseUrl: "https://api.loopover.ai", tools: TOOLS, adminEnabled: false };

beforeEach(() => {
  resetDiscoveryCacheForTesting();
});

describe("availability filtering (#9526)", () => {
  it("a cloud card excludes selfhost-only tools, and a selfhost card excludes cloud-only ones", () => {
    const cloud = new Set(toolsForDeployment("cloud", false).map((tool) => tool.name));
    const selfhost = new Set(toolsForDeployment("selfhost", false).map((tool) => tool.name));

    // The registry's availability filter is INCLUSIVE (`both` satisfies any constraint), so "only" has to
    // be derived from the raw field rather than by filtering.
    const cloudOnly = listToolDefinitions().filter((tool) => tool.availability === "cloud").map((tool) => tool.name);
    const selfhostOnly = listToolDefinitions().filter((tool) => tool.availability === "selfhost").map((tool) => tool.name);
    expect(cloudOnly.length, "the fixture needs at least one cloud-only tool to be meaningful").toBeGreaterThan(0);
    expect(selfhostOnly.length).toBeGreaterThan(0);

    for (const name of cloudOnly) expect(selfhost.has(name), `${name} is cloud-only`).toBe(false);
    for (const name of selfhostOnly) expect(cloud.has(name), `${name} is selfhost-only`).toBe(false);
  });

  it("both deployments carry every `both` tool", () => {
    const shared = listToolDefinitions().filter((tool) => tool.availability === "both").map((tool) => tool.name);
    const cloud = new Set(toolsForDeployment("cloud", false).map((tool) => tool.name));
    const selfhost = new Set(toolsForDeployment("selfhost", false).map((tool) => tool.name));
    for (const name of shared) {
      expect(cloud.has(name)).toBe(true);
      expect(selfhost.has(name)).toBe(true);
    }
  });

  it("does NOT filter by locality — a local-git tool is still part of the catalog a client discovers", () => {
    // The remote serves them too; it just expects the caller to supply the branch metadata rather than
    // reading a checkout. Hiding them would under-describe the server.
    const localGit = listToolDefinitions({ locality: ["local-git"] }).filter((tool) => tool.availability === "both").map((tool) => tool.name);
    expect(localGit.length).toBeGreaterThan(0);
    const cloud = new Set(toolsForDeployment("cloud", false).map((tool) => tool.name));
    for (const name of localGit) expect(cloud.has(name)).toBe(true);
  });
});

describe("the server card (#9526)", () => {
  it("names the registry identity, the version, and the streamable-http remote", () => {
    const card = buildServerCard({ ...CONTEXT, generatedAt: deterministicGeneratedAt(CONTEXT.version) });
    expect(card.name).toBe(SERVER_CARD_NAME);
    expect(card.version).toBe("3.15.2");
    expect(card.remotes).toEqual([{ type: "streamable-http", url: "https://api.loopover.ai/mcp" }]);
    expect(card.deployment).toBe("cloud");
  });

  it("trims a trailing slash off the base URL rather than emitting a doubled path", () => {
    const card = buildServerCard({ ...CONTEXT, baseUrl: "https://api.loopover.ai/", generatedAt: "x" });
    expect(card.remotes[0]!.url).toBe("https://api.loopover.ai/mcp");
  });

  it("lists every tool with the catalog fields a client picks by", () => {
    const card = buildServerCard({ ...CONTEXT, generatedAt: "x" });
    expect(card.tools.length).toBe(TOOLS.length);
    const first = card.tools[0]!;
    expect(Object.keys(first).sort()).toEqual(["annotations", "category", "description", "name", "title"]);
  });

  it("declares listChanged, since the gateway re-mounts on that notification", () => {
    expect(buildServerCard({ ...CONTEXT, generatedAt: "x" }).capabilities.tools.listChanged).toBe(true);
  });
});

describe("the agent-tools trio (#9526)", () => {
  const input = { baseUrl: "https://api.loopover.ai", tools: TOOLS, generatedAt: "x" };

  it("every document carries an executor, so the catalog is actionable rather than a list", () => {
    for (const document of [buildAgentToolsIndex(input), buildOpenAiTools(input), buildAnthropicTools(input)]) {
      expect(document.executor).toEqual({ transport: "streamable-http", url: "https://api.loopover.ai/mcp", method: "tools/call" });
    }
  });

  it("the index carries BOTH schemas verbatim from the registry", () => {
    const index = buildAgentToolsIndex(input);
    expect(index.tools.length).toBe(TOOLS.length);
    expect(index.tools[0]!.input_schema).toEqual(TOOLS[0]!.inputSchema);
    expect(index.tools[0]!.output_schema).toEqual(TOOLS[0]!.outputSchema);
  });

  it("the OpenAI projection is the registry's input schema under `parameters` — no second translation", () => {
    const openai = buildOpenAiTools(input);
    expect(openai.tools[0]!.type).toBe("function");
    expect(openai.tools[0]!.function.parameters).toEqual(TOOLS[0]!.inputSchema);
    expect(openai.tools[0]!.function.name).toBe(TOOLS[0]!.name);
  });

  it("the Anthropic projection is the same schema under `input_schema`", () => {
    const anthropic = buildAnthropicTools(input);
    expect(anthropic.tools[0]!.input_schema).toEqual(TOOLS[0]!.inputSchema);
    expect(anthropic.tools[0]!.name).toBe(TOOLS[0]!.name);
  });

  it("all three describe the SAME tool set — one contract, three shapes", () => {
    const names = (list: Array<{ name?: string; function?: { name: string } }>) => list.map((entry) => entry.name ?? entry.function!.name);
    expect(names(buildOpenAiTools(input).tools)).toEqual(names(buildAgentToolsIndex(input).tools));
    expect(names(buildAnthropicTools(input).tools)).toEqual(names(buildAgentToolsIndex(input).tools));
  });
});

describe("caching (#9526)", () => {
  it("generated_at is derived from the VERSION, not the clock", () => {
    // A wall-clock value would change the body every request, changing the ETag with it and making the 304
    // path dead code.
    expect(deterministicGeneratedAt("3.15.2")).toBe("version:3.15.2");
    const first = buildDiscoveryDocuments(CONTEXT);
    const second = buildDiscoveryDocuments(CONTEXT);
    for (const path of DISCOVERY_PATHS) expect(second[path]!.etag).toBe(first[path]!.etag);
  });

  it("a version bump changes every ETag, so a deploy invalidates the caches", () => {
    const before = buildDiscoveryDocuments(CONTEXT);
    const after = buildDiscoveryDocuments({ ...CONTEXT, version: "3.16.0" });
    for (const path of DISCOVERY_PATHS) expect(after[path]!.etag).not.toBe(before[path]!.etag);
  });

  it("weakETag is stable for equal bodies and differs for different ones", () => {
    expect(weakETag("abc")).toBe(weakETag("abc"));
    expect(weakETag("abc")).not.toBe(weakETag("abd"));
    expect(weakETag("")).toMatch(/^W\/"[0-9a-f]+"$/);
  });

  it.each([
    ['the exact tag', (etag: string) => etag],
    ['the tag without its weak prefix', (etag: string) => etag.replace(/^W\//, "")],
    ['a list containing it', (etag: string) => `W/"other", ${etag}`],
    ['a wildcard', () => "*"],
  ])("matchesETag accepts %s", (_label, build) => {
    const etag = weakETag("body");
    expect(matchesETag(build(etag), etag)).toBe(true);
  });

  it.each([
    ["a different tag", 'W/"deadbeef"'],
    ["an empty header", ""],
    ["no header at all", null],
  ])("matchesETag rejects %s", (_label, header) => {
    expect(matchesETag(header, weakETag("body"))).toBe(false);
  });
});

describe("the HTTP response (#9526)", () => {
  it("answers 200 with the document, its ETag, and a revalidating cache policy", async () => {
    const documents = buildDiscoveryDocuments(CONTEXT);
    const response = respondWithDocument(documents["/.well-known/mcp.json"]!, null);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(documents["/.well-known/mcp.json"]!.etag);
    expect(response.headers.get("cache-control")).toContain("must-revalidate");
    expect(JSON.parse(await response.text()).name).toBe(SERVER_CARD_NAME);
  });

  it("answers 304 with NO body when the caller already has the entity", async () => {
    const document = buildDiscoveryDocuments(CONTEXT)["/.well-known/mcp.json"]!;
    const response = respondWithDocument(document, document.etag);
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    // The validators still travel so the cache can extend its entry.
    expect(response.headers.get("etag")).toBe(document.etag);
  });

  it("answers 200 when the caller's tag is stale", () => {
    const document = buildDiscoveryDocuments(CONTEXT)["/.well-known/mcp.json"]!;
    expect(respondWithDocument(document, 'W/"stale"').status).toBe(200);
  });
});

describe("the per-origin memo (#9526)", () => {
  it("returns the same object for a repeat request on one origin", () => {
    expect(discoveryDocumentsFor(CONTEXT)).toBe(discoveryDocumentsFor(CONTEXT));
  });

  it("keeps origins separate, so each advertises its OWN /mcp", () => {
    const primary = discoveryDocumentsFor(CONTEXT);
    const other = discoveryDocumentsFor({ ...CONTEXT, baseUrl: "https://self.example" });
    expect(other).not.toBe(primary);
    expect(JSON.parse(other["/.well-known/mcp.json"]!.body).remotes[0].url).toBe("https://self.example/mcp");
  });

  it("keeps deployments separate, so a self-host card is not a copy of the cloud one", () => {
    const cloud = JSON.parse(discoveryDocumentsFor(CONTEXT)["/.well-known/mcp.json"]!.body);
    const selfhost = JSON.parse(
      discoveryDocumentsFor({ ...CONTEXT, deployment: "selfhost", tools: toolsForDeployment("selfhost", false) })["/.well-known/mcp.json"]!.body,
    );
    expect(selfhost.deployment).toBe("selfhost");
    expect(selfhost.tools.length).not.toBe(cloud.tools.length);
  });
});

describe("the documents are what the API document PROMISES (#9526)", () => {
  const tools = listToolDefinitions();
  const context = { version: "1.2.3", deployment: "cloud" as const, baseUrl: "https://api.loopover.ai", tools };
  const agentToolsInput = { baseUrl: context.baseUrl, tools, generatedAt: deterministicGeneratedAt(context.version) };

  it.each([
    ["/.well-known/mcp.json", ServerCardSchema, () => buildServerCard({ ...context, generatedAt: agentToolsInput.generatedAt })],
    ["/.well-known/agent-tools/index.json", AgentToolsIndexSchema, () => buildAgentToolsIndex(agentToolsInput)],
    ["/.well-known/agent-tools/openai.json", OpenAiToolsSchema, () => buildOpenAiTools(agentToolsInput)],
    ["/.well-known/agent-tools/anthropic.json", AnthropicToolsSchema, () => buildAnthropicTools(agentToolsInput)],
  ])("%s validates against the schema the spec publishes", (_path, schema, build) => {
    // The builders' return types are INFERRED from these schemas, so a mismatch is normally a compile
    // error -- but the JSON Schema in the document is generated from the same object, and this is what
    // proves the runtime value satisfies it rather than merely type-checking against it.
    expect(schema.safeParse(build()).success).toBe(true);
  });

  it("every discovery path has a specced GET operation with a 200 schema and a 304", () => {
    const paths = buildOpenApiSpec().paths as Record<string, { get?: { operationId?: string; responses?: Record<string, { content?: unknown }> } }>;
    for (const path of DISCOVERY_PATHS) {
      const operation = paths[path]?.get;
      expect(operation?.operationId, `${path} must be described in the published document`).toBeTruthy();
      expect(operation!.responses!["200"]!.content, `${path}'s 200 must carry a schema, not just a description`).toBeTruthy();
      // Without the 304 in the document, a generated client has no reason to send if-none-match at all.
      expect(operation!.responses!["304"]).toBeTruthy();
    }
  });
});
