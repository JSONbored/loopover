// #9282 (executed by #9521): the UI must not hand-author a TypeScript interface for an API response
// shape that @loopover/contract already defines in zod.
//
// The pilot (PublicStats/PublicRulePrecision) proved the mechanism: apps/loopover-ui derives its render
// types with `z.infer` of the same schema object the Worker serves, so a backend field change is a UI
// compile error. What actually prevents the problem from RECURRING is this check, not the one-time
// migration -- the original hand-typed interface drifted silently for months (it was missing
// `fleetAccuracy.basis` and `rulePrecision.rules[].confirmed` outright), and nothing failed.
//
// The rule is deliberately narrow, so it has no false positives and needs no maintenance: for every type
// the shared public-API module exports, no file under apps/loopover-ui/src may declare its own type or
// interface of that name. Shadowing a shared name is exactly the duplicate this issue exists to stop. It
// grows on its own -- migrating another response shape into the shared module extends the check to it
// with no edit here.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SHARED_SCHEMA_MODULE = "packages/loopover-contract/src/public-api.ts";
const UI_ROOT = "apps/loopover-ui/src";

/** The surface that must stay derived, and the module it must derive from. */
const PILOT_MODEL = "apps/loopover-ui/src/components/site/proof-of-power-stats-model.ts";

export type DerivedTypeViolation = { file: string; typeName: string; reason: string };

/** Every type name the shared module exports -- `export type X`, and `export const XSchema` (whose infer is X). */
export function sharedTypeNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/^export type ([A-Za-z0-9_]+)\b/gm)) names.add(match[1]!);
  for (const match of source.matchAll(/^export const ([A-Za-z0-9_]+)Schema\b/gm)) names.add(match[1]!);
  return [...names].sort();
}

function walk(root: string, files: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      walk(path, files);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

export function findDerivedTypeViolations(
  deps: {
    readFile?: (path: string) => string;
    listUiFiles?: () => string[];
  } = {},
): DerivedTypeViolation[] {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const listUiFiles = deps.listUiFiles ?? (() => walk(UI_ROOT));

  const names = sharedTypeNames(readFile(SHARED_SCHEMA_MODULE));
  const violations: DerivedTypeViolation[] = [];

  for (const file of listUiFiles().sort()) {
    const source = readFile(file);
    for (const name of names) {
      // A local declaration of the shared name. `export type X = z.infer<...>` and `export type { X } from`
      // are the DERIVED forms and must keep passing, so only an object/interface body counts as a duplicate.
      const declaresObject = new RegExp(`\\b(?:type\\s+${name}\\s*=\\s*\\{|interface\\s+${name}\\b)`).test(source);
      if (declaresObject) {
        violations.push({
          file,
          typeName: name,
          reason: `hand-authored; derive it from ${SHARED_SCHEMA_MODULE} with z.infer instead`,
        });
      }
    }
  }

  // The pilot regressing back to a hand-authored shape would leave the names above unused rather than
  // duplicated, so it needs its own assertion.
  const pilot = readFile(PILOT_MODEL);
  if (!pilot.includes("@loopover/contract/public-api")) {
    violations.push({
      file: PILOT_MODEL,
      typeName: "PublicStats",
      reason: "the pilot surface no longer imports the shared schema module at all",
    });
  }

  return violations;
}

function main(): void {
  const violations = findDerivedTypeViolations();
  if (violations.length === 0) {
    process.stdout.write("ui derived types: OK\n");
    return;
  }
  process.stderr.write(`Found ${violations.length} hand-typed API shape(s) the UI must derive instead (#9282):\n`);
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file}: ${violation.typeName} — ${violation.reason}\n`);
  }
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
