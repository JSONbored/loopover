export {
  classifyTestCoverage,
  hasLocalTestEvidence,
  isTestPath,
  type TestCoverageClassification,
} from "@jsonbored/gittensory-engine";

// A body can mention testing without having actually done it ("No tests run", "Tests not run", "Not
// tested locally", "did not run any tests") -- the affirmative keyword match below would otherwise treat
// that as passing evidence and let a configured manifest test expectation silently disappear. Rather than
// enumerate ever more literal phrase templates (which a previous version of this function tried, and which
// still missed "Not tested" because its test-noun list didn't include the verb form "tested"), detect
// negation by PROXIMITY: a negation word within a few words of a test/validation stem, in either order,
// with a shared stem definition so the "is this a test/validation mention at all" question is answered
// exactly once. The filler between the negation word and the stem may not cross a clause/sentence boundary
// (a comma, period, exclamation mark, or question mark), so an unrelated "not" earlier in the body (e.g.
// "This is not a breaking change. Tested with npm run test:ci.") cannot suppress a later, unrelated
// affirmative note. A colon, semicolon, or dash is deliberately NOT a hard boundary here -- see
// LABEL_SEPARATOR_GAP below.
const TEST_STEM = "(?:test(?:ed|s|ing)?|validat(?:ion|ed)|verif(?:y|ied|ying)|manual check|smoke(?:\\s+tests?)?)";
const NEGATION_WORD = "(?:no|not|never|without|skip(?:ped)?|didn't|doesn't|isn't|wasn't|weren't|haven't|hasn't)";
const NEGATION_CONTINUATION = "(?:not|never|failed|failing|skipped|incomplete)";
const SAME_SENTENCE_FILLER_WORD = "[^\\s.,!?;]+";
// A label-style status line often glues its separator directly onto the negation word or stem with no
// surrounding whitespace ("Tests: not run.", "Validation; skipped.", "Tests - not run."). The plain
// `\s+` gap below would never match across that punctuation, so the negation went undetected and the
// bare "Tests"/"Validation" keyword fell through to the affirmative check instead (#3304, round 4).
// Allow ONE label separator (colon, semicolon, or a hyphen/en-dash/em-dash) with any trailing
// whitespace to stand in for the mandatory whitespace, but only at the junction touching the negation
// word or stem itself -- every other gap between filler words stays pure whitespace, so a label
// separator elsewhere in the sentence still cannot let a negation reach across unrelated content (the
// filler-word bound below already exists for exactly this reason).
const LABEL_SEPARATOR_GAP = "(?:\\s+|[:;\\-\\u2013\\u2014]\\s*)";

const NEGATES_BEFORE_TEST_STEM = new RegExp(`\\b${NEGATION_WORD}\\b${LABEL_SEPARATOR_GAP}(?:${SAME_SENTENCE_FILLER_WORD}\\s+){0,3}${TEST_STEM}\\b`, "i");
const NEGATES_AFTER_TEST_STEM = new RegExp(`\\b${TEST_STEM}\\b${LABEL_SEPARATOR_GAP}(?:${SAME_SENTENCE_FILLER_WORD}\\s+){0,2}${NEGATION_CONTINUATION}\\b`, "i");
// A compound negated adjective with no separating whitespace at all ("untested", "unvalidated", "unverified").
const NEGATES_TEST_STEM_PREFIX = /\bun(?:tested|validated|verified)\b/i;

const AFFIRMATIVE_TEST_MENTION = /\b(test(?:ed|s|ing)?|validation|validated|verified|manual check|smoke|pytest|vitest|npm test|pnpm test|cargo test|go test)\b/i;

// A body can contain BOTH a genuine negated clause ("No tests run locally.") and a separate, later clause
// with real affirmative evidence ("Validated with npm run test:ci.") -- evaluating the negation checks
// against the WHOLE body would let the first clause veto the second, discarding real evidence the manifest
// gate is specifically trying to detect (#3304, round 3). Split on the same clause-boundary punctuation the
// proximity checks already treat as a hard stop -- colon/semicolon/dash are excluded here on purpose
// (#3304, round 4): they are typically a label separator glued directly onto the word on either side
// ("Tests: not run."), and splitting on them would sever the stem from its own negation before the
// proximity checks ever run, the same way the round-3 bug worked one level up. Require at least one
// clause to be an affirmative, non-negated mention -- so an earlier honest "no tests" disclosure can no
// longer suppress later evidence.
export function hasValidationNote(value: string): boolean {
  return value
    .split(/[.,!?]+/)
    .some(
      (clause) =>
        !NEGATES_TEST_STEM_PREFIX.test(clause) &&
        !NEGATES_BEFORE_TEST_STEM.test(clause) &&
        !NEGATES_AFTER_TEST_STEM.test(clause) &&
        AFFIRMATIVE_TEST_MENTION.test(clause),
    );
}
