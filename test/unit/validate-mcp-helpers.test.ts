// Unit coverage for the contract validator's pure helpers (#9520).
//
// The validator itself boots three real servers and takes ~80s; these cover its decision-making
// directly, including the branches a green run never reaches -- a tool that goes missing, a schema
// that is not object-typed, a version that has drifted, a release path that has been deleted.
import { describe, expect, it } from "vitest";
import {
  checkAdvertisedMetadata,
  checkAdvertisedShape,
  checkEveryToolCalled,
  checkVersionLock,
  checkWatchedPathsExist,
  diffToolSets,
  formatFailures,
} from "../../scripts/lib/validate-mcp/invariants";
import { buildSmokeArguments, synthesizeFromSchema } from "../../scripts/lib/validate-mcp/synthesize-input";
import { overrideFor, RELEASE_AUTOMATION_WATCHED_PATHS, SMOKE_ARGUMENT_OVERRIDES } from "../../scripts/lib/validate-mcp/overrides";
import type { McpToolDefinition } from "@loopover/contract";

const tool = (name: string): McpToolDefinition => ({ name }) as McpToolDefinition;

describe("validate-mcp invariants", () => {
  it("reports a registry entry the server never registered", () => {
    expect(diffToolSets([tool("a"), tool("b")], [{ name: "a" }])).toEqual([
      "registry projects b but the server does not register it",
    ]);
  });

  it("reports a registration with no registry entry", () => {
    expect(diffToolSets([tool("a")], [{ name: "a" }, { name: "rogue" }])).toEqual([
      "server registers rogue but it has no registry entry",
    ]);
  });

  it("passes when the two sets agree", () => {
    expect(diffToolSets([tool("a")], [{ name: "a" }])).toEqual([]);
  });

  describe("advertised metadata matches the registry's projection (#9655)", () => {
    const projected = (name: string, overrides: Partial<McpToolDefinition> = {}): McpToolDefinition =>
      ({ name, title: `${name} title`, description: `${name} description`, annotations: { readOnlyHint: true, destructiveHint: false }, ...overrides }) as McpToolDefinition;
    const advertised = (name: string) => ({
      name,
      title: `${name} title`,
      description: `${name} description`,
      annotations: { readOnlyHint: true, destructiveHint: false },
    });

    it("passes when every advertised field is the projected one", () => {
      expect(checkAdvertisedMetadata([projected("a"), projected("b")], [advertised("a"), advertised("b")])).toEqual([]);
    });

    it("reports a title the server rewrote", () => {
      expect(checkAdvertisedMetadata([projected("a")], [{ ...advertised("a"), title: "Something else" }])).toEqual([
        'a advertises title "Something else", registry says "a title"',
      ]);
    });

    it("reports a description the server rewrote", () => {
      // The exact text is deliberately NOT in the failure: 35 of these were paragraph-length, and a
      // failure listing both in full is unreadable at the point it fires.
      expect(checkAdvertisedMetadata([projected("a")], [{ ...advertised("a"), description: "drifted" }])).toEqual([
        "a advertises a description the registry does not",
      ]);
    });

    it("reports a readOnlyHint that disagrees", () => {
      expect(
        checkAdvertisedMetadata([projected("a", { annotations: { readOnlyHint: false, destructiveHint: false } })], [advertised("a")]),
      ).toEqual(["a advertises readOnlyHint=true, registry says false"]);
    });

    it("reports a destructiveHint that disagrees", () => {
      expect(
        checkAdvertisedMetadata([projected("a", { annotations: { readOnlyHint: false, destructiveHint: true } })], [{ ...advertised("a"), annotations: { readOnlyHint: false, destructiveHint: false } }]),
      ).toEqual(["a advertises destructiveHint=false, registry says true"]);
    });

    it("reports a tool advertising no annotations at all", () => {
      // The defect this check was written for: the raw `Partial` is not what the projection publishes,
      // so "absent" and "the default posture" are different things on the wire.
      expect(checkAdvertisedMetadata([projected("a")], [{ name: "a", title: "a title", description: "a description" }])).toEqual([
        "a advertises readOnlyHint=undefined, registry says true",
        "a advertises destructiveHint=undefined, registry says false",
      ]);
    });

    it("stays quiet about a tool the server never registered — that is diffToolSets' finding", () => {
      expect(checkAdvertisedMetadata([projected("a")], [])).toEqual([]);
    });
  });

  it("requires a description and object-typed input and output schemas", () => {
    const failures = checkAdvertisedShape([
      { name: "ok", description: "d", inputSchema: { type: "object" }, outputSchema: { type: "object" } },
      { name: "blank", description: "   ", inputSchema: { type: "object" }, outputSchema: { type: "object" } },
      { name: "nodesc", inputSchema: { type: "object" }, outputSchema: { type: "object" } },
      { name: "badin", description: "d", inputSchema: { type: "array" }, outputSchema: { type: "object" } },
      { name: "noout", description: "d", inputSchema: { type: "object" } },
      { name: "badout", description: "d", inputSchema: { type: "object" }, outputSchema: { type: "string" } },
    ]);
    expect(failures).toEqual([
      "blank advertises no description",
      "nodesc advertises no description",
      "badin advertises a non-object inputSchema",
      "noout advertises no outputSchema",
      "badout advertises a non-object outputSchema",
    ]);
  });

  it("reports a tool the driver skipped", () => {
    expect(checkEveryToolCalled([{ name: "a" }, { name: "b" }], new Set(["a"]))).toEqual(["b was never smoke-called"]);
    expect(checkEveryToolCalled([{ name: "a" }], new Set(["a"]))).toEqual([]);
  });

  it("locks the three version sites and names whichever drifted", () => {
    expect(checkVersionLock({ packageVersion: "1.2.3", advertisedLatestVersion: "1.2.3", serverInfoVersion: "1.2.3" })).toEqual([]);
    expect(checkVersionLock({ packageVersion: "1.2.3", advertisedLatestVersion: "1.2.2", serverInfoVersion: "1.2.3" })).toEqual([
      "compatibility advertises 1.2.2 but @loopover/mcp is 1.2.3",
    ]);
    expect(checkVersionLock({ packageVersion: "1.2.3", advertisedLatestVersion: "1.2.3", serverInfoVersion: "0.9.0" })).toEqual([
      "stdio serverInfo reports 0.9.0 but @loopover/mcp is 1.2.3",
    ]);
  });

  it("reports a release path that no longer exists", () => {
    expect(checkWatchedPathsExist(["a", "b"], (path) => path === "a")).toEqual(["release automation reads b, which does not exist"]);
    expect(checkWatchedPathsExist(["a"], () => true)).toEqual([]);
  });

  it("formats a failure block, and nothing at all when there are none", () => {
    expect(formatFailures("remote", [])).toBe("");
    expect(formatFailures("remote", ["boom"])).toBe("\nremote: 1 failure(s)\n  • boom");
  });
});

describe("validate-mcp input synthesis", () => {
  it("returns undefined for an absent schema and for a branchless union", () => {
    expect(synthesizeFromSchema(undefined)).toBeUndefined();
    expect(synthesizeFromSchema({ anyOf: [] })).toBeUndefined();
  });

  it("prefers const, then enum, then default", () => {
    expect(synthesizeFromSchema({ const: 7, enum: [1], default: 2 })).toBe(7);
    expect(synthesizeFromSchema({ enum: ["first", "second"] })).toBe("first");
    expect(synthesizeFromSchema({ type: "string", default: "d" })).toBe("d");
  });

  it("takes the first satisfiable branch of a union", () => {
    expect(synthesizeFromSchema({ anyOf: [{ anyOf: [] }, { type: "boolean" }] })).toBe(false);
    expect(synthesizeFromSchema({ oneOf: [{ type: "integer", minimum: 4 }] })).toBe(4);
  });

  it("merges an allOf branch that declares neither properties nor required", () => {
    expect(synthesizeFromSchema({ allOf: [{ type: "object" }, { type: "object", properties: { a: { type: "boolean" } }, required: ["a"] }] })).toEqual({ a: false });
  });

  it("merges the object branches of an allOf", () => {
    expect(
      synthesizeFromSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "boolean" } }, required: ["b"] },
        ],
      }),
    ).toEqual({ a: "x", b: false });
  });

  it("fills only the required properties of an object, and skips one it cannot synthesize", () => {
    expect(
      synthesizeFromSchema({
        type: "object",
        properties: { need: { type: "string" }, skip: { type: "string" }, impossible: { anyOf: [] } },
        required: ["need", "impossible"],
      }),
    ).toEqual({ need: "x" });
    expect(synthesizeFromSchema({ type: "object" })).toEqual({});
  });

  it("honours array minItems, and returns empty when the item cannot be synthesized", () => {
    expect(synthesizeFromSchema({ type: "array", minItems: 2, items: { type: "integer", minimum: 3 } })).toEqual([3, 3]);
    expect(synthesizeFromSchema({ type: "array" })).toEqual([]);
    expect(synthesizeFromSchema({ type: "array", minItems: 1, items: { anyOf: [] } })).toEqual([]);
  });

  it("honours string minLength, and reads a 3+ floor as a repo pair", () => {
    expect(synthesizeFromSchema({ type: "string" })).toBe("x");
    expect(synthesizeFromSchema({ type: "string", minLength: 2 })).toBe("xx");
    expect(synthesizeFromSchema({ type: "string", minLength: 3 })).toBe("loopover-validate/fixture");
    expect(synthesizeFromSchema({ type: "string", format: "date-time" })).toBe("2026-01-01T00:00:00.000Z");
  });

  it("honours numeric floors and ceilings, including exclusiveMinimum", () => {
    expect(synthesizeFromSchema({ type: "number" })).toBe(1);
    expect(synthesizeFromSchema({ type: "integer", minimum: 5 })).toBe(5);
    expect(synthesizeFromSchema({ type: "integer", exclusiveMinimum: 0 })).toBe(1);
    expect(synthesizeFromSchema({ type: "integer", minimum: 9, maximum: 4 })).toBe(4);
  });

  it("handles the remaining scalar types and a nullable union type", () => {
    expect(synthesizeFromSchema({ type: "boolean" })).toBe(false);
    expect(synthesizeFromSchema({ type: "null" })).toBeNull();
    expect(synthesizeFromSchema({ type: ["null", "boolean"] })).toBe(false);
    // An unconstrained schema (`z.unknown()`) accepts anything; an object is the safe default.
    expect(synthesizeFromSchema({})).toEqual({});
  });

  it("layers the per-tool override over the synthesized minimum", () => {
    const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "boolean" } }, required: ["a", "b"] } as const;
    expect(buildSmokeArguments(schema)).toEqual({ a: "x", b: false });
    expect(buildSmokeArguments(schema, { b: true })).toEqual({ a: "x", b: true });
    // A non-object schema cannot contribute a base; the override alone is sent.
    expect(buildSmokeArguments({ type: "array" }, { only: 1 })).toEqual({ only: 1 });
    expect(buildSmokeArguments(undefined)).toEqual({});
  });
});

describe("validate-mcp overrides", () => {
  it("returns an empty override for a tool with no entry", () => {
    expect(overrideFor("loopover_definitely_not_a_tool")).toEqual({});
  });

  it("keeps every write-capable override inert", () => {
    // The point of these entries: the synthesizer sends `false` for every boolean, which would flip
    // a dry-run-by-default tool into its create path.
    expect(SMOKE_ARGUMENT_OVERRIDES.loopover_plan_repo_issues).toMatchObject({ dryRun: true, create: false });
    expect(SMOKE_ARGUMENT_OVERRIDES.loopover_generate_contributor_issue_drafts).toMatchObject({ dryRun: true, create: false });
    expect(SMOKE_ARGUMENT_OVERRIDES.loopover_decide_pending_action).toMatchObject({ decision: "reject" });
  });

  it("watches at least the three package manifests a release touches", () => {
    expect(RELEASE_AUTOMATION_WATCHED_PATHS).toContain("packages/loopover-mcp/package.json");
    expect(RELEASE_AUTOMATION_WATCHED_PATHS).toContain("packages/loopover-engine/package.json");
    expect(RELEASE_AUTOMATION_WATCHED_PATHS).toContain("packages/loopover-miner/expected-engine.version");
  });
});
