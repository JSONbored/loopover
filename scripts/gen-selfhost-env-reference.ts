#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const DEFAULT_OUTPUT_PATH = "apps/loopover-ui/src/lib/selfhost-env-reference.ts";
export const DEFAULT_SOURCE_ROOTS = [
  "src/selfhost",
  "src/server.ts",
  "src/services/notify-discord.ts",
  "src/services/notify-pagerduty.ts",
  // The AI review pipeline reads self-host AI_* knobs (AI_SUMMARIES_ENABLED, AI_PUBLIC_COMMENTS_ENABLED,
  // AI_MAX_OUTPUT_TOKENS, AI_BYOK_DAILY_REPO_LIMIT) here, not under src/selfhost, so they were absent from the
  // generated reference despite being declared self-host vars in env.d.ts (#6993).
  "src/services/ai-review.ts",
  "src/queue/ai-review-orchestration.ts",
  "src/queue/processors.ts",
  "scripts/build-selfhost.ts",
  "scripts/migrate-selfhost-sqlite-to-postgres.ts",
  "scripts/smoke-observability-traces.ts",
];

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SOURCE_FILE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);
const INJECTED_BINDING_NAMES = new Set([
  "AI",
  "AI_EMBED",
  "BROWSER",
  "DB",
  "JOBS",
  "RATE_LIMITER",
  "REVIEW_AUDIT",
  "SELFHOST_TRANSIENT_CACHE",
  "VECTORIZE",
  "WEBHOOKS",
]);

export type SelfHostEnvReferenceRow = {
  name: string;
  firstReference: string;
};

export type SelfHostEnvReferenceOptions = {
  rootDir?: string;
  sourceRoots?: readonly string[];
};

export type WriteSelfHostEnvReferenceOptions = SelfHostEnvReferenceOptions & {
  outputPath?: string;
  check?: boolean;
};

export function collectSelfHostEnvVars({ rootDir = process.cwd(), sourceRoots = DEFAULT_SOURCE_ROOTS }: SelfHostEnvReferenceOptions = {}): SelfHostEnvReferenceRow[] {
  const rows = new Map<string, SelfHostEnvReferenceRow>();
  for (const file of sourceFiles(rootDir, sourceRoots)) {
    const abs = resolve(rootDir, file);
    for (const read of collectEnvReads(readFileSync(abs, "utf8"), file)) {
      if (!rows.has(read.name)) rows.set(read.name, { name: read.name, firstReference: file });
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type EnvRead = { name: string };

// Deliberately file-only, not `file:line` (#env-reference-churn) -- a line number makes the generated output
// change whenever ANYTHING above an existing read shifts, so two unrelated PRs touching the same source file
// produce two different regenerated rows and collide on rebase. The file path only changes when a read is
// actually added/removed/moved to a different file, which is the only case that should ever require
// regenerating this doc.
function collectEnvReads(source: string, fileName: string): EnvRead[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const reads: EnvRead[] = [];
  const addRead = (name: string) => {
    if (!ENV_NAME_RE.test(name) || INJECTED_BINDING_NAMES.has(name)) return;
    reads.push({ name });
  };
  // Locally-declared `const NAME = ["A", "B", ...]` literal-string arrays, so a `for (const x of NAME)` loop
  // whose body reads `env[x]` can be resolved back to the concrete var names -- src/selfhost/preflight.ts's
  // CRITICAL_SECRET_VARS loop reads four tokens (GITHUB_WEBHOOK_SECRET etc.) this way and nowhere else (#8652).
  const literalArrays = collectLiteralStringArrays(sourceFile);
  // Same-file wrapper functions that forward a string PARAMETER (not a literal) into an already-recognized
  // env-name sink -- src/selfhost/queue-common.ts's `envDurationMs(name)` -> `parsePositiveIntEnv(name, ...)`
  // and maintenance-admission.ts's `parsePositiveFloatEnv(name)` -> `process.env[name]`. The var name is only a
  // literal at the wrapper's CALL sites, so each such wrapper is treated like a literal-arg helper (#8651).
  const localWrappers = collectParamForwardingWrappers(sourceFile);
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && isEnvContainer(node.expression)) {
      addRead(node.name.text);
    } else if (ts.isElementAccessExpression(node) && isEnvContainer(node.expression) && ts.isStringLiteralLike(node.argumentExpression)) {
      addRead(node.argumentExpression.text);
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isEnvContainer(node.initializer)) {
      for (const element of node.name.elements) {
        const name = bindingElementName(element);
        if (name) addRead(name);
      }
    } else if (ts.isCallExpression(node) && isStaticEnvHelperCall(node)) {
      addRead((node.arguments[1] as ts.StringLiteralLike).text);
    } else if (ts.isCallExpression(node) && isProcessEnvNameHelperCall(node)) {
      addRead((node.arguments[0] as ts.StringLiteralLike).text);
    } else if (ts.isCallExpression(node) && isEnvNameLiteralArgHelperCall(node)) {
      for (const argIndex of ENV_NAME_LITERAL_ARG_HELPERS.get((node.expression as ts.Identifier).text)!) {
        const arg = node.arguments[argIndex];
        if (arg && ts.isStringLiteralLike(arg)) addRead(arg.text);
      }
    } else if (ts.isForOfStatement(node)) {
      for (const name of envReadingForOfArrayLiterals(node, literalArrays)) addRead(name);
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && localWrappers.has(node.expression.text)) {
      for (const argIndex of localWrappers.get(node.expression.text)!) {
        const arg = node.arguments[argIndex];
        if (arg && ts.isStringLiteralLike(arg)) addRead(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reads;
}

function isStaticEnvHelperCall(node: ts.CallExpression): boolean {
  return (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "envString" &&
    node.arguments.length >= 2 &&
    isEnvContainer(node.arguments[0]!) &&
    ts.isStringLiteralLike(node.arguments[1]!)
  );
}

// Some self-host helpers read `process.env` internally by name rather than taking an env container argument --
// e.g. `parsePositiveIntEnv("QUEUE_CONCURRENCY", { min: 1, fallback: 4 })`. Recognized separately from
// isStaticEnvHelperCall above (envString) because these take the var NAME as arg[0], not arg[1] after a
// container.
const PROCESS_ENV_NAME_HELPERS = new Set(["parsePositiveIntEnv"]);
const ENV_NAME_LITERAL_ARG_HELPERS = new Map<string, readonly number[]>([
  ["resolveLocalStoreDbPath", [1]],
  // createCliProvider(command, modelEnvKey, options, env) (packages/loopover-engine/src/miner/driver-factory.ts)
  // reads env[modelEnvKey] -- a computed access AST-invisible without this, since modelEnvKey is a parameter,
  // not a literal at the read site. The literal var name is only visible at the CALL site (arg index 1). (#6994)
  ["createCliProvider", [1]],
  // resolveSeverityThreshold(env, repoFullName, globalVarName, repoMapVarName, fallback?) (src/services/
  // severity-threshold.ts) reads env[globalVarName] and env[repoMapVarName] internally -- computed accesses
  // AST-invisible at the read site, same as createCliProvider above. Both literal var names are only visible
  // at the CALL site (arg indexes 2 and 3), e.g. POSTHOG_MIN_SEVERITY/POSTHOG_REPO_MIN_SEVERITY in
  // src/selfhost/posthog.ts's resolvePostHogMinSeverity. (#8627)
  ["resolveSeverityThreshold", [2, 3]],
]);

function isProcessEnvNameHelperCall(node: ts.CallExpression): boolean {
  return ts.isIdentifier(node.expression) && PROCESS_ENV_NAME_HELPERS.has(node.expression.text) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!);
}

// Discover same-file wrapper functions that forward a string parameter, unmodified, into an already-recognized
// env-name sink, and return a map of wrapper name -> the parameter index(es) that carry the env-var name at the
// wrapper's call sites. A "sink" is a direct `env[param]`/`process.env[param]` read, an envString/parse*Env
// helper called with the parameter as its name argument, a literal-arg helper, or another already-discovered
// wrapper (resolved to a fixpoint so wrapper-of-wrapper chains are also caught). Generalizes to any such
// forwarding function -- no wrapper name is special-cased (#8651).
function collectParamForwardingWrappers(sourceFile: ts.SourceFile): Map<string, number[]> {
  const candidates: { name: string; params: ts.NodeArray<ts.ParameterDeclaration>; body: ts.Node }[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      candidates.push({ name: node.name.text, params: node.parameters, body: node.body });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      candidates.push({ name: node.name.text, params: node.initializer.parameters, body: node.initializer.body });
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);

  const wrappers = new Map<string, number[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (wrappers.has(candidate.name)) continue;
      const indexes: number[] = [];
      candidate.params.forEach((param, index) => {
        if (ts.isIdentifier(param.name) && bodyForwardsParamAsEnvName(candidate.body, param.name.text, wrappers)) indexes.push(index);
      });
      if (indexes.length > 0) {
        wrappers.set(candidate.name, indexes);
        changed = true;
      }
    }
  }
  return wrappers;
}

// True if `body` forwards the identifier `paramName` as an env-var NAME anywhere: a direct `env[paramName]`
// read, or a call passing `paramName` at the name-argument position of a recognized helper / discovered wrapper.
function bodyForwardsParamAsEnvName(body: ts.Node, paramName: string, knownWrappers: Map<string, number[]>): boolean {
  let found = false;
  const walk = (node: ts.Node) => {
    if (found) return;
    if (ts.isElementAccessExpression(node) && isEnvContainer(node.expression) && ts.isIdentifier(node.argumentExpression) && node.argumentExpression.text === paramName) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node) && callForwardsParamAsName(node, paramName, knownWrappers)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
  return found;
}

// True if `node` calls a recognized name-helper (envString / process-env-name / literal-arg) or an
// already-discovered wrapper with the identifier `paramName` at that callee's env-var-name argument position.
function callForwardsParamAsName(node: ts.CallExpression, paramName: string, knownWrappers: Map<string, number[]>): boolean {
  if (!ts.isIdentifier(node.expression)) return false;
  const callee = node.expression.text;
  const argIsParam = (index: number): boolean => {
    const arg = node.arguments[index];
    return arg !== undefined && ts.isIdentifier(arg) && arg.text === paramName;
  };
  if (callee === "envString") return argIsParam(1);
  if (PROCESS_ENV_NAME_HELPERS.has(callee)) return argIsParam(0);
  const literalArgIndexes = ENV_NAME_LITERAL_ARG_HELPERS.get(callee);
  if (literalArgIndexes) return literalArgIndexes.some((index) => argIsParam(index));
  const wrapperArgIndexes = knownWrappers.get(callee);
  if (wrapperArgIndexes) return wrapperArgIndexes.some((index) => argIsParam(index));
  return false;
}

function isEnvNameLiteralArgHelperCall(node: ts.CallExpression): boolean {
  if (!ts.isIdentifier(node.expression)) return false;
  const argIndexes = ENV_NAME_LITERAL_ARG_HELPERS.get(node.expression.text);
  return argIndexes !== undefined && argIndexes.some((argIndex) => node.arguments.length > argIndex && ts.isStringLiteralLike(node.arguments[argIndex]!));
}

// Collect every locally-declared `const NAME = ["A", "B", ...]` whose initializer is an array of only string
// literals (unwrapping a trailing `as const`). Used to resolve `for (const x of NAME) { env[x] }` loops back to
// concrete var names. Generalizes to any such array -- no var name is special-cased.
function collectLiteralStringArrays(sourceFile: ts.SourceFile): Map<string, string[]> {
  const arrays = new Map<string, string[]>();
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrapEnvExpression(node.initializer);
      if (ts.isArrayLiteralExpression(init) && init.elements.length > 0 && init.elements.every((element) => ts.isStringLiteralLike(element))) {
        arrays.set(
          node.name.text,
          init.elements.map((element) => (element as ts.StringLiteralLike).text),
        );
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return arrays;
}

// If `node` iterates a known literal-string array with a single identifier loop variable whose body reads
// `env[<loopVar>]`, return that array's literal names; otherwise []. This is the `for (const name of
// LOCAL_ARRAY) { env[name] }` computed-read pattern the plain element-access branch can't see (the argument is
// an identifier, not a string literal).
function envReadingForOfArrayLiterals(node: ts.ForOfStatement, literalArrays: Map<string, string[]>): string[] {
  const iterable = unwrapEnvExpression(node.expression);
  if (!ts.isIdentifier(iterable)) return [];
  const literals = literalArrays.get(iterable.text);
  if (!literals) return [];
  if (!ts.isVariableDeclarationList(node.initializer) || node.initializer.declarations.length !== 1) return [];
  const loopVar = node.initializer.declarations[0]!.name;
  if (!ts.isIdentifier(loopVar)) return [];
  return bodyReadsEnvByName(node.statement, loopVar.text) ? literals : [];
}

// True if `body` reads `env[<loopVar>]` anywhere -- a computed element access whose object is an env container
// and whose argument is the loop variable identifier.
function bodyReadsEnvByName(body: ts.Statement, loopVar: string): boolean {
  let found = false;
  const walk = (node: ts.Node) => {
    if (found) return;
    if (ts.isElementAccessExpression(node) && isEnvContainer(node.expression) && ts.isIdentifier(node.argumentExpression) && node.argumentExpression.text === loopVar) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
  return found;
}

function bindingElementName(element: ts.BindingElement): string | null {
  const candidate = element.propertyName ?? element.name;
  if (ts.isIdentifier(candidate) || ts.isStringLiteralLike(candidate)) return candidate.text;
  return null;
}

// Unwraps `(x)` and `x as T` (including chained casts like `env as unknown as Record<string, unknown>`, the
// pattern src/services/notify-discord.ts uses to read an env key TypeScript's Env type doesn't declare) so
// isEnvContainer sees the underlying identifier/property-access instead of the cast wrapper (#2907).
function unwrapEnvExpression(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return unwrapEnvExpression(node.expression);
  return node;
}

function isEnvContainer(rawNode: ts.Expression): boolean {
  const node = unwrapEnvExpression(rawNode);
  if (ts.isIdentifier(node)) return node.text === "env";
  return ts.isPropertyAccessExpression(node) && node.name.text === "env" && (isProcessExpression(node.expression) || isEnvContainer(node.expression));
}

// The base of a `.env` access: a bare `process`/`c` identifier, or `globalThis.process` reached through a cast --
// src/selfhost/posthog.ts reads `(globalThis as unknown as {process?: {env?: ...}}).process?.env?.POSTHOG_SERVER_NAME`,
// where the base of `.env` is a property access on a cast expression rather than an identifier, so the
// identifier-only check silently dropped POSTHOG_SERVER_NAME from the generated reference (#8627).
function isProcessExpression(rawNode: ts.Expression): boolean {
  const node = unwrapEnvExpression(rawNode);
  if (ts.isIdentifier(node)) return node.text === "process" || node.text === "c";
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "process") return false;
  const base = unwrapEnvExpression(node.expression);
  return ts.isIdentifier(base) && base.text === "globalThis";
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function renderSelfHostEnvReferenceMarkdown(rows: readonly SelfHostEnvReferenceRow[]): string {
  return ["| Name | First reference |", "| --- | --- |", ...rows.map((row) => `| \`${row.name}\` | \`${row.firstReference}\` |`)].join("\n");
}

export function renderSelfHostEnvReferenceModule(rows: readonly SelfHostEnvReferenceRow[]): string {
  const markdown = renderSelfHostEnvReferenceMarkdown(rows);
  const rowLines = rows.map((row) => `  {\n    name: ${JSON.stringify(row.name)},\n    firstReference: ${JSON.stringify(row.firstReference)},\n  },`).join("\n");
  const markdownLines = markdown
    .split("\n")
    .map((line) => `  ${JSON.stringify(line)},`)
    .join("\n");
  return `// Generated by scripts/gen-selfhost-env-reference.ts. Do not edit manually.
export type SelfHostEnvReferenceRow = {
  name: string;
  firstReference: string;
};

export const SELFHOST_ENV_REFERENCE_ROWS: SelfHostEnvReferenceRow[] = [
${rowLines}
];

export const SELFHOST_ENV_REFERENCE_MARKDOWN = [
${markdownLines}
].join("\\n");
`;
}

export function writeSelfHostEnvReference({ rootDir = process.cwd(), outputPath = DEFAULT_OUTPUT_PATH, sourceRoots = DEFAULT_SOURCE_ROOTS, check = false }: WriteSelfHostEnvReferenceOptions = {}): {
  changed: boolean;
  outputPath: string;
  rows: SelfHostEnvReferenceRow[];
} {
  const rows = collectSelfHostEnvVars({ rootDir, sourceRoots });
  const output = renderSelfHostEnvReferenceModule(rows);
  const absOutput = resolve(rootDir, outputPath);
  const current = existsSync(absOutput) ? readFileSync(absOutput, "utf8") : null;
  const changed = current !== output;
  if (!check && changed) {
    mkdirSync(dirname(absOutput), { recursive: true });
    writeFileSync(absOutput, output);
  }
  return { changed, outputPath, rows };
}

function sourceFiles(rootDir: string, sourceRoots: readonly string[]): string[] {
  const files: string[] = [];
  for (const sourceRoot of sourceRoots) {
    const abs = resolve(rootDir, sourceRoot);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (stat.isFile()) {
      if (!isSupportedSourceFile(abs)) throw new Error(`Unsupported source root file extension: ${sourceRoot}`);
      files.push(toPosixPath(sourceRoot));
      continue;
    }
    if (!stat.isDirectory()) throw new Error(`Unsupported source root: ${sourceRoot}`);
    if (isSupportedSourceFile(abs)) throw new Error(`Source root ${sourceRoot} looks like a file but is a directory.`);
    for (const file of walkSourceFiles(abs)) {
      files.push(toPosixPath(relative(rootDir, file)));
    }
  }
  return files;
}

const COMPILED_JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  // A same-basename .ts/.tsx sibling in this same directory listing means the .js/.mjs/.cjs file is that
  // source's compiled output, not independent source -- skip it. Once a package's compiled output is
  // gitignored and built on demand rather than committed (#7290/#7291/#7705), whether that .js physically
  // exists on disk varies by environment (a dev machine that happens to have already run a build vs. a
  // fresh CI checkout before its own build step runs), and scanning both would let firstReference
  // attribution silently flip between the .js and .ts path depending on which environment generated the
  // committed reference doc. A genuinely source-only .mjs with no .ts sibling (e.g. scripts/build-
  // selfhost.mjs, reached via a file source root rather than this directory walk, but the same rule would
  // apply if one were ever added to a walked directory) is unaffected -- it has nothing to be shadowed by.
  const tsBasenames = new Set(
    entries.filter((entry) => entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))).map((entry) => entry.name.slice(0, entry.name.lastIndexOf("."))),
  );
  for (const entry of entries) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(abs));
    } else if (entry.isFile() && isSupportedSourceFile(abs)) {
      const ext = extname(entry.name);
      if (COMPILED_JS_EXTENSIONS.has(ext) && tsBasenames.has(entry.name.slice(0, -ext.length))) continue;
      files.push(abs);
    }
  }
  return files;
}

function isSupportedSourceFile(file: string): boolean {
  return SOURCE_FILE_EXTENSIONS.has(extname(file));
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function main(argv: readonly string[]) {
  const check = argv.includes("--check");
  const result = writeSelfHostEnvReference({ check });
  if (check && result.changed) {
    process.stderr.write(`gen-selfhost-env-reference: ${result.outputPath} is stale; run npm run selfhost:env-reference.\n`);
    process.exit(1);
  }
  process.stdout.write(`gen-selfhost-env-reference: ${check ? "checked" : "wrote"} ${result.rows.length} env var references in ${result.outputPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
