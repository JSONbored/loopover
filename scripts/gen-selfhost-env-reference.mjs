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
  "scripts/build-selfhost.mjs",
  "scripts/migrate-selfhost-sqlite-to-postgres.ts",
  "scripts/smoke-observability-traces.mjs",
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

export function collectSelfHostEnvVars({
  rootDir = process.cwd(),
  sourceRoots = DEFAULT_SOURCE_ROOTS,
} = {}) {
  const rows = new Map();
  for (const file of sourceFiles(rootDir, sourceRoots)) {
    const abs = resolve(rootDir, file);
    for (const read of collectEnvReads(readFileSync(abs, "utf8"), file)) {
      if (!rows.has(read.name)) rows.set(read.name, { name: read.name, firstReference: file });
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Deliberately file-only, not `file:line` (#env-reference-churn) -- a line number makes the generated output
// change whenever ANYTHING above an existing read shifts, so two unrelated PRs touching the same source file
// produce two different regenerated rows and collide on rebase. The file path only changes when a read is
// actually added/removed/moved to a different file, which is the only case that should ever require
// regenerating this doc.
function collectEnvReads(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const reads = [];
  const addRead = (name) => {
    if (!ENV_NAME_RE.test(name) || INJECTED_BINDING_NAMES.has(name)) return;
    reads.push({ name });
  };
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && isEnvContainer(node.expression)) {
      addRead(node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      isEnvContainer(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      addRead(node.argumentExpression.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isEnvContainer(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const name = bindingElementName(element);
        if (name) addRead(name);
      }
    } else if (ts.isCallExpression(node) && isStaticEnvHelperCall(node)) {
      addRead(node.arguments[1].text);
    } else if (ts.isCallExpression(node) && isProcessEnvNameHelperCall(node)) {
      addRead(node.arguments[0].text);
    } else if (ts.isCallExpression(node) && isEnvNameLiteralArgHelperCall(node)) {
      const argIndex = ENV_NAME_LITERAL_ARG_HELPERS.get(node.expression.text);
      addRead(node.arguments[argIndex].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return reads;
}

function isStaticEnvHelperCall(node) {
  return (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "envString" &&
    node.arguments.length >= 2 &&
    isEnvContainer(node.arguments[0]) &&
    ts.isStringLiteralLike(node.arguments[1])
  );
}

// Some self-host helpers read `process.env` internally by name rather than taking an env container argument --
// e.g. `parsePositiveIntEnv("QUEUE_CONCURRENCY", { min: 1, fallback: 4 })`. Recognized separately from
// isStaticEnvHelperCall above (envString) because these take the var NAME as arg[0], not arg[1] after a
// container.
const PROCESS_ENV_NAME_HELPERS = new Set(["parsePositiveIntEnv"]);
const ENV_NAME_LITERAL_ARG_HELPERS = new Map([["resolveLocalStoreDbPath", 1]]);

function isProcessEnvNameHelperCall(node) {
  return (
    ts.isIdentifier(node.expression) &&
    PROCESS_ENV_NAME_HELPERS.has(node.expression.text) &&
    node.arguments.length >= 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

function isEnvNameLiteralArgHelperCall(node) {
  if (!ts.isIdentifier(node.expression)) return false;
  const argIndex = ENV_NAME_LITERAL_ARG_HELPERS.get(node.expression.text);
  return (
    argIndex !== undefined &&
    node.arguments.length > argIndex &&
    ts.isStringLiteralLike(node.arguments[argIndex])
  );
}

function bindingElementName(element) {
  const candidate = element.propertyName ?? element.name;
  if (ts.isIdentifier(candidate) || ts.isStringLiteralLike(candidate)) return candidate.text;
  return null;
}

// Unwraps `(x)` and `x as T` (including chained casts like `env as unknown as Record<string, unknown>`, the
// pattern src/services/notify-discord.ts uses to read an env key TypeScript's Env type doesn't declare) so
// isEnvContainer sees the underlying identifier/property-access instead of the cast wrapper (#2907).
function unwrapEnvExpression(node) {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return unwrapEnvExpression(node.expression);
  return node;
}

function isEnvContainer(rawNode) {
  const node = unwrapEnvExpression(rawNode);
  if (ts.isIdentifier(node)) return node.text === "env";
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ((ts.isIdentifier(node.expression) && (node.expression.text === "process" || node.expression.text === "c")) ||
      isEnvContainer(node.expression))
  );
}

function scriptKindFor(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function renderSelfHostEnvReferenceMarkdown(rows) {
  return [
    "| Name | First reference |",
    "| --- | --- |",
    ...rows.map((row) => `| \`${row.name}\` | \`${row.firstReference}\` |`),
  ].join("\n");
}

export function renderSelfHostEnvReferenceModule(rows) {
  const markdown = renderSelfHostEnvReferenceMarkdown(rows);
  const rowLines = rows
    .map(
      (row) =>
        `  {\n    name: ${JSON.stringify(row.name)},\n    firstReference: ${JSON.stringify(row.firstReference)},\n  },`,
    )
    .join("\n");
  const markdownLines = markdown
    .split("\n")
    .map((line) => `  ${JSON.stringify(line)},`)
    .join("\n");
  return `// Generated by scripts/gen-selfhost-env-reference.mjs. Do not edit manually.
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

export function writeSelfHostEnvReference({
  rootDir = process.cwd(),
  outputPath = DEFAULT_OUTPUT_PATH,
  sourceRoots = DEFAULT_SOURCE_ROOTS,
  check = false,
} = {}) {
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

function sourceFiles(rootDir, sourceRoots) {
  const files = [];
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

function walkSourceFiles(dir) {
  const files = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(abs));
    } else if (entry.isFile() && isSupportedSourceFile(abs)) {
      files.push(abs);
    }
  }
  return files;
}

function isSupportedSourceFile(file) {
  return SOURCE_FILE_EXTENSIONS.has(extname(file));
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function main(argv) {
  const check = argv.includes("--check");
  const result = writeSelfHostEnvReference({ check });
  if (check && result.changed) {
    process.stderr.write(
      `gen-selfhost-env-reference: ${result.outputPath} is stale; run npm run selfhost:env-reference.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `gen-selfhost-env-reference: ${check ? "checked" : "wrote"} ${result.rows.length} env var references in ${result.outputPath}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
