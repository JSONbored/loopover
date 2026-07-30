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

/** Each member of the three-value maintainer subset, quoted, in any casing of quote. Detection is
 *  "all three appear close together", NOT "they appear comma-separated" -- the first version of this check
 *  only matched array literals, and review caught that it therefore missed
 *  `value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR"` sitting in engine.ts with fourteen
 *  call sites. A guard that only recognises one spelling of the thing it is guarding is a list again. */
const OWNER_LITERAL = /["']OWNER["']/;
const MEMBER_LITERAL = /["']MEMBER["']/;
const COLLABORATOR_LITERAL = /["']COLLABORATOR["']/;

/** How many consecutive lines are considered together. A formatter will break a long `||` chain or a
 *  multi-entry array across lines, so a single-line scan would miss the same predicate purely on width. */
const WINDOW_LINES = 4;

function namesAllThree(text: string): boolean {
  return OWNER_LITERAL.test(text) && MEMBER_LITERAL.test(text) && COLLABORATOR_LITERAL.test(text);
}

/** A full eight-value GitHub association vocabulary -- a wire schema, not this predicate. */
const FULL_VOCABULARY = /["']CONTRIBUTOR["']|["']FIRST_TIME(?:R|_CONTRIBUTOR)["']|["']MANNEQUIN["']/;

/**
 * Sites that name all three associations but are NOT this predicate, with the reason.
 *
 * This is an exception list, not a list of known copies -- the difference matters. It records places whose
 * SEMANTICS genuinely differ, each of which would be wrong to "fix"; it does not record duplicates awaiting
 * migration. Mirrors check-regate-sort-key.ts's ALLOWED_OMISSIONS, and an entry has to say why.
 */
export const ALLOWED_DISTINCT_SEMANTICS: ReadonlyMap<string, string> = new Map([
  [
    "packages/loopover-engine/src/settings/command-authorization.ts",
    "Not the maintainer predicate: it maps OWNER/MEMBER to the `maintainer` role and COLLABORATOR to a SEPARATE `collaborator` role. Collapsing the two would silently grant collaborators maintainer-only commands.",
  ],
]);

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
  options: { roots?: readonly string[]; readFile?: (file: string) => string; listFiles?: (root: string) => string[]; allowed?: ReadonlyMap<string, string> } = {},
): AssociationCopy[] {
  const { roots = SCAN_ROOTS, listFiles = listSourceFiles, readFile = (file: string) => readFileSync(join(REPO_ROOT, file), "utf8"), allowed = ALLOWED_DISTINCT_SEMANTICS } = options;
  const copies: AssociationCopy[] = [];
  for (const root of roots) {
    for (const file of listFiles(root)) {
      if (relative(DEFINITION_FILE, file) === "") continue;
      const lines = readFile(file).split("\n");
      let reportedThrough = -1;
      for (const [index] of lines.entries()) {
        if (index <= reportedThrough) continue; // one report per occurrence, not one per overlapping window
        const window = lines.slice(index, index + WINDOW_LINES).join("\n");
        if (!namesAllThree(window)) continue;
        // A window that also names the wider vocabulary is a schema enum, not the maintainer predicate.
        if (FULL_VOCABULARY.test(window)) continue;
        if (allowed.has(file)) continue;
        // Report the line that actually names one of them, not the window's first line -- a window can open
        // on a blank line or a closing brace, which tells a reader nothing about what was found.
        const offset = lines.slice(index, index + WINDOW_LINES).findIndex((l) => OWNER_LITERAL.test(l) || MEMBER_LITERAL.test(l) || COLLABORATOR_LITERAL.test(l));
        const at = index + (offset === -1 ? 0 : offset);
        copies.push({ file, line: at + 1, snippet: (lines[at] ?? "").trim().slice(0, 120) });
        reportedThrough = index + WINDOW_LINES - 1;
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
