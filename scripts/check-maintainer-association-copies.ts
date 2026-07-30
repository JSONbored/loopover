#!/usr/bin/env node
// Guards the maintainer-association vocabulary against re-duplication (#9860).
//
// "Does this author have standing in the repo?" is a security-relevant predicate, and it had been
// re-typed as a bare `["OWNER", "MEMBER", "COLLABORATOR"]` literal in SEVEN places: the mention-command
// gate, the settings preview, the advisory rules, local-branch's owner check, the gate-advisory engine
// TWIN, the engine's pending-PR scenarios (whose own comment admitted "keep the two in sync by hand"),
// and the contributor evidence graph. Two of them had already drifted -- one lower-cased its comparison,
// one was case-sensitive where the others were not -- which is exactly how a copy stops being a copy.
//
// They now all read `MAINTAINER_AUTHOR_ASSOCIATIONS` / `isMaintainerAuthorAssociation` from
// packages/loopover-engine/src/settings/author-association.ts. This check exists so the eighth copy fails
// CI instead of shipping: per #9860's own bar, compute the fact rather than remember it. A checker that
// merely listed the known copies would be the same hand-maintained list one level up.
//
// WHAT IS ALLOWED. The definition module itself, obviously. Also `z.enum([...])` declarations, which spell
// the FULL eight-value GitHub vocabulary rather than the three-value maintainer subset -- those are a wire
// schema, not this predicate, and conflating them would be its own mistake.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Where the predicate is allowed to be spelled out. */
export const DEFINITION_FILE = "packages/loopover-engine/src/settings/author-association.ts";

const SCAN_ROOTS = ["src", "packages/loopover-engine/src", "packages/loopover-contract/src"];
const SOURCE_PATTERN = /\.tsx?$/;
const EXCLUDED_SEGMENT = /(^|\/)(node_modules|dist|dist-test|coverage)(\/|$)/;

/** The three-value maintainer subset, in any quoting/spacing, on one line. */
const MAINTAINER_TRIPLE = /["']OWNER["']\s*,\s*["']MEMBER["']\s*,\s*["']COLLABORATOR["']/;

/** A full eight-value GitHub association vocabulary -- a wire schema, not this predicate. */
const FULL_VOCABULARY = /["']CONTRIBUTOR["']|["']FIRST_TIME(?:R|_CONTRIBUTOR)["']|["']MANNEQUIN["']/;

export type AssociationCopy = { file: string; line: number; snippet: string };

function listSourceFiles(root: string): string[] {
  const absolute = join(REPO_ROOT, root);
  try {
    if (!statSync(absolute).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(absolute, { recursive: true })
    .map(String)
    .filter((entry) => SOURCE_PATTERN.test(entry) && !EXCLUDED_SEGMENT.test(entry))
    .map((entry) => `${root}/${entry}`);
}

/** Pure over its inputs so the check is testable without touching the tree. */
export function findMaintainerAssociationCopies(
  options: { roots?: readonly string[]; readFile?: (file: string) => string; listFiles?: (root: string) => string[] } = {},
): AssociationCopy[] {
  const { roots = SCAN_ROOTS, listFiles = listSourceFiles, readFile = (file: string) => readFileSync(join(REPO_ROOT, file), "utf8") } = options;
  const copies: AssociationCopy[] = [];
  for (const root of roots) {
    for (const file of listFiles(root)) {
      if (relative(DEFINITION_FILE, file) === "") continue;
      for (const [index, line] of readFile(file).split("\n").entries()) {
        if (!MAINTAINER_TRIPLE.test(line)) continue;
        // A line that also names the wider vocabulary is a schema enum, not the maintainer predicate.
        if (FULL_VOCABULARY.test(line)) continue;
        copies.push({ file, line: index + 1, snippet: line.trim().slice(0, 120) });
      }
    }
  }
  return copies.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

function main(): void {
  const copies = findMaintainerAssociationCopies();
  if (copies.length === 0) {
    console.log("maintainer-association vocabulary: OK — one definition, no re-typed copies.");
    return;
  }
  console.error(`Found ${copies.length} re-typed maintainer-association literal(s) (#9860):`);
  for (const copy of copies) console.error(`  ${copy.file}:${copy.line} — ${copy.snippet}`);
  console.error("");
  console.error(`Import from ${DEFINITION_FILE} instead:`);
  console.error("  isMaintainerAuthorAssociation(association)  — membership, case-insensitive");
  console.error("  MAINTAINER_AUTHOR_ASSOCIATIONS             — the list, in precedence order");
  console.error("  classifyAuthorAssociation(association)     — maintainer | contributor | unknown");
  console.error("");
  console.error("src/ reaches it via src/github/author-association.ts, which re-exports the engine's copy.");
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
