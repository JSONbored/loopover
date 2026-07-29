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

/**
 * Every PARAMETERISED `/v1/...` path the CLI calls, normalised to the document's own `{param}` form (#9773).
 *
 * `cliApiPaths` above deliberately rejects anything containing a `$`, so until now the 53 template call
 * sites -- every per-contributor and per-repo endpoint -- fell through to the untyped overload. That, not
 * an oversight in the call sites, is why the stdio bin still reads those payloads as `any`.
 *
 * Each `${...}` becomes `{}` first (its own contents can be an arbitrary expression, including nested
 * braces and a `?:` with slashes in both arms), then the segments are re-keyed positionally against the
 * document's parameter names, so the emitted key is exactly the string `openapi.json` uses.
 */
/**
 * The path SHAPES the bin's own declarations announce, by name (#9773).
 *
 * The CLI composes most of its per-repo calls on a base it built earlier -- `` `${repoBase}/settings` `` --
 * so a scanner reading the call site alone sees a template starting with an interpolation and can resolve
 * nothing. Those bases now carry a template-literal ANNOTATION (`const repoBase: \`/v1/repos/\${string}/\${string}\``)
 * and the helper that builds them declares the same as its return type, because the type checker needs that
 * to resolve the response schema. This reads the same annotations, so the scanner and the type system agree
 * about what a base is rather than each guessing.
 */
export function declaredPathShapes(binSource: string): Map<string, string> {
  const shapes = new Map<string, string>();
  for (const match of binSource.matchAll(/\bconst ([A-Za-z0-9_]+): `(\/v1\/[^`]*)`\s*=/g)) shapes.set(match[1]!, match[2]!);
  for (const match of binSource.matchAll(/\bfunction ([A-Za-z0-9_]+)\([^)]*\): `(\/v1\/[^`]*)`/g)) shapes.set(`${match[1]!}()`, match[2]!);
  return shapes;
}

/**
 * The parameterised calls the CLI makes, as `METHOD path` (#9773).
 *
 * Keyed by METHOD, not by path alone. `/v1/repos/{owner}/{repo}/agent/pending-actions` is called with GET
 * to list the queue and POST to propose an action, and those return different shapes -- a path-keyed table
 * had to guess between them, and guessing "post" handed the GET call site the POST response type.
 */
export function cliParameterisedApiCalls(binSource: string, document: OpenApiDocument): string[] {
  const documented = Object.keys(document.paths).filter((path) => path.includes("{"));
  const shapes = new Map<string, string>();
  for (const documentPath of documented) shapes.set(documentPath.replace(/\{[^}]+\}/g, "{}"), documentPath);

  const declared = declaredPathShapes(binSource);
  const found = new Set<string>();
  const METHOD_BY_HELPER: Record<string, string> = { apiGet: "GET", apiPost: "POST", apiDelete: "DELETE" };
  // A leading `${base}` or `${helper(...)}` is replaced with that declaration's own shape before collapsing,
  // so a composed call resolves to the same path the type checker resolves it to.
  const resolveLead = (template: string): string =>
    template.replace(/^\$\{\s*([A-Za-z0-9_]+)\s*(\([^)]*\))?\s*\}/, (whole, name: string, call?: string) => declared.get(call ? `${name}()` : name) ?? whole);

  for (const match of binSource.matchAll(/\b(apiGet|apiPost|apiDelete)\(\s*`([^`]*)`/g)) {
    const method = METHOD_BY_HELPER[match[1]!]!;
    const raw = resolveLead(match[2]!);
    if (!raw.startsWith("/v1/") || !raw.includes("${")) continue;
    // Collapse each interpolation, honouring nested braces, then drop any trailing query the template adds.
    let collapsed = "";
    for (let index = 0; index < raw.length; index += 1) {
      if (raw[index] === "$" && raw[index + 1] === "{") {
        let depth = 1;
        index += 2;
        while (index < raw.length && depth > 0) {
          if (raw[index] === "{") depth += 1;
          else if (raw[index] === "}") depth -= 1;
          index += 1;
        }
        index -= 1;
        collapsed += "{}";
      } else {
        collapsed += raw[index];
      }
    }
    const withoutQuery = collapsed.split("?")[0]!.replace(/\/+$/, "");
    // A template whose interpolation spans a slash (a conditional query suffix, say) cannot be a path
    // shape; it simply will not match a documented one, and is left unvalidated exactly as before.
    const documentPath = shapes.get(withoutQuery);
    if (documentPath) found.add(`${method} ${documentPath}`);
  }
  return [...found].sort();
}

/** `METHOD path` -> the schema THAT METHOD's 200 names, for the calls the CLI actually makes. */
export function responseSchemaByCall(document: OpenApiDocument, calls: readonly string[]): Map<string, string> {
  const byCall = new Map<string, string>();
  for (const call of calls) {
    const [method, path] = call.split(" ") as [string, string];
    const operation = (document.paths[path]?.[method.toLowerCase()] ?? {}) as {
      responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    };
    const ref = operation.responses?.["200"]?.content?.["application/json"]?.schema?.$ref;
    if (ref) byCall.set(call, `${ref.split("/").pop()}Schema`);
  }
  return byCall;
}

type SchemaBlock = { name: string; source: string; exported: boolean };

/**
 * Every top-level `const` in the source, in declaration order, with its full body.
 *
 * Not just `XSchema`: a schema routinely references a plain value declared beside it
 * (`const AGENT_ACTION_CLASS_VALUES = [...] as const`), and a copy that carried the schema but not that
 * value would emit a file that does not compile. `closure` decides which of these are actually reachable.
 */
export function parseSchemaBlocks(source: string): SchemaBlock[] {
  const declarations = [...source.matchAll(/^(export )?const ([A-Za-z0-9_]+)\s*[:=]/gm)];
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
    // Any declared name, not just `*Schema`: a schema's dependency can be a plain value declared beside it,
    // and following only Schema-suffixed references is what left those behind (#9773).
    for (const match of block.source.matchAll(/\b([A-Za-z0-9_]+)\b/g)) {
      const dependency = match[1]!;
      if (dependency !== block.name && byName.has(dependency) && !reached.has(dependency)) {
        reached.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return blocks.filter((block) => reached.has(block.name));
}

/**
 * The bounds a copied schema references but the copy does not define (#9773).
 *
 * `closure` follows schema-to-schema references; a schema also referencing a plain constant
 * (`MAX_CONTRIBUTOR_OPEN_ITEM_CAP`) would emit a file that does not compile. Those constants live in
 * @loopover/contract's own limits.ts, restated and pinned there, so the generator imports them -- and a
 * constant that has NOT been added there fails the contract build, which is the loud failure this wants.
 */
export function referencedLimits(blocks: SchemaBlock[]): string[] {
  const defined = new Set(blocks.map((block) => block.name));
  const referenced = new Set<string>();
  for (const block of blocks) {
    // Comments and string literals FIRST. Without stripping them, prose picks up every capitalised word a
    // doc comment happens to contain ("DELETE", "REQUIRED", "REST") and emits an import for each.
    const code = block.source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");
    for (const match of code.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
      const name = match[1]!;
      if (!defined.has(name)) referenced.add(name);
    }
  }
  return [...referenced].sort();
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
  const document = JSON.parse(documentText) as OpenApiDocument;
  const byPath = responseSchemaByPath(document, cliApiPaths(binSource));
  const byPattern = responseSchemaByCall(document, cliParameterisedApiCalls(binSource, document));
  const blocks = closure(parseSchemaBlocks(sourceText), [...new Set([...byPath.values(), ...byPattern.values()])]);
  const limits = referencedLimits(blocks);
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
  const patternTable = [...byPattern.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, schema]) => `  "${path}": ${schema},`)
    .join("\n");
  const limitsImport = limits.length > 0 ? `import { ${limits.join(", ")} } from "./limits.js";\n\n` : "";
  return `${HEADER}${limitsImport}${body.trimEnd()}\n\n${TABLE_HEADER}${table}\n} as const;\n\n${PATTERN_TABLE_HEADER}${patternTable}\n} as const;\n\n${TABLE_TYPES}`;
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

const PATTERN_TABLE_HEADER = `/**
 * The same, for the PARAMETERISED paths (#9773) -- keyed by the document's own \`{param}\` template.
 *
 * Separate from the table above because these cannot be looked up by an exact string: the CLI builds them
 * with interpolation, so the match happens at the type level (see MatchApiPath) rather than by key.
 */
export const CLI_PARAMETERISED_RESPONSE_SCHEMAS = {
`;

const TABLE_TYPES = `/** A path the client validates. */
export type ValidatedApiPath = keyof typeof CLI_RESPONSE_SCHEMAS;

/** The parsed response type for a validated path -- what the CLI call sites get instead of \`any\`. */
export type ApiResponse<Path extends ValidatedApiPath> = z.infer<(typeof CLI_RESPONSE_SCHEMAS)[Path]>;

/** A parameterised call the client validates, as \`METHOD path\`. */
export type ParameterisedApiCall = keyof typeof CLI_PARAMETERISED_RESPONSE_SCHEMAS;

/**
 * A pattern with every \`{param}\` widened to \`\${string}\`, so a concrete path can be matched against it.
 *
 * Recursive because a pattern can carry several parameters
 * (\`/v1/contributors/{login}/repos/{owner}/{repo}/decision\`).
 */
export type TemplatedApiPath<Pattern extends string> = Pattern extends \`\${infer Head}{\${string}}\${infer Tail}\`
  ? \`\${Head}\${string}\${TemplatedApiPath<Tail>}\`
  : Pattern;

/**
 * The call a CONCRETE path matches for a given METHOD, or \`never\` when it matches none.
 *
 * This is what lets the CLI keep writing its natural interpolated template and still get the exact response
 * type: the mapped type distributes over every known call and keeps only the arms whose method matches AND
 * whose pattern the string satisfies. Method-aware because one path can serve two of them with different
 * shapes -- \`/v1/repos/{owner}/{repo}/agent/pending-actions\` lists on GET and proposes on POST.
 */
export type MatchApiCall<Method extends string, Path extends string> = {
  [Call in ParameterisedApiCall]: Call extends \`\${Method} \${infer Pattern}\` ? (Path extends TemplatedApiPath<Pattern> ? Call : never) : never;
}[ParameterisedApiCall];

/** The parsed response for a concrete parameterised call. */
export type ParameterisedApiResponse<Method extends string, Path extends string> = z.infer<
  (typeof CLI_PARAMETERISED_RESPONSE_SCHEMAS)[MatchApiCall<Method, Path>]
>;
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
