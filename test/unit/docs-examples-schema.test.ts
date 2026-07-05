import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localBranchAnalysisSchema } from "../../src/api/routes";

// Drift guard (#3045): docs.branch-analysis.tsx and docs.scoreability.tsx each embed a hand-typed
// JSON example that is supposed to mirror a real backing schema/type. Both pages previously drifted
// (branch-analysis used a nested repo/refs/files/linked_issues shape against the real flat, camelCase
// `.strict()` Zod schema; scoreability invented snake_case fields like `risk_adjusted_priority` against
// the real `ScorePreviewResult` shape) and were fixed by hand with nothing stopping it from happening
// again. This test reads the ACTUAL current doc source at test time, extracts the embedded JSON
// example, and validates it against the real schema/type -- so a future hand-edit that drifts either
// example fails a test immediately instead of rotting silently until the next manual audit.

const BRANCH_ANALYSIS_DOC_PATH = "apps/gittensory-ui/src/routes/docs.branch-analysis.tsx";
const SCOREABILITY_DOC_PATH = "apps/gittensory-ui/src/routes/docs.scoreability.tsx";

// ScorePreviewResult (src/scoring/preview.ts) is a plain TS type with no runtime schema to introspect,
// so -- same manual-sync limitation as other doc-drift guards in this repo -- this set must be kept in
// sync by hand with ScorePreviewResult's top-level keys whenever that type changes shape.
const SCORE_PREVIEW_RESULT_TOP_LEVEL_KEYS = new Set([
  "repoFullName",
  "generatedAt",
  "scoringModelSnapshotId",
  "activeModel",
  "privateOnly",
  "laneMath",
  "scoreEstimate",
  "linkedIssueMultiplier",
  "gates",
  "branchEligibility",
  "effectiveEstimatedScore",
  "underlyingPotentialScore",
  "blockedBy",
  "gateDeltas",
  "scenarioPreviews",
  "scoreabilityStatus",
  "warnings",
  "assumptions",
  "recommendation",
]);

// ScoreScenarioPreview["name"] union (src/scoring/preview.ts).
const SCORE_SCENARIO_PREVIEW_NAMES = new Set([
  "current",
  "cleanGates",
  "afterPendingMerges",
  "afterApprovedPrsMerge",
  "afterStalePrsClose",
  "linkedIssueFixed",
  "bestReasonableCase",
]);

// ScorePreviewResult["scoreabilityStatus"] union (src/scoring/preview.ts).
const SCOREABILITY_STATUS_VALUES = new Set(["blocked", "conditionally_scoreable", "scoreable", "hold"]);

// ScorePreviewResult["recommendation"]["level"] union (src/scoring/preview.ts).
const RECOMMENDATION_LEVEL_VALUES = new Set(["strong_fit", "reasonable_fit", "needs_work", "hold"]);

/** Extracts the first `CodeBlock` `code={\`...\`}` template-literal body from a docs page's source. */
function extractCodeBlockTemplateLiteral(source: string): string {
  const codeBlockMatch = source.match(/code=\{`([\s\S]*?)`\}/);
  if (!codeBlockMatch || codeBlockMatch[1] === undefined) {
    throw new Error("No CodeBlock code={`...`} template literal found in source");
  }
  return codeBlockMatch[1];
}

/**
 * Extracts the JSON object embedded in a docs page's `CodeBlock` `code={...}` template literal.
 * Finds the first `{` and walks forward counting brace depth (skipping braces inside string
 * literals) until the matching closing `}` -- this is required because the JSON body itself
 * contains nested objects/arrays, so a naive regex that stops at the first `}` would truncate it.
 */
function extractJsonObjectLiteral(source: string): string {
  const start = source.indexOf("{");
  if (start === -1) {
    throw new Error("No JSON object literal found in source");
  }

  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error("Unbalanced braces: no matching closing brace found for JSON object literal");
}

describe("docs examples match their real backing schemas (#3045)", () => {
  it("docs.branch-analysis.tsx's example invocation body parses as a valid localBranchAnalysisSchema payload", () => {
    const doc = readFileSync(BRANCH_ANALYSIS_DOC_PATH, "utf8");
    const codeBlockContent = extractCodeBlockTemplateLiteral(doc);

    // The HTTP-style block is: request line, headers, a blank line, then the JSON body.
    const jsonLiteral = extractJsonObjectLiteral(codeBlockContent);
    const parsed = JSON.parse(jsonLiteral) as unknown;

    const result = localBranchAnalysisSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `docs.branch-analysis.tsx's example invocation no longer matches localBranchAnalysisSchema:\n${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("docs.scoreability.tsx's example shape only uses real ScorePreviewResult top-level keys and enum values", () => {
    const doc = readFileSync(SCOREABILITY_DOC_PATH, "utf8");
    const codeBlockContent = extractCodeBlockTemplateLiteral(doc);

    const jsonLiteral = extractJsonObjectLiteral(codeBlockContent);
    const parsed = JSON.parse(jsonLiteral) as Record<string, unknown>;

    // The doc's example is deliberately trimmed (it omits internal-only blocks like laneMath/gates/
    // scoreEstimate for readability), so this is not a full schema parse -- just a check that every
    // key it DOES show is a real ScorePreviewResult top-level key (catches a fabricated field name
    // like the old risk_adjusted_priority bug).
    const presentKeys = Object.keys(parsed);
    expect(presentKeys.length).toBeGreaterThan(0);
    const unknownKeys = presentKeys.filter((key) => !SCORE_PREVIEW_RESULT_TOP_LEVEL_KEYS.has(key));
    expect(unknownKeys).toEqual([]);

    if (parsed.scenarioPreviews !== undefined) {
      expect(Array.isArray(parsed.scenarioPreviews)).toBe(true);
      const scenarioPreviews = parsed.scenarioPreviews as Array<Record<string, unknown>>;
      expect(scenarioPreviews.length).toBeGreaterThan(0);
      for (const scenario of scenarioPreviews) {
        expect(SCORE_SCENARIO_PREVIEW_NAMES.has(scenario.name as string)).toBe(true);
      }
    }

    if (parsed.scoreabilityStatus !== undefined) {
      expect(SCOREABILITY_STATUS_VALUES.has(parsed.scoreabilityStatus as string)).toBe(true);
    }

    if (parsed.recommendation !== undefined) {
      const recommendation = parsed.recommendation as Record<string, unknown>;
      if (recommendation.level !== undefined) {
        expect(RECOMMENDATION_LEVEL_VALUES.has(recommendation.level as string)).toBe(true);
      }
    }
  });
});
