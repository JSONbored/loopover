#!/usr/bin/env tsx
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiSpec } from "../src/openapi/spec";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "apps/gittensory-ui/public/openapi.json");
const checkOnly = process.argv.includes("--check");

const spec = buildOpenApiSpec();
spec.servers = [{ url: "https://gittensory-api.aethereal.dev", description: "Production" }];

const next = `${JSON.stringify(spec, null, 2)}\n`;

if (checkOnly) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== next) {
    console.error("apps/gittensory-ui/public/openapi.json is stale; run npm run ui:openapi.");
    process.exit(1);
  }
  console.log("checked apps/gittensory-ui/public/openapi.json");
} else {
  await writeFile(target, next);
  console.log("wrote apps/gittensory-ui/public/openapi.json");
}
