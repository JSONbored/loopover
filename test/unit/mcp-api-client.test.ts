import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_RESPONSE_SCHEMAS } from "@loopover/contract/api-schemas";
import {
  cliApiPaths,
  cliParameterisedApiCalls,
  closure,
  declaredPathShapes,
  parseSchemaBlocks,
  referencedLimits,
  responseSchemaByCall,
  responseSchemaByPath,
} from "../../scripts/gen-contract-api-schemas";

// #9521: the typed validated API client. The stdio CLI used to read every response as `payload: any`;
// these pin the three properties that keep that from coming back: the literal is extinct, the validated
// path table matches what the CLI actually calls, and the unvalidated remainder can only shrink.

const BIN_SOURCE = readFileSync(join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.ts"), "utf8");
const OPENAPI_DOCUMENT = JSON.parse(readFileSync(join(process.cwd(), "apps/loopover-ui/public/openapi.json"), "utf8"));

describe("payload: any is extinct (#9521)", () => {
  it("the CLI bin contains no `payload: any` — the grep gate the issue requires", () => {
    // The typed surface is the apiGet/apiPost overloads + CLI_RESPONSE_SCHEMAS; a new `payload: any`
    // is a call site opting back out of it.
    expect(BIN_SOURCE).not.toMatch(/payload: any\b/);
  });

  it("the lib modules contain none either", () => {
    for (const module of ["cli-error", "format-table", "local-branch", "redact-local-path", "telemetry"]) {
      const source = readFileSync(join(process.cwd(), `packages/loopover-mcp/lib/${module}.ts`), "utf8");
      expect(source, `${module}.ts must not read payloads as any`).not.toMatch(/payload: any\b/);
    }
  });
});

describe("CLI_RESPONSE_SCHEMAS ↔ the CLI's real call sites", () => {
  it("validates every literal path the document describes with a named 200 — none skipped", () => {
    const expected = responseSchemaByPath(OPENAPI_DOCUMENT, cliApiPaths(BIN_SOURCE));
    expect([...Object.keys(CLI_RESPONSE_SCHEMAS)].sort()).toEqual([...expected.keys()].sort());
  });

  it("REGRESSION: the unvalidated remainder can only shrink — spec these before adding new ones (#9531)", () => {
    // Paths the CLI calls that the document does not describe with a named 200. Each is real drift the
    // typed client cannot cover yet. Removing one (by adding its response schema to the document and
    // regenerating) is progress; a NEW path landing here means a new endpoint shipped unspecced.
    const validated = new Set(Object.keys(CLI_RESPONSE_SCHEMAS));
    const unvalidated = cliApiPaths(BIN_SOURCE).filter((path) => !validated.has(path));
    expect(unvalidated).toEqual([
      "/v1/agent/runs",
      "/v1/auth/github/device/poll",
      "/v1/auth/github/device/start",
      "/v1/auth/github/session",
      "/v1/auth/logout",
      "/v1/auth/session",
      "/v1/local/remediation-plan",
      "/v1/upstream/drift",
    ]);
  });

  it("rejects a response missing a documented required field, naming it (spot: registry snapshot)", () => {
    // The drift the client exists to catch: a renamed/dropped Worker field now fails with the field's
    // path instead of surfacing as an undefined at a render site.
    const parsed = CLI_RESPONSE_SCHEMAS["/v1/registry/snapshot"].safeParse({ repos: [] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.path[0])).toContain("generatedAt");
  });
});

describe("cliApiPaths", () => {
  it("collects literal /v1 paths from every api helper form and sorts them", () => {
    const source = 'await apiPost("/v1/lint/pr-text", body);\nawait apiGet(`/v1/registry/snapshot`);\napiFetch("/v1/auth/session", {});';
    expect(cliApiPaths(source)).toEqual(["/v1/auth/session", "/v1/lint/pr-text", "/v1/registry/snapshot"]);
  });

  it("REGRESSION: skips template paths outright instead of collecting a truncated prefix", () => {
    // The first scanner matched up to the `$` and collected `/v1/agent/runs` from this — and a truncated
    // prefix that happens to be a documented base path would validate the WRONG endpoint's schema.
    expect(cliApiPaths("await apiGet(`/v1/agent/runs/${runId}`);")).toEqual([]);
  });

  it("drops a query string and a trailing slash from the collected path", () => {
    expect(cliApiPaths('await apiGet("/v1/registry/changes?since=x");\nawait apiGet("/v1/bounties/");')).toEqual([
      "/v1/bounties",
      "/v1/registry/changes",
    ]);
  });
});

describe("responseSchemaByPath", () => {
  const document = {
    paths: {
      "/v1/named": { post: { responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/Named" } } } } } } },
      "/v1/inline": { post: { responses: { 200: { content: { "application/json": { schema: { type: "object" } } } } } } },
      "/v1/get-only": { get: { responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/Got" } } } } } } },
    },
  };

  it("maps a named 200 to its schema const, for POST and GET alike", () => {
    const byPath = responseSchemaByPath(document, ["/v1/named", "/v1/get-only"]);
    expect(byPath.get("/v1/named")).toBe("NamedSchema");
    expect(byPath.get("/v1/get-only")).toBe("GotSchema");
  });

  it("omits an inline 200 and an undocumented path rather than inventing a shape", () => {
    const byPath = responseSchemaByPath(document, ["/v1/inline", "/v1/undocumented"]);
    expect(byPath.size).toBe(0);
  });
});

// #9773: the PARAMETERISED half. Every per-repo and per-contributor call the CLI makes used to miss the
// typed overload, because the scanner rejected any template containing an interpolation -- so those payloads
// read as `any` while the published document described most of them precisely.
describe("parameterised response schemas (#9773)", () => {
  const document = JSON.parse(readFileSync(join(process.cwd(), "apps/loopover-ui/public/openapi.json"), "utf8")) as Parameters<typeof responseSchemaByCall>[0];
  const bin = readFileSync(join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.ts"), "utf8");

  it("keys by METHOD, because one path can serve two of them with different shapes", () => {
    // /v1/repos/{owner}/{repo}/agent/pending-actions LISTS on GET and PROPOSES on POST. A path-keyed table
    // had to guess between them, and guessing handed the GET call site the POST response type -- which the
    // CLI's own `payload.pendingActions` read then contradicted the moment a schema was attached at all.
    const calls = cliParameterisedApiCalls(bin, document);
    expect(calls).toContain("GET /v1/repos/{owner}/{repo}/agent/pending-actions");
    expect(calls).toContain("POST /v1/repos/{owner}/{repo}/agent/pending-actions");

    const byCall = responseSchemaByCall(document, calls);
    expect(byCall.get("GET /v1/repos/{owner}/{repo}/agent/pending-actions")).toBe("ListPendingActionsResponseSchema");
    expect(byCall.get("POST /v1/repos/{owner}/{repo}/agent/pending-actions")).toBe("ProposeActionResponseSchema");
  });

  it("resolves a call composed on a declared base path", () => {
    // The CLI writes `${repoBase}/settings`, never the whole literal. The scanner and the type checker both
    // read the base's declared template-literal shape, so they cannot disagree about what that base is.
    expect(declaredPathShapes(bin).get("toolRepoBase()")).toBe("/v1/repos/${string}/${string}");
    expect(cliParameterisedApiCalls(bin, document)).toContain("GET /v1/repos/{owner}/{repo}/settings");
  });

  it("covers substantially more than the eight paths written out in full", () => {
    expect(cliParameterisedApiCalls(bin, document).length).toBeGreaterThan(20);
  });

  it("carries a bound a copied schema references rather than emitting a file that cannot compile", () => {
    // `closure` follows schema-to-schema references; a schema referencing a plain constant needs that too.
    // Anything declared in the source is copied, anything else is imported from limits.ts where it is
    // restated and pinned -- and a constant missing there fails the contract build, loudly.
    const blocks = closure(parseSchemaBlocks(readFileSync(join(process.cwd(), "src/openapi/schemas.ts"), "utf8")), ["AutomationStateSchema", "RepositorySettingsSchema"]);
    expect(blocks.some((block) => block.name === "AGENT_ACTION_CLASS_VALUES"), "a referenced value is copied").toBe(true);
    expect(referencedLimits(blocks), "one declared elsewhere is imported").toContain("MAX_REVIEW_NAG_COOLDOWN_DAYS");
  });

  it("does not mistake a capitalised word in prose for a constant", () => {
    // The first cut scanned comments too and emitted an import for DELETE, REQUIRED, REST and friends.
    expect(referencedLimits([{ name: "XSchema", exported: true, source: '// DELETE and REQUIRED and REST\nconst XSchema = z.string();' }])).toEqual([]);
  });
});
