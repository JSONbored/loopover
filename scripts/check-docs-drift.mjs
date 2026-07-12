#!/usr/bin/env node
// Cross-checks five enumerable "surfaces" that each have a single code source of truth but are also meant to
// be documented EXHAUSTIVELY somewhere: feature flags (src/env.d.ts's GITTENSORY_REVIEW_* family),
// @gittensory commands (src/github/commands.ts's two command catalogs), gate-mode dimensions (src/types.ts's
// *GateMode fields on RepositorySettings) against specific docs pages, and -- the widened part (#4617) -- the
// FULL RepositorySettings field surface plus every parseable FocusManifest field (packages/gittensory-engine)
// against .gittensory.yml.example. Nothing else in CI catches a docs page/example silently falling behind when
// a new flag/command/gate-mode/settings/manifest field is added to source but the place documenting that
// surface is never updated -- a reviewer has to notice by eye, and often doesn't (#4617's own audit found
// `agentGlobalFreezeOverride` and `review.visual.production_url` this way: both fully live in code, neither
// mentioned anywhere a maintainer would think to look).
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

/** Shared brace-depth-slicing field extractor for any `export type <typeName> = { ... };` object-literal in
 *  `text`. Walks forward from the matching open brace counting `{`/`}` so the type's OWN closing brace is found
 *  regardless of nested object/generic braces inside a field's type (e.g. `ReadonlyArray<{ model: string; ...
 *  }>`), then applies a line-anchored field regex to the sliced body -- safe because every field in every type
 *  this script reads (`RepositorySettings`, `FocusManifest` and its nested config types) is written one-per-line
 *  by this repo's Prettier config; verified for both by their complete absence of a multi-line inline-object
 *  field type as of this writing. Returns `null` when `typeName` has no such declaration in `text` (so callers
 *  can tell "not a local object-literal type" from "declared but empty"), else `[{name, typeText}]` pairs in
 *  declaration order -- `typeText` is the field's own declared type (the text after its `:` up to its
 *  terminating top-level `;`), used by `extractFocusManifestFields` to detect a bare reference to another local
 *  type worth recursing into. */
function extractTypeLiteralFieldEntries(text, typeName) {
  const declPattern = new RegExp(`export type ${typeName}\\s*=\\s*\\{`);
  const declMatch = declPattern.exec(text);
  if (!declMatch) return null;
  const bodyStart = declMatch.index + declMatch[0].length;
  let depth = 1;
  let index = bodyStart;
  for (; index < text.length && depth > 0; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}") depth--;
  }
  const body = text.slice(bodyStart, index - 1);
  const fields = [];
  for (const line of body.split("\n")) {
    const fieldMatch = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??:\s*(.+);\s*$/.exec(line);
    if (fieldMatch) fields.push({ name: fieldMatch[1], typeText: fieldMatch[2].trim() });
  }
  return fields;
}

/** Every top-level field name DECLARED directly on the `RepositorySettings` object-literal type in src/types.ts
 *  (#4617) -- the FULL ~100-field surface, not just the `*GateMode` subset `extractGateModeFields` above
 *  targets. Unlike that regex (which matches a NAME SHAPE anywhere in the file), this is anchored on the type's
 *  own brace boundary via `extractTypeLiteralFieldEntries`, so it can never pick up an unrelated same-shaped
 *  field from a different type declared later in the file. Returns every field, unfiltered, in declaration
 *  order -- judging which fields are genuinely yml-configurable vs internal bookkeeping is `checkDocsDrift`'s
 *  job (`NOT_YML_CONFIGURABLE_SETTINGS_FIELDS` below), mirroring how `extractGateModeFields` also returns every
 *  match unfiltered and leaves the GATE_MODE_MANIFEST cross-reference to the caller. */
export function extractRepositorySettingsFields(typesText) {
  return (extractTypeLiteralFieldEntries(typesText, "RepositorySettings") ?? []).map((entry) => entry.name);
}

/** RepositorySettings fields deliberately excluded from the "every field must have SOME
 *  `.gittensory.yml.example` mention" check below, for three distinct reasons -- flagging any as "undocumented"
 *  would be a false drift signal, not a real gap:
 *   - Not a maintainer-settable knob at all: `repoFullName` is the row's own identity key (set once at
 *     creation, the opposite of something a maintainer overrides via config); `createdAt`/`updatedAt` are
 *     DB-row bookkeeping timestamps.
 *   - `agentGlobalFreezeOverride`: genuinely settable, but DELIBERATELY never documented in the PUBLIC
 *     `.gittensory.yml.example` -- it is settable only from the self-host operator's own PRIVATE config
 *     (`source: "api_record"` in `parseSettingsOverride`, packages/gittensory-engine/src/focus-manifest.ts),
 *     never from a repo's own committed, maintainer-owned manifest (#4391's scope-leak fix). Documenting it in
 *     the public example would misleadingly suggest a repo maintainer can set it themselves -- see the same
 *     exclusion, with the same rationale, in `SETTINGS_OPERATOR_ONLY_FIELDS` in
 *     test/unit/focus-manifest.test.ts's `.gittensory.yml.example field-exhaustiveness` suite. (An #4617 audit
 *     pass first flagged this field as an undocumented gap without that context; cross-checking the existing
 *     exhaustiveness suite before "fixing" it here caught the false positive.)
 *   - `skipAutomationBotAuthors`: genuinely settable (global env default + per-repo `inherit`/`off`/`enabled`
 *     override, mirroring `moderationGateMode`'s shape), but DELIBERATELY not wired into the
 *     FocusManifest/`.gittensory.yml` parsing path -- DB-only for now, confirmed as an intentional scope choice
 *     for this feature rather than an oversight. It is correctly absent from `FocusManifestSettings` (so the
 *     separate `.gittensory.yml.example` field-exhaustiveness suite never expected a token for it either). */
const NOT_YML_CONFIGURABLE_SETTINGS_FIELDS = new Set([
  "repoFullName",
  "createdAt",
  "updatedAt",
  "agentGlobalFreezeOverride",
  "skipAutomationBotAuthors",
]);

/** RepositorySettings fields whose `.gittensory.yml.example` documentation exists under a DIFFERENT, shorter
 *  name than the field itself -- almost always because the yml groups several sibling fields under one named
 *  block (`gate.aiReview.*`, `gate.cla.*`, `gate.slop.*`, `gate.copycat.*`, `gate.readiness.*`) and so drops the
 *  shared prefix the flat RepositorySettings field name carries to distinguish it from its siblings (e.g.
 *  `aiReviewCloseConfidence` is documented as just `closeConfidence`, nested under the `aiReview:` block --
 *  verified against the real `.gittensory.yml.example` for every row below). A field landing here is a
 *  deliberate, reviewed judgment call that it IS genuinely documented, just not findable by a literal name
 *  match -- unlike GATE_MODE_MANIFEST (checked against specific docs ROUTE pages), `aliases` here is checked
 *  against the WHOLE `.gittensory.yml.example` file, matching #4617's "SOME mention" ask, so one representative
 *  alias per row is enough. Any `*GateMode` field is deliberately absent from this manifest even though its own
 *  yml key is ALSO renamed the same way -- GATE_MODE_MANIFEST above already owns that exhaustive cross-check. */
export const SETTINGS_ALIAS_MANIFEST = [
  { field: "reviewCheckMode", aliases: ["checkMode"] },
  { field: "gatePack", aliases: ["pack:"] },
  { field: "qualityGateMinScore", aliases: ["minScore"] },
  { field: "slopGateMinScore", aliases: ["minScore"] },
  { field: "copycatGateMinScore", aliases: ["minScore"] },
  { field: "claConsentPhrase", aliases: ["consentPhrase"] },
  { field: "claCheckRunName", aliases: ["checkRunName"] },
  { field: "claCheckRunAppSlug", aliases: ["checkRunAppSlug"] },
  { field: "gateDryRun", aliases: ["dryRun"] },
  { field: "slopAiAdvisory", aliases: ["aiAdvisory"] },
  { field: "aiReviewMode", aliases: ["aiReview:"] },
  { field: "aiReviewByok", aliases: ["byok"] },
  { field: "aiReviewProvider", aliases: ["aiReview:"] },
  { field: "aiReviewModel", aliases: ["aiReview:"] },
  { field: "aiReviewAllAuthors", aliases: ["allAuthors"] },
  { field: "aiReviewCloseConfidence", aliases: ["closeConfidence"] },
  { field: "aiReviewLowConfidenceDisposition", aliases: ["lowConfidenceDisposition"] },
  { field: "aiReviewCombine", aliases: ["aiReview:"] },
  { field: "aiReviewOnMerge", aliases: ["onMerge"] },
  { field: "aiReviewReviewers", aliases: ["reviewers:"] },
  { field: "requireFreshRebaseWindowMinutes", aliases: ["requireFreshRebaseWindow"] },
];

/** camelCase -> snake_case, matching the casing convention `.gittensory.yml`'s `review:` block (and everything
 *  nested under it, e.g. `review.visual.*`) uses for its own keys -- e.g. `productionUrl` -> `production_url`.
 *  Every OTHER FocusManifest-reachable block keeps its source field's camelCase spelling verbatim in the yml
 *  (matching the top-level manifest fields and the `gate:`/`settings:` blocks), for which this is a harmless
 *  no-op: a name with no lower-to-upper case boundary is unchanged by the transform. */
function toSnakeCase(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Leaf fields never worth flagging as "undocumented" even though they're syntactically object-literal fields
 *  on a FocusManifest-reachable type: parser-computed bookkeeping the yml author never sets. `present`/`source`/
 *  `warnings` record whether/how a block was configured (an OUTPUT of parsing, not an input); `sharedConfigSource`
 *  is explicitly documented as runtime-only provenance by its own doc comment ("Never parsed from maintainer
 *  YAML -- set by the private-config loader only"). */
const FOCUS_MANIFEST_BOOKKEEPING_FIELDS = new Set(["present", "source", "warnings", "sharedConfigSource"]);

/** Top-level FocusManifest fields deliberately NOT walked by `extractFocusManifestFields`: `gate`
 *  (`FocusManifestGateConfig`) and `settings` (`FocusManifestSettings`) are the config-as-code MIRROR of
 *  RepositorySettings' `gate*Mode`/`settings:`-block fields -- the SAME underlying settings, reached through a
 *  second, yml-shaped parsing path (`parseGateConfig` / `parseSettingsOverride` in this same file) that renames
 *  several fields yet again (e.g. RepositorySettings' `slopGateMinScore` is FocusManifestGateConfig's
 *  `slopMinScore`, itself yml `gate.slop.minScore`). Walking them here too would re-flag the exact same knobs
 *  under a THIRD set of names for zero new coverage; the RepositorySettings-based checks above already own that
 *  surface. `review`/`features`/`contentLane`/`repoDocGeneration`/`reviewRecap`/`maintainerRecap` have no
 *  RepositorySettings counterpart at all -- config-as-code-only surfaces this script had zero coverage of
 *  before #4617. */
const FOCUS_MANIFEST_SKIP_TOP_LEVEL_FIELDS = new Set(["gate", "settings"]);

/** Every leaf (non-recursable) field reachable from the `FocusManifest` type in `focusManifestText` (#4617),
 *  returned as dotted paths built from the SOURCE field names (e.g. `"review.visual.productionUrl"` --
 *  `checkDocsDrift` derives the yml-cased spelling via `toSnakeCase` for the actual doc lookup). Recurses into
 *  any field whose OWN declared type is a bare reference to another local `export type <Name> = { ... }` in the
 *  same file (e.g. `review: FocusManifestReviewConfig`, then `visual: VisualConfig` inside THAT), so a knob
 *  nested three levels deep like `review.visual.production_url` is enumerated exactly like a top-level one --
 *  unlike RepositorySettings, FocusManifest's real config surface is NOT flat. A field typed as an array/union/
 *  Record/generic (e.g. `pathInstructions: ReviewPathInstruction[]`, `fields: Partial<Record<ReviewFieldKey,
 *  boolean>>`) is treated as ONE leaf itself rather than recursed into -- it is documented (or not) as a single
 *  structured knob, matching how the rest of this script treats `aiReviewReviewers`'s array-of-objects shape. */
export function extractFocusManifestFields(focusManifestText) {
  const leaves = [];
  const visitedTypes = new Set();

  function walk(typeName, pathPrefix) {
    if (visitedTypes.has(typeName)) return; // guards a hypothetical future cycle; no real cycle exists today
    visitedTypes.add(typeName);
    const entries = extractTypeLiteralFieldEntries(focusManifestText, typeName);
    if (!entries) return;
    for (const { name, typeText } of entries) {
      if (FOCUS_MANIFEST_BOOKKEEPING_FIELDS.has(name)) continue;
      if (pathPrefix.length === 0 && FOCUS_MANIFEST_SKIP_TOP_LEVEL_FIELDS.has(name)) continue;
      const path = [...pathPrefix, name];
      const referencedType = /^[A-Z][a-zA-Z0-9]*$/.test(typeText) ? typeText : null;
      if (referencedType && extractTypeLiteralFieldEntries(focusManifestText, referencedType)) {
        walk(referencedType, path);
      } else {
        leaves.push(path.join("."));
      }
    }
  }

  walk("FocusManifest", []);
  return leaves;
}

/** FocusManifest leaf fields (dotted paths, same shape `extractFocusManifestFields` returns) whose
 *  `.gittensory.yml.example` documentation exists under a shorter name than their own doc comment's dotted-path
 *  tag would suggest -- e.g. `review.footerText`'s own field carries no `` `review.footer.text` `` tag at all
 *  (unlike most of its siblings), and is in fact documented as just `footer:` (a nested `text:` sub-key).
 *  Mirrors SETTINGS_ALIAS_MANIFEST's reasoning exactly, one level down. */
export const FOCUS_MANIFEST_ALIAS_MANIFEST = [
  { field: "review.footerText", aliases: ["footer:"] },
  { field: "review.enrichmentAnalyzers", aliases: ["enrichment:"] },
  { field: "review.reviewMemory", aliases: ["memory:"] },
];

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
  { field: "copycatGateMode", aliases: ["copycatGateMode", "gate.copycat.mode"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx"] },
  { field: "sizeGateMode", aliases: ["sizeGateMode", "gate.size"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
  { field: "lockfileIntegrityGateMode", aliases: ["lockfileIntegrityGateMode", "gate.lockfileIntegrity"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
  { field: "claGateMode", aliases: ["claGateMode", "gate.claMode"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
  { field: "mergeReadinessGateMode", aliases: ["mergeReadinessGateMode", "gate.mergeReadiness"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx"] },
  { field: "manifestPolicyGateMode", aliases: ["manifestPolicyGateMode", "gate.manifestPolicy"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx"] },
  { field: "selfAuthoredLinkedIssueGateMode", aliases: ["selfAuthoredLinkedIssueGateMode", "gate.selfAuthoredLinkedIssue"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
  { field: "linkedIssueSatisfactionGateMode", aliases: ["linkedIssueSatisfactionGateMode", "gate.linkedIssueSatisfaction"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
  { field: "moderationGateMode", aliases: ["moderationGateMode", "settings.moderationGateMode"], pages: ["docs.how-reviews-work.tsx", "docs.tuning.tsx", "docs.github-app.tsx"] },
];

const DOCS_ROUTES_DIR = "apps/gittensory-ui/src/routes";

function defaultReadFile(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

/**
 * Cross-check feature flags, @gittensory commands, gate-mode dimensions, the full RepositorySettings surface,
 * and every parseable FocusManifest field between their code source of truth and wherever they're meant to be
 * documented exhaustively (specific docs pages for the first three; `.gittensory.yml.example` for the last
 * two, #4617). `readFile(root, relativePath)` is injectable so tests can simulate a broken/incomplete docs
 * page or source file without touching the real filesystem. Returns `{ failures, counts }` -- pure given its
 * inputs, no process.exit/console side effects of its own (those live in main()).
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
    const commandDocsPages = ["docs.maintainer-workflow.tsx", "docs.maintainer-install-trust.tsx", "docs.gittensory-commands.tsx"];
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

  // 4. The FULL RepositorySettings surface (#4617): every field, not just *GateMode, vs .gittensory.yml.example.
  // A field passes when its literal name appears anywhere in the example file, when it's already covered
  // exhaustively by GATE_MODE_MANIFEST above (checked against docs pages, not repeated here), when it's judged
  // not yml-configurable at all (NOT_YML_CONFIGURABLE_SETTINGS_FIELDS), or when SETTINGS_ALIAS_MANIFEST records
  // it as documented under a different name.
  const repositorySettingsFields = extractRepositorySettingsFields(typesText);
  if (repositorySettingsFields.length < 20) {
    failures.push(
      `src/types.ts: extraction found only ${repositorySettingsFields.length} RepositorySettings fields -- expected 20+; the extraction regex may be broken`,
    );
  } else {
    const gateModeManifestFields = new Set(GATE_MODE_MANIFEST.map((row) => row.field));
    const settingsAliases = new Map(SETTINGS_ALIAS_MANIFEST.map((row) => [row.field, row.aliases]));
    const ymlExampleText = read(".gittensory.yml.example");
    for (const field of repositorySettingsFields) {
      if (NOT_YML_CONFIGURABLE_SETTINGS_FIELDS.has(field)) continue;
      if (gateModeManifestFields.has(field)) continue;
      if (ymlExampleText.includes(field)) continue;
      const aliases = settingsAliases.get(field);
      if (aliases?.some((alias) => ymlExampleText.includes(alias))) continue;
      failures.push(
        `.gittensory.yml.example: missing any mention of RepositorySettings field "${field}" -- document it there (or the relevant reference doc), or add a SETTINGS_ALIAS_MANIFEST row in scripts/check-docs-drift.mjs if it's already documented under a different yml key name`,
      );
    }
  }

  // 5. Every parseable FocusManifest field (#4617), excluding gate:/settings: (already exhaustively covered by
  // step 4 above through their RepositorySettings mirror), vs .gittensory.yml.example.
  const focusManifestText = read("packages/gittensory-engine/src/focus-manifest.ts");
  const focusManifestFields = extractFocusManifestFields(focusManifestText);
  if (focusManifestFields.length < 15) {
    failures.push(
      `packages/gittensory-engine/src/focus-manifest.ts: extraction found only ${focusManifestFields.length} FocusManifest leaf fields -- expected 15+; the extraction regex may be broken`,
    );
  } else {
    const focusManifestAliases = new Map(FOCUS_MANIFEST_ALIAS_MANIFEST.map((row) => [row.field, row.aliases]));
    const ymlExampleText = read(".gittensory.yml.example");
    for (const path of focusManifestFields) {
      const segments = path.split(".");
      const leaf = segments[segments.length - 1];
      const snakeLeaf = toSnakeCase(leaf);
      if (ymlExampleText.includes(leaf) || ymlExampleText.includes(snakeLeaf)) continue;
      const aliases = focusManifestAliases.get(path);
      if (aliases?.some((alias) => ymlExampleText.includes(alias))) continue;
      const prettyPath = segments.map(toSnakeCase).join(".");
      failures.push(
        `.gittensory.yml.example: missing any mention of FocusManifest field "${prettyPath}" -- document it there, or add a FOCUS_MANIFEST_ALIAS_MANIFEST row in scripts/check-docs-drift.mjs if it's already documented under a different yml key name`,
      );
    }
  }

  return {
    failures,
    counts: {
      flags: flags.length,
      commands: allCommandIds.length,
      gateModes: gateModeFields.length,
      settingsFields: repositorySettingsFields.length,
      focusManifestFields: focusManifestFields.length,
    },
  };
}

function main() {
  const { failures, counts } = checkDocsDrift({ root: process.cwd() });

  if (failures.length > 0) {
    console.error(`Docs-drift check found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }

  console.log(
    `Docs-drift check ok: ${counts.flags} feature flags, ${counts.commands} commands, ${counts.gateModes} gate-mode fields, ` +
      `${counts.settingsFields} RepositorySettings fields, ${counts.focusManifestFields} FocusManifest fields all documented.`,
  );
}

// Guard so importing this module for its pure exports (tests) never triggers the file-read/exit side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
