// Minimal-valid-instance synthesis for a tool's advertised inputSchema (#9520).
//
// WHY SYNTHESIZE RATHER THAN HAND-WRITE. metagraphed's validator keeps a name-keyed table of
// arguments, and its own documented gap is the direct consequence: only 113 of its 205 tools are
// ever actually called, with nothing forcing a new tool to add an entry. A table that must be
// maintained by hand for every tool is a table that rots.
//
// So the arguments for every smoke call are DERIVED from the schema the tool itself advertises. A
// new tool is smoke-called the day it is registered, with no table edit, and the only entries in
// overrides.ts are the ones where a STRUCTURALLY valid value is not a SEMANTICALLY useful one -- a
// repo that has to exist in the seeded fixture, a dry-run flag that has to be set so a write tool
// stays inert.
//
// The output is deliberately MINIMAL: required properties only, shortest permitted strings and
// arrays. A smoke call exists to prove the tool answers and that its answer matches its advertised
// output schema, not to exercise its logic -- the unit suites do that.

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  format?: string;
  minLength?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  default?: unknown;
};

/** A repo-shaped string. `minLength: 3` in this contract always means an owner/repo pair -- the one
 *  place a length floor carries a meaning beyond its number, so "xxx" would be structurally valid
 *  and semantically useless. */
const FIXTURE_REPO_FULL_NAME = "loopover-validate/fixture";

function synthesizeString(schema: JsonSchema): string {
  if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
  const min = schema.minLength ?? 0;
  if (min >= 3) return FIXTURE_REPO_FULL_NAME;
  return min === 0 ? "x" : "x".repeat(min);
}

function synthesizeNumber(schema: JsonSchema): number {
  const floor = schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : (schema.minimum ?? 1);
  return schema.maximum !== undefined ? Math.min(floor, schema.maximum) : floor;
}

/**
 * Build the smallest value that validates against `schema`.
 *
 * Returns `undefined` only for a schema that permits nothing concrete (an empty `anyOf`), which the
 * caller reports rather than guessing around.
 */
export function synthesizeFromSchema(schema: JsonSchema | undefined): unknown {
  if (!schema) return undefined;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;

  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    for (const branch of branches) {
      const value = synthesizeFromSchema(branch);
      if (value !== undefined) return value;
    }
    return undefined;
  }
  if (schema.allOf && schema.allOf.length > 0) {
    // Merge the branches' object shapes. The contract only ever produces `allOf` from `.extend()`,
    // so the branches are always objects and never contradict each other.
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const branch of schema.allOf) {
      Object.assign(properties, branch.properties ?? {});
      required.push(...(branch.required ?? []));
    }
    return synthesizeFromSchema({ type: "object", properties, required });
  }

  const type = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== "null") : schema.type;
  switch (type) {
    case "object": {
      const result: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        const value = synthesizeFromSchema(schema.properties?.[key]);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    case "array": {
      const count = schema.minItems ?? 0;
      if (count === 0) return [];
      const item = synthesizeFromSchema(schema.items);
      return item === undefined ? [] : Array.from({ length: count }, () => item);
    }
    case "string":
      return synthesizeString(schema);
    case "integer":
    case "number":
      return synthesizeNumber(schema);
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      // An unconstrained schema (`z.unknown()`) accepts anything; an empty object is the least
      // surprising thing to send and the only one that survives a downstream `Object.entries`.
      return {};
  }
}

/** The arguments a smoke call sends: the synthesized minimum with any per-tool override on top. */
export function buildSmokeArguments(inputSchema: JsonSchema | undefined, override: Record<string, unknown> = {}): Record<string, unknown> {
  const synthesized = synthesizeFromSchema(inputSchema);
  const base = synthesized !== null && typeof synthesized === "object" && !Array.isArray(synthesized) ? (synthesized as Record<string, unknown>) : {};
  return { ...base, ...override };
}
