// Reusable secret-pattern scanner (the `secretsScan` capability). Deterministic, no deps.
// Callers run scanForSecrets() on submitted diff/text; a hit typically forces a close/manual verdict.
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence): every type + pattern this module needs is
// defined HERE. No imports from reviewbot. The logic is byte-faithful to the reviewbot source
// (src/core/secrets-scan.ts); there are no stricter-tsconfig deltas — the module is already total.
//
// #2553: widened to match review-enrichment/src/analyzers/secret-scan.ts's richer, higher-recall rule set
// (google_api_key, jwt, generic_secret_assignment) so the deterministic hard blocker (safety.ts's
// HARD_SECRET_KINDS) catches the same patterns REES's advisory-only enrichment brief already does. Kept as a
// second, independent copy here rather than a cross-package import: review-enrichment deploys standalone on
// Railway with its own tsconfig/build/test pipeline (see review-enrichment/package.json), so importing across
// that boundary would break its independence — the same reasoning this file's own header already documents
// for staying self-contained relative to reviewbot.

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "private_key_block", re: /-----BEGIN(?: RSA| EC| OPENSSH| PGP| DSA)? PRIVATE KEY-----/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "gitlab_token", re: /\bglpat-[0-9A-Za-z_-]{20}\b/ },
  { name: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  // Stripe live secret / restricted keys: `sk_live_` / `rk_live_` + >=24 base62.
  { name: "stripe_secret_key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/ },
  // SendGrid API key: `SG.` + 22-char id + `.` + 43-char secret (base64url).
  { name: "sendgrid_key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/ },
  // Hugging Face user access token: `hf_` + 34 base62 chars.
  { name: "huggingface_token", re: /\bhf_[A-Za-z0-9]{34}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "seed_or_mnemonic", re: /\b(?:seed phrase|mnemonic)\b/i },
  { name: "bittensor_key", re: /\b(?:hot|cold)key\b\s*[:=]/i },
];

// Deliberately NOT in SECRET_PATTERNS above: unlike the format-specific patterns (a real GitHub token/AWS key
// ALWAYS matches its exact character format, so a bare .test() is precise enough), a keyword-plus-quoted-value
// SHAPE also matches plenty of non-secrets -- a Zod schema field (`password: z.string()`), a TypeScript type
// declaration, or a placeholder value ("xxx", "your-api-key-here", "<REDACTED>"). Captured so each match's
// VALUE can be checked against isPlaceholderSecretValue before counting as a hit; the value itself is never
// returned from this module (only the kind name), preserving the existing never-echo-the-secret guarantee.
const GENERIC_SECRET_ASSIGNMENT_PATTERN =
  /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']([A-Za-z0-9+/=_-]{16,})["']/gi;

const PLACEHOLDER_VALUE_PATTERN = /placeholder|change[_-]?me|your[_-]|<[^>]*>|\bexample\b|redacted|dummy|\bsample\b|\btodo\b|\bfixme\b|\binsert\b|replace[_-]?me|\bfake\b/i;

// #2553 gate review finding: a string with NO repeated characters (e.g. "abcdefghijklmnop123") has HIGH
// Shannon entropy by raw character-frequency counting, but is obviously not a real secret -- entropy alone
// only measures frequency, not ORDER, so a keyboard-sequential/alphabetical run slips past a pure distinct-
// character-count check. Detect the longest run of consecutive ascending or descending character codes (e.g.
// "abcdefg" or "9876543") and treat a long one as a human-constructed test value, not a randomly generated
// credential -- real API keys/tokens essentially never contain a 6+ character monotonic run.
const MIN_SEQUENTIAL_RUN_LENGTH = 6;
function hasLongSequentialRun(value: string): boolean {
  let ascendingRun = 1;
  let descendingRun = 1;
  for (let i = 1; i < value.length; i += 1) {
    const diff = value.charCodeAt(i) - value.charCodeAt(i - 1);
    ascendingRun = diff === 1 ? ascendingRun + 1 : 1;
    descendingRun = diff === -1 ? descendingRun + 1 : 1;
    if (ascendingRun >= MIN_SEQUENTIAL_RUN_LENGTH || descendingRun >= MIN_SEQUENTIAL_RUN_LENGTH) return true;
  }
  return false;
}

// #3041: a value made ENTIRELY of lowercase words joined by hyphens (2+ segments, e.g. the test-fixture
// literal "installation-token" used 351+ times across this repo's own test suite as a mock fetch-response
// token) reads as an ordinary English-word compound identifier -- a mock/fixture name -- not a generated
// credential. Real secrets/tokens are essentially always alphanumeric, mixed-case, or base64/hex; they are
// never a pure lowercase-hyphenated phrase. Require at least one hyphen (2+ segments) so this stays narrow
// and doesn't broaden into excluding arbitrary single lowercase words that could plausibly be real secrets.
const LOWERCASE_HYPHENATED_COMPOUND_PATTERN = /^[a-z]+(-[a-z]+)+$/;

/** True for an obvious non-secret filler value: a known placeholder phrase, a string built from at most 2
 *  distinct characters (e.g. "xxxxxxxxxxxxxxxx", "----------------"), a long monotonic character-code run
 *  (e.g. "abcdefghijklmnop123"), or a lowercase-hyphenated word compound (e.g. "installation-token") — real
 *  high-entropy secrets never look like any of these. */
function isPlaceholderSecretValue(value: string): boolean {
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) return true;
  if (new Set(value.toLowerCase()).size <= 2) return true;
  if (LOWERCASE_HYPHENATED_COMPOUND_PATTERN.test(value)) return true;
  return hasLongSequentialRun(value);
}

function hasGenericSecretAssignment(text: string): boolean {
  // No zero-length-match / lastIndex-stall guard needed: the pattern's captured value alone requires 16+
  // characters, so every match is well over 16 characters long and lastIndex always advances past match.index.
  GENERIC_SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GENERIC_SECRET_ASSIGNMENT_PATTERN.exec(text)) !== null) {
    // The pattern's sole capturing group is mandatory (not `?`/`*`-wrapped), so it is always present
    // whenever the overall match succeeds -- non-null by construction, not a runtime branch.
    if (!isPlaceholderSecretValue(match[1]!)) return true;
  }
  return false;
}

// #3041: the one place the pattern list (format-specific SECRET_PATTERNS + the generic keyword-assignment
// heuristic) is applied to a string. Both `scanForSecrets` (whole-text scan) and
// `scanDiffForSecretsWithLocations` (per-line diff scan, for file:line attribution) delegate here so there is
// exactly one implementation of "does this text contain secret-shaped content" to keep in sync.
function matchedKindsIn(text: string): string[] {
  if (!text) return [];
  const kinds = SECRET_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
  if (hasGenericSecretAssignment(text)) kinds.push("generic_secret_assignment");
  return kinds;
}

export interface SecretScanResult {
  found: boolean;
  kinds: string[];
}

export function scanForSecrets(text: string): SecretScanResult {
  const kinds = matchedKindsIn(text);
  return { found: kinds.length > 0, kinds };
}

/** One secret-pattern hit at a specific location in a diff, for surfacing file:line in a finding (#3041). A
 *  `line` of `0` means the match came from a file-header PATH itself (an added/renamed filename), not from
 *  diff content — there is no line number for that case. */
export interface SecretScanLocationMatch {
  kind: string;
  path: string;
  line: number;
}

const DIFF_FILE_HEADER_PATTERN = /^### (.+) \(([a-z]+)\) \+\d+\/-\d+$/;
const DIFF_HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Walk a `buildSecretScanDiff`-shaped diff (see src/queue/processors.ts) line by line, scanning only content
 * this PR is INTRODUCING — added (`+`) lines and, for an added/renamed file, the path in its own section
 * header — and return every pattern hit with its file path and 1-based line number in the new/post-change
 * file. Context (` `) and removed (`-`) lines are tracked for line-number bookkeeping but never scanned: a
 * removed or unchanged line is not something this PR is committing. This mirrors the added-only scanning
 * `secretLeakFinding` used to do via string filtering, but keeps enough diff structure to report WHERE a hit
 * lives instead of collapsing everything to a flat blob.
 */
export function scanDiffForSecretsWithLocations(diff: string): SecretScanLocationMatch[] {
  const matches: SecretScanLocationMatch[] = [];
  let currentPath = "";
  let currentNewLine = 0;
  for (const line of diff.split("\n")) {
    const fileHeader = DIFF_FILE_HEADER_PATTERN.exec(line);
    if (fileHeader) {
      currentPath = fileHeader[1]!;
      currentNewLine = 0;
      const status = fileHeader[2]!;
      if (status === "added" || status === "renamed") {
        for (const kind of matchedKindsIn(currentPath)) {
          matches.push({ kind, path: currentPath, line: 0 });
        }
      }
      continue;
    }
    const hunkHeader = DIFF_HUNK_HEADER_PATTERN.exec(line);
    if (hunkHeader) {
      currentNewLine = Number(hunkHeader[1]) - 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentNewLine += 1;
      const content = line.slice(1);
      for (const kind of matchedKindsIn(content)) {
        matches.push({ kind, path: currentPath, line: currentNewLine });
      }
      continue;
    }
    if (line.startsWith("-")) continue;
    // Context line (single leading space) or a blank separator between file sections -- either way it isn't
    // new content this PR introduces, but a genuine context line still occupies a line in the new file.
    currentNewLine += 1;
  }
  return matches;
}
