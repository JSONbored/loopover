#!/usr/bin/env node
// Cross-checks three enumerable "surfaces" that each have a single code source of truth but are also
// meant to be documented EXHAUSTIVELY on specific docs pages: feature flags (src/env.d.ts's
// GITTENSORY_REVIEW_* family), @gittensory commands (src/github/commands.ts's two command catalogs), and
// gate-mode dimensions (src/types.ts's *GateMode fields on RepositorySettings). Nothing else in CI catches a
// docs page silently falling behind when a new flag/command/gate-mode field is added to source but the docs
// page enumerating that surface is never updated -- a reviewer has to notice by eye, and often doesn't.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Extract every unique GITTENSORY_REVIEW_<NAME> flag DECLARED as a TS interface field (e.g.
 *  `GITTENSORY_REVIEW_SAFETY?: string;`) from src/env.d.ts's text. Deliberately anchored on the declaration
 *  shape (optional `?`, then `:`, then whitespace, then `string`) rather than a bare name match, so a comment
 *  that merely MENTIONS a flag name (common in this file's prose-heavy JSDoc) is never mistaken for a real
 *  declaration. */
export function extractGittensoryReviewFlags(envDtsText) {
  const matches = envDtsText.matchAll(/GITTENSORY_REVIEW_[A-Z0-9_]+(?=\??:\s*string)/g);
  return [...new Set([...matches].map((match) => match[0]))];
}

/** Find the array literal assigned to `const <catalogConstName> = [ ... ] as const;` (non-greedy up to the
 *  FIRST `] as const;` after the const name -- catalogs in commands.ts never nest another `] as const;`
 *  inside themselves, so the first close is always the right one) and extract every `id: "<value>"` string
 *  from within that slice. Scoped to the named catalog's own slice so two catalogs in the same file never
 *  bleed into each other's id list. */
export function extractCatalogIds(sourceText, catalogConstName) {
  const catalogPattern = new RegExp(`const\\s+${catalogConstName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s*const;`);
  const catalogMatch = catalogPattern.exec(sourceText);
  if (!catalogMatch) return [];
  const idMatches = catalogMatch[1].matchAll(/id:\s*"([^"]+)"/g);
  return [...new Set([...idMatches].map((match) => match[1]))];
}

/** Extract every unique identifier matching `[a-zA-Z]+GateMode` DECLARED as a field (optional `?` then `:`)
 *  from src/types.ts's text -- e.g. `slopGateMode?: GateRuleMode;` or `linkedIssueGateMode: GateRuleMode;`.
 *  Anchored on the field-declaration shape so a comment mentioning a GateMode name in prose (this file's
 *  JSDoc references sibling gate modes constantly, e.g. "mirrors sizeGateMode") is never mistaken for a real
 *  field. */
export function extractGateModeFields(typesText) {
  const matches = typesText.matchAll(/[a-zA-Z]+GateMode(?=\??:)/g);
  return [...new Set([...matches].map((match) => match[0]))];
}

// The real current *GateMode fields on RepositorySettings in src/types.ts. Each row maps the field to its
// .gittensory.yml alias(es) (the field's own DB/settings name, plus any config-as-code YAML path it is also
// known by) and the docs route filenames (relative to apps/gittensory-ui/src/routes/) that must document it.
// Adding a new *GateMode field to src/types.ts without adding a row here is a docs-drift failure by design
// (see checkDocsDrift step 3) -- the manifest is the single place that maps "a gate dimension exists" to
// "here is where a maintainer can read about it".
export const GATE_MODE_MANIFEST = [
  { field: "linkedIssueGateMode", aliases: ["linkedIssueGateMode", "gate.linkedIssue"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx"] },
  { field: "duplicatePrGateMode", aliases: ["duplicatePrGateMode", "gate.duplicates"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx"] },
  { field: "qualityGateMode", aliases: ["qualityGateMode", "gate.readiness.mode"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx"] },
  { field: "slopGateMode", aliases: ["slopGateMode", "gate.slop.mode"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx"] },
  { field: "sizeGateMode", aliases: ["sizeGateMode", "gate.size"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
  { field: "lockfileIntegrityGateMode", aliases: ["lockfileIntegrityGateMode", "gate.lockfileIntegrity"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
  { field: "claGateMode", aliases: ["claGateMode", "gate.claMode"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
  { field: "mergeReadinessGateMode", aliases: ["mergeReadinessGateMode", "gate.mergeReadiness"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx"] },
  { field: "manifestPolicyGateMode", aliases: ["manifestPolicyGateMode", "gate.manifestPolicy"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx"] },
  { field: "selfAuthoredLinkedIssueGateMode", aliases: ["selfAuthoredLinkedIssueGateMode", "gate.selfAuthoredLinkedIssue"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
  { field: "moderationGateMode", aliases: ["moderationGateMode", "settings.moderationGateMode"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
];

const DOCS_ROUTES_DIR = "apps/gittensory-ui/src/routes";

function defaultReadFile(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

/**
 * Cross-check feature flags, @gittensory commands, and gate-mode dimensions between their code source of
 * truth and the docs pages meant to document them exhaustively. `readFile(root, relativePath)` is injectable
 * so tests can simulate a broken/incomplete docs page or source file without touching the real filesystem.
 * Returns `{ failures, counts }` -- pure given its inputs, no process.exit/console side effects of its own
 * (those live in main()).
 */
export function checkDocsDrift({ root, readFile = defaultReadFile }) {
  const failures = [];
  const read = (relativePath) => readFile(root, relativePath);

  // 1. Feature flags: src/env.d.ts vs docs.tuning.tsx + docs.privacy-security.tsx.
  const envDtsText = read("src/env.d.ts");
  const flags = extractGittensoryReviewFlags(envDtsText);
  if (flags.length < 10) {
    failures.push(`src/env.d.ts: extraction found only ${flags.length} GITTENSORY_REVIEW_* flags -- expected 10+; the extraction regex may be broken`);
  } else {
    const flagDocsPages = ["docs.tuning.tsx", "docs.privacy-security.tsx"];
    for (const flag of flags) {
      for (const page of flagDocsPages) {
        const pageText = read(`${DOCS_ROUTES_DIR}/${page}`);
        if (!pageText.includes(flag)) {
          failures.push(`${page}: missing documentation for feature flag ${flag}`);
        }
      }
    }
  }

  // 2. @gittensory commands: src/github/commands.ts vs docs.maintainer-workflow.tsx + docs.maintainer-install-trust.tsx.
  // A page can satisfy this either by literally mentioning "@gittensory <id>" in its own source, or by
  // importing the generated command-reference constants (apps/gittensory-ui/src/lib/command-reference.ts,
  // regenerated from the same catalogs via `npm run command-reference:check`) -- once a page delegates to the
  // generator, per-id substring checks against its own source would always false-fail, since the literal
  // "@gittensory <id>" text now lives in the generated file, not the page.
  const commandsSourceText = read("src/github/commands.ts");
  const publicCommandIds = extractCatalogIds(commandsSourceText, "PUBLIC_MENTION_COMMAND_CATALOG");
  const maintainerCommandIds = extractCatalogIds(commandsSourceText, "MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG");
  const allCommandIds = [...new Set([...publicCommandIds, ...maintainerCommandIds])];
  if (allCommandIds.length < 15) {
    failures.push(`src/github/commands.ts: extraction found only ${allCommandIds.length} unique @gittensory command ids -- expected 15+; the extraction regex may be broken`);
  } else {
    const commandDocsPages = ["docs.maintainer-workflow.tsx", "docs.maintainer-install-trust.tsx"];
    for (const page of commandDocsPages) {
      const pageText = read(`${DOCS_ROUTES_DIR}/${page}`);
      if (pageText.includes("@/lib/command-reference")) continue;
      for (const id of allCommandIds) {
        if (!pageText.includes(`@gittensory ${id}`)) {
          failures.push(`${page}: missing documentation for command @gittensory ${id}`);
        }
      }
    }
  }

  // 3. Gate-mode dimensions: src/types.ts vs GATE_MODE_MANIFEST vs each row's docs pages.
  const typesText = read("src/types.ts");
  const gateModeFields = extractGateModeFields(typesText);
  if (gateModeFields.length < 5) {
    failures.push(`src/types.ts: extraction found only ${gateModeFields.length} *GateMode fields -- expected 5+; the extraction regex may be broken`);
  } else {
    const manifestFields = new Set(GATE_MODE_MANIFEST.map((row) => row.field));
    for (const field of gateModeFields) {
      if (!manifestFields.has(field)) {
        failures.push(`src/types.ts declares ${field} but GATE_MODE_MANIFEST in scripts/check-docs-drift.mjs has no entry for it -- add a row mapping it to its .gittensory.yml alias(es) and the docs pages that must document it`);
      }
    }

    for (const row of GATE_MODE_MANIFEST) {
      for (const page of row.pages) {
        const pageText = read(`${DOCS_ROUTES_DIR}/${page}`);
        const hasAlias = row.aliases.some((alias) => pageText.includes(alias));
        if (!hasAlias) {
          failures.push(`${page}: missing documentation for gate mode ${row.field} (expected one of: ${row.aliases.join(", ")})`);
        }
      }
    }
  }

  return {
    failures,
    counts: { flags: flags.length, commands: allCommandIds.length, gateModes: gateModeFields.length },
  };
}

function main() {
  const { failures, counts } = checkDocsDrift({ root: process.cwd() });

  if (failures.length > 0) {
    console.error(`Docs-drift check found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }

  console.log(`Docs-drift check ok: ${counts.flags} feature flags, ${counts.commands} commands, ${counts.gateModes} gate-mode fields all documented.`);
}

// Guard so importing this module for its pure exports (tests) never triggers the file-read/exit side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
