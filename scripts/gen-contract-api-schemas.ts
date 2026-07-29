// Generates packages/loopover-contract/src/api-schemas.ts from src/openapi/schemas.ts (#9521).
//
// The stdio CLI read every API response as `payload: any` and picked fields out by optional-chaining
// guesswork (`payload.pendingActions ?? []`), so a renamed Worker field degraded silently at runtime
// instead of failing anywhere. To validate responses it needs the response schemas -- but it is a
// separately-published package and cannot import the Worker's `src/`.
//
// Why GENERATED rather than moved: `src/openapi/schemas.ts` names its components with zod-to-openapi's
// `.openapi(name)`, and that method exists only on schemas constructed after `extendZodWithOpenApi` has
// run -- which a leaf package must never do. Naming them at the src layer after the fact does not work
// either, because `.openapi()` CLONES: the composed schemas would still reference the undecorated
// originals and every nested $ref would inline. Zod's own `.meta({ id })` does survive composition, but
// it also propagates through `.nullable()` and `.extend()` clones in ways `.openapi()` does not, which
// silently rewrote three components in the published document when tried.
//
// So `src/openapi/schemas.ts` stays canonical and completely untouched -- the document is byte-identical
// by construction -- and the contract copy is generated with the names stripped, which the CLI does not
// need: it only parses and infers. `--check` in test:ci is what makes the copy safe, exactly like
// gen-selfhost-env-reference.ts and gen-command-reference.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = "src/openapi/schemas.ts";
const OUTPUT = "packages/loopover-contract/src/api-schemas.ts";
const OPENAPI_DOCUMENT = "apps/loopover-ui/public/openapi.json";
const CLI_BIN = "packages/loopover-mcp/bin/loopover-mcp.ts";

/**
 * Every literal `/v1/...` path the CLI hands to its api helpers. Scanned, not listed: a hand-kept endpoint
 * list is exactly the thing this issue exists to delete, and a new call site must not be able to opt out of
 * validation by simply not being added here.
 *
 * The closing delimiter is REQUIRED to match the opener: without it, a template path
 * (`/v1/agent/runs/${id}`) matched up to the `$` and was collected as its truncated prefix -- and a prefix
 * that happens to be a documented base path would put the WRONG endpoint's schema in the table. A trailing
 * query (`?since=...`) is allowed and dropped, since the document keys by path.
 */
export function cliApiPaths(binSource: string): string[] {
  const paths = new Set<string>();
  for (const match of binSource.matchAll(/api(?:Get|Post|Delete|Fetch)\(\s*(?:"([^"$]*\/v1\/[^"$?]*)(?:\?[^"$]*)?"|`([^`$]*\/v1\/[^`$?]*)(?:\?[^`$]*)?`)/g)) {
    paths.add((match[1] ?? match[2])!.replace(/\/+$/, ""));
  }
  return [...paths].sort();
}

type SchemaBlock = { name: string; source: string; exported: boolean };

/** Every top-level `const XSchema = ...` in the source, in declaration order, with its full body. */
export function parseSchemaBlocks(source: string): SchemaBlock[] {
  const declarations = [...source.matchAll(/^(export )?const ([A-Za-z0-9_]+Schema)\s*=/gm)];
  return declarations.map((declaration, index) => {
    const start = declaration.index!;
    const end = index + 1 < declarations.length ? declarations[index + 1]!.index! : source.length;
    return { name: declaration[2]!, source: source.slice(start, end), exported: Boolean(declaration[1]) };
  });
}

type OpenApiDocument = { paths: Record<string, Record<string, unknown> | undefined> };

/**
 * Path -> the schema its 200 refers to, for every CLI path the document describes with a NAMED schema.
 *
 * A path the document does not describe, or describes with an inline (unnamed) 200, is simply absent: the
 * client leaves those unvalidated rather than inventing a shape for them. Those are unspecced-route work
 * (#9531), and the client's own test asserts the absent set stays the known one instead of growing.
 */
export function responseSchemaByPath(document: OpenApiDocument, paths: readonly string[]): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const path of paths) {
    const item = document.paths[path];
    const operation = ((item?.post ?? item?.get ?? item?.delete) ?? {}) as {
      responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    };
    const ref = operation.responses?.["200"]?.content?.["application/json"]?.schema?.$ref;
    if (ref) byPath.set(path, `${ref.split("/").pop()}Schema`);
  }
  return byPath;
}

/** Those schemas plus everything they compose, still in the source's declaration order. */
export function closure(blocks: SchemaBlock[], roots: readonly string[]): SchemaBlock[] {
  const byName = new Map(blocks.map((block) => [block.name, block]));
  const reached = new Set(roots.filter((root) => byName.has(root)));
  const queue = [...reached];
  while (queue.length > 0) {
    const block = byName.get(queue.pop()!)!;
    for (const match of block.source.matchAll(/\b([A-Za-z0-9_]+Schema)\b/g)) {
      const dependency = match[1]!;
      if (dependency !== block.name && byName.has(dependency) && !reached.has(dependency)) {
        reached.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return blocks.filter((block) => reached.has(block.name));
}

const HEADER = `// GENERATED by scripts/gen-contract-api-schemas.ts -- do not edit.
//
// The API response schemas packages/loopover-mcp validates against (#9521). Copied from
// src/openapi/schemas.ts, which stays canonical: see that generator's header for why this is generated
// rather than moved, and why the component names are stripped here.
//
// Every schema is exported, including the ones that are module-private in the source -- a package
// boundary has no other way to share a composed schema's parts.
import { z } from "zod";

`;

export function renderApiSchemas(sourceText: string, documentText: string, binSource: string): string {
  const byPath = responseSchemaByPath(JSON.parse(documentText) as OpenApiDocument, cliApiPaths(binSource));
  const blocks = closure(parseSchemaBlocks(sourceText), [...new Set(byPath.values())]);
  const body = blocks
    .map((block) =>
      block.source
        // The component name is zod-to-openapi's, and this copy never emits a document.
        .replace(/\s*\.openapi\("[A-Za-z0-9_]+"\)/g, "")
        .replace(/^const /, "export const "),
    )
    .join("");
  const table = [...byPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, schema]) => `  "${path}": ${schema},`)
    .join("\n");
  return `${HEADER}${body.trimEnd()}\n\n${TABLE_HEADER}${table}\n} as const;\n\n${TABLE_TYPES}`;
}

const TABLE_HEADER = `/**
 * Every API path the CLI calls whose 200 the document describes with a named schema, and that schema.
 *
 * A path is absent when the document does not describe it, or describes its 200 inline -- the client then
 * returns the body unvalidated rather than inventing a shape. test/unit/mcp-api-client.test.ts pins the
 * absent set so it can only ever shrink.
 */
export const CLI_RESPONSE_SCHEMAS = {
`;

const TABLE_TYPES = `/** A path the client validates. */
export type ValidatedApiPath = keyof typeof CLI_RESPONSE_SCHEMAS;

/** The parsed response type for a validated path -- what the CLI call sites get instead of \`any\`. */
export type ApiResponse<Path extends ValidatedApiPath> = z.infer<(typeof CLI_RESPONSE_SCHEMAS)[Path]>;
`;

export function generate(deps: { readFile?: (path: string) => string } = {}): string {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  return renderApiSchemas(readFile(SOURCE), readFile(OPENAPI_DOCUMENT), readFile(CLI_BIN));
}

function main(): void {
  const check = process.argv.includes("--check");
  const rendered = generate();
  const current = (() => {
    try {
      return readFileSync(OUTPUT, "utf8");
    } catch {
      return null;
    }
  })();
  if (check) {
    if (current === rendered) {
      process.stdout.write(`gen-contract-api-schemas: ${OUTPUT} is up to date.\n`);
      return;
    }
    process.stderr.write(`${OUTPUT} is stale. Run \`npm run contract:api-schemas\` and commit the result.\n`);
    process.exit(1);
  }
  if (current === rendered) {
    process.stdout.write(`gen-contract-api-schemas: ${OUTPUT} already up to date.\n`);
    return;
  }
  writeFileSync(OUTPUT, rendered);
  process.stdout.write(`gen-contract-api-schemas: wrote ${OUTPUT}.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
