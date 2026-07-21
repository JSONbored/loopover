#!/usr/bin/env tsx
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiSpec } from "../src/openapi/spec";

/** Recursively re-order the keys of `next` to match `current`'s existing key order (keys only in `next` are
 *  appended in their own order), so `ui:openapi:check` produces a stable, minimal diff. Arrays are walked
 *  positionally; non-plain-object values (primitives, `undefined`, `null`, arrays' leaves) pass through
 *  unchanged. Exported for direct unit testing (#7770). */
export function preserveExistingObjectOrder<T>(next: T, current: unknown): T {
  if (Array.isArray(next))
    return next.map((item, index) =>
      preserveExistingObjectOrder(item, Array.isArray(current) ? current[index] : undefined),
    ) as T;
  if (!isPlainObject(next)) return next;

  const currentObject = isPlainObject(current) ? current : {};
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(currentObject)) {
    if (key in next) ordered[key] = preserveExistingObjectOrder(next[key], currentObject[key]);
  }
  for (const key of Object.keys(next)) {
    if (!(key in ordered)) ordered[key] = preserveExistingObjectOrder(next[key], currentObject[key]);
  }
  return ordered as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCurrentSpec(currentText: string): Record<string, unknown> | null {
  try {
    return JSON.parse(currentText) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const target = resolve(root, "apps/loopover-ui/public/openapi.json");
  const checkOnly = process.argv.includes("--check");

  const spec = buildOpenApiSpec();
  spec.servers = [{ url: "https://api.loopover.ai", description: "Production" }];

  const current = await readFile(target, "utf8").catch(() => "");
  const currentSpec = parseCurrentSpec(current);
  const orderedSpec = currentSpec ? preserveExistingObjectOrder(spec, currentSpec) : spec;
  const next = `${JSON.stringify(orderedSpec, null, 2)}\n`;

  if (checkOnly) {
    if (current !== next) {
      console.error("apps/loopover-ui/public/openapi.json is stale; run npm run ui:openapi.");
      process.exit(1);
    }
    console.log("checked apps/loopover-ui/public/openapi.json");
  } else {
    await writeFile(target, next);
    console.log("wrote apps/loopover-ui/public/openapi.json");
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  await main();
}
