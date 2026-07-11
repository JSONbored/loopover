import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #4595 req 10: `ai-chat-qa.ts` must never be able to reach a write/action-command handler or an
// undeclared DB-mutation helper -- it only ever rewrites already-deterministic cached facts into prose.
// Both `maybeProcessReviewCommand`/`maybeProcessGateOverrideCommand`/`maybeProcessPauseCommand` live,
// un-exported, in src/queue/processors.ts, so the only way this module could ever reach them is by
// importing that file (or the command dispatcher/catalog in src/github/commands.ts) directly -- which
// this test forbids at the import-specifier level, independent of what those files currently export.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const srcRoot = join(root, "src");
const CHAT_QA_MODULE = join(srcRoot, "services/ai-chat-qa.ts");

const FORBIDDEN_MODULES = [join(srcRoot, "queue/processors.ts"), join(srcRoot, "github/commands.ts")];

// The only db/repositories exports this module may use: the AI-usage/audit-event recorders and the
// shared daily neuron-budget reader. Any other name (e.g. an issue/PR/comment upsert) would mean this
// "advisory rewrite" module gained a write capability beyond recording its own usage.
const ALLOWED_DB_REPOSITORY_IMPORTS = new Set(["recordAiUsageEvent", "recordAuditEvent", "sumAiEstimatedNeuronsSince"]);

function resolveLocalImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = dirname(fromFile);
  const candidates = [join(base, specifier), join(base, `${specifier}.ts`), join(base, `${specifier}.tsx`), join(base, specifier, "index.ts")];
  for (const candidate of candidates) {
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function parseImportSpecifiers(filePath: string): string[] {
  const content = readFileSync(filePath, "utf8");
  const specifiers = new Set<string>();
  for (const match of content.matchAll(/(?:import|export)\s+[\s\S]*?\sfrom\s+["']([^"']+)["']/g)) {
    specifiers.add(match[1]!);
  }
  for (const match of content.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.add(match[1]!);
  }
  return [...specifiers];
}

function namedImportsFrom(filePath: string, specifier: string): string[] {
  const content = readFileSync(filePath, "utf8");
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s+from\\s+["']${escaped}["']`));
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim());
}

describe("ai-chat-qa.ts import isolation (#4595 req 10)", () => {
  it("never directly imports the action-command dispatcher or handler modules", () => {
    const specifiers = parseImportSpecifiers(CHAT_QA_MODULE);
    const resolved = specifiers.map((specifier) => resolveLocalImport(CHAT_QA_MODULE, specifier)).filter((path): path is string => path !== null);
    const forbiddenHits = resolved.filter((path) => FORBIDDEN_MODULES.includes(path));
    expect(forbiddenHits, `ai-chat-qa.ts must not import: ${forbiddenHits.join(", ")}`).toEqual([]);
  });

  it("only imports the allow-listed db/repositories helpers (no undeclared DB-mutation capability)", () => {
    const imported = namedImportsFrom(CHAT_QA_MODULE, "../db/repositories");
    expect(imported.length).toBeGreaterThan(0);
    const disallowed = imported.filter((name) => !ALLOWED_DB_REPOSITORY_IMPORTS.has(name));
    expect(disallowed, `ai-chat-qa.ts imported an unexpected db/repositories helper: ${disallowed.join(", ")}`).toEqual([]);
  });

  it("does not reference the action-command handler function names anywhere in its source", () => {
    const content = readFileSync(CHAT_QA_MODULE, "utf8");
    for (const name of ["maybeProcessReviewCommand", "maybeProcessGateOverrideCommand", "maybeProcessPauseCommand"]) {
      expect(content, `ai-chat-qa.ts must not reference ${name}`).not.toContain(name);
    }
  });
});
