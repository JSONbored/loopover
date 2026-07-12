// Shared secret-detection primitives (#4608). Deterministic, no deps.
//
// Extracted out of src/review/secrets-scan.ts (PR-diff hard-block, via src/review/safety.ts) and
// src/review/content-lane/security-scan.ts (content-lane hard-block, for awesome-claude/metagraphed
// submissions) — both live under src/, ship in the same build/deploy, and had no deploy-independence reason
// to be hand-duplicated. That duplication already caused two independent, currently-live drifts (missing
// mock carve-out + missing voyage/firecrawl kinds, see #4604) despite a same-day commit (3307ae097, #4587)
// editing both copies for one change — there was no automated pairing between the two files.
//
// review-enrichment/src/analyzers/secret-scan.ts (REES) is deliberately NOT imported here and stays a
// genuinely separate, wider copy: REES deploys standalone on Railway with its own tsconfig/build/test
// pipeline, so importing across that boundary would break its independence (the same reasoning
// secrets-scan.ts's own header documents for staying self-contained relative to reviewbot). REES's
// isPlaceholderSecretValue body and the kind names it shares with HARD_SECRET_KINDS below are instead
// drift-checked mechanically — see scripts/check-engine-parity.ts's SECRET_DETECTION_TWIN_PAIR.

export const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "private_key_block", re: /-----BEGIN(?: RSA| EC| OPENSSH| PGP| DSA)? PRIVATE KEY-----/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "gitlab_token", re: /\bglpat-[0-9A-Za-z_-]{20}(?![0-9A-Za-z_-])/ },
  { name: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  // Stripe live secret / restricted keys: `sk_live_` / `rk_live_` + >=24 base62.
  { name: "stripe_secret_key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/ },
  // SendGrid API key: `SG.` + 22-char id + `.` + 43-char secret (base64url).
  { name: "sendgrid_key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/ },
  // Hugging Face user access token: `hf_` + 34 base62 chars.
  { name: "huggingface_token", re: /\bhf_[A-Za-z0-9]{34}\b/ },
  // Voyage AI API key: `pa-` (platform) or `al-` (MongoDB Atlas) + base62 body.
  { name: "voyage_api_key", re: /\b(?:pa|al)-[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/ },
  // Firecrawl API key: `fc-` + base62 body (alnum only; reject hyphen-continued identifiers).
  { name: "firecrawl_api_key", re: /\bfc-[A-Za-z0-9]{16,}(?![A-Za-z0-9_-])/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "seed_or_mnemonic", re: /\b(?:seed phrase|mnemonic)\b/i },
  { name: "bittensor_key", re: /\b(?:hot|cold)key\b\s*[:=]/i },
];

// Deliberately NOT in SECRET_PATTERNS above: unlike the format-specific patterns (a real GitHub token/AWS key
// ALWAYS matches its exact character format, so a bare .test() is precise enough), a keyword-plus-quoted-value
// SHAPE also matches plenty of non-secrets -- a Zod schema field (`password: z.string()`), a TypeScript type
// declaration, or a placeholder value ("xxx", "your-api-key-here", "<REDACTED>"). The value is captured (group
// 1) so it can be checked against isPlaceholderSecretValue before counting as a hit; the value itself is never
// returned from this module (only the kind name), preserving the never-echo-the-secret guarantee.
export const GENERIC_SECRET_ASSIGNMENT_PATTERN =
  /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']([A-Za-z0-9+/=_-]{16,})["']/gi;

const PLACEHOLDER_VALUE_PATTERN = /placeholder|change[_-]?me|your[_-]|<[^>]*>|\bexample\b|redacted|dummy|\bsample\b|\btodo\b|\bfixme\b|\binsert\b|replace[_-]?me|\bfake\b/i;

// #2553 gate review finding: a string with NO repeated characters (e.g. "abcdefghijklmnop123") has HIGH
// Shannon entropy by raw character-frequency counting, but is obviously not a real secret -- entropy alone
// only measures frequency, not ORDER, so a keyboard-sequential/alphabetical run slips past a pure distinct-
// character-count check. Detect the longest run of consecutive ascending or descending character codes (e.g.
// "abcdefg" or "9876543") and treat a long one as a human-constructed test value, not a randomly generated
// credential -- real API keys/tokens essentially never contain a 6+ character monotonic run.
const MIN_SEQUENTIAL_RUN_LENGTH = 6;
export function hasLongSequentialRun(value: string): boolean {
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

// Lowercase hyphenated mock names are fixtures; mixed-case/digit-bearing values containing "mock" remain
// plausible credentials and must still be reported by the generic assignment scanner.
const LOWERCASE_HYPHENATED_MOCK_FIXTURE_PATTERN = /^(?:[a-z]+-)*mock(?:-[a-z]+)*$/;

// #4579-followup: these exact live false-positive literals are fixture/enum names, not credentials. Keep
// this allowlist intentionally closed: a broad suffix rule would suppress plausible human-chosen secrets such
// as `client_secret = "correct-horse-battery-secret"`.
const KNOWN_FIXTURE_SECRET_VALUES = new Set([
  "installation-token",
  "default-session-token",
  "beta-session-token",
  "unsafe_install_or_secret",
]);

// Closed set of grammatical FUNCTION words — articles, negations, prepositions, auxiliary verbs — chosen for
// having near-zero information content per word. A human-authored placeholder that describes itself in prose
// (e.g. "present-value-not-a-real-token", "test-value-should-never-appear-in-doctor-output" — both real
// false-positive literals from PR #5346/#5341) naturally reaches for these; a deliberately memorable
// human-CHOSEN passphrase like "correct-horse-battery-secret" is composed of high-entropy CONTENT words
// (nouns/verbs/adjectives) specifically BECAUSE function words carry little entropy per word, so a diceware-
// style passphrase essentially never contains one. Their presence is therefore a reliable structural signal
// for "this is descriptive prose about the value", not "this is someone's chosen secret" — see
// looksLikeDescriptivePlaceholderPhrase below.
const ENGLISH_FUNCTION_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "not", "no", "and", "or", "to", "of",
  "in", "on", "at", "for", "with", "should", "never", "always", "will", "would", "does", "did", "do",
  "this", "that", "it", "as", "if", "then", "so", "but", "has", "have", "had", "can", "could",
]);

// A written-prose fixture description needs several words to say something (both PR #5346 literals split into
// 6 and 8 segments respectively); a memorable diceware-style passphrase conventionally tops out around 4 words
// for memorability. Requiring 5+ keeps this from colliding with a short, genuinely human-chosen passphrase.
const MIN_DESCRIPTIVE_PHRASE_SEGMENTS = 5;

/** True when `value` reads as a written sentence fragment (a fixture author's own prose description of the
 *  value) rather than a credential or a chosen passphrase: split on `-`/`_` into 5+ segments, every segment
 *  purely lowercase ASCII letters (a real token's mixed case/digits would fail this, correctly leaving it
 *  flagged), with at least one segment a low-entropy English function word (see ENGLISH_FUNCTION_WORDS). */
export function looksLikeDescriptivePlaceholderPhrase(value: string): boolean {
  const segments = value.split(/[-_]/);
  if (segments.length < MIN_DESCRIPTIVE_PHRASE_SEGMENTS) return false;
  if (!segments.every((segment) => /^[a-z]+$/.test(segment))) return false;
  return segments.some((segment) => ENGLISH_FUNCTION_WORDS.has(segment));
}

/** True for an obvious non-secret filler value: a known placeholder phrase, a string built from at most 2
 *  distinct characters (e.g. "xxxxxxxxxxxxxxxx", "----------------"), a long monotonic character-code run
 *  (e.g. "abcdefghijklmnop123"), a known fixture/enum literal, or a descriptive multi-word prose phrase (see
 *  looksLikeDescriptivePlaceholderPhrase). Mirrored (drift-checked, not imported) in
 *  review-enrichment/src/analyzers/secret-scan.ts — see this file's header. */
export function isPlaceholderSecretValue(value: string): boolean {
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) return true;
  if (new Set(value.toLowerCase()).size <= 2) return true;
  if (LOWERCASE_HYPHENATED_MOCK_FIXTURE_PATTERN.test(value)) return true;
  if (KNOWN_FIXTURE_SECRET_VALUES.has(value)) return true;
  if (looksLikeDescriptivePlaceholderPhrase(value)) return true;
  return hasLongSequentialRun(value);
}

/** True when `text` contains a keyword-plus-quoted-value assignment (see GENERIC_SECRET_ASSIGNMENT_PATTERN)
 *  whose value clears isPlaceholderSecretValue. The one shared implementation of "does this text contain a
 *  generic secret assignment", used by both secrets-scan.ts's matchedKindsIn and
 *  content-lane/security-scan.ts's scanForSecrets. */
export function hasGenericSecretAssignment(text: string): boolean {
  // No zero-length-match / lastIndex-stall guard needed: the pattern's captured value alone requires 16+
  // characters, so every match is well over 16 characters long and lastIndex always advances past match.index.
  GENERIC_SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GENERIC_SECRET_ASSIGNMENT_PATTERN.exec(text)) !== null) {
    // The captured value group is mandatory (not `?`/`*`-wrapped), so it is always present whenever the
    // overall match succeeds -- non-null by construction, not a runtime branch.
    if (!isPlaceholderSecretValue(match[1]!)) return true;
  }
  return false;
}

// Concrete credential formats only -- NOT the weak heuristics (seed_or_mnemonic / bittensor_key) that would
// false-positive on legitimate Bittensor content (a `coldkey:` / `hotkey =` line or the word "mnemonic" in a
// .toml, .github/workflows/**, or wrangler/workers config is not a leaked credential; RC6: #1505/#1495/#1485).
// #2553: google_api_key/jwt are as format-precise as the original five (near-zero false-positive risk), so
// both are safe unconditional hard blockers. voyage_api_key/firecrawl_api_key (#4604) are equally
// format-precise. Shared by both hard-block paths: src/review/safety.ts's secretLeakFinding (PR-diff) and
// src/review/content-lane/security-scan.ts's firstSecretLine/scanLinkedBodiesForSecrets (content-lane).
//
// generic_secret_assignment is deliberately NOT a member (post-PR-5346): unlike every kind above, it is a
// keyword-plus-quoted-value SHAPE heuristic, not a concrete credential format, so isPlaceholderSecretValue's
// closed escape-hatch keyword list can never keep pace with the open-ended ways a contributor phrases an
// inert test value -- this exact gap closed a legitimate contributor PR twice in a row (#5341, then its
// resubmission #5346, on two DIFFERENT non-placeholder-keyword fixture strings) after at least half a dozen
// prior narrow-allowlist patches to this same heuristic (#4587, #3866, #3673, #3178, #2613, #4733) failed to
// stop the pattern for good. REES's own copy of this rule (review-enrichment/src/analyzers/secret-scan.ts)
// already rates it "medium confidence" ("catches real keys but also the occasional long opaque non-secret"),
// and content-lane/security-scan.ts's own header states the underlying design principle this violated: a
// gate that AUTO-CLOSES with no human queue may only hard-close on a signal unambiguous enough that a false
// positive is essentially impossible -- "every other heuristic routes to MANUAL". See
// ADVISORY_ONLY_SECRET_KINDS below for where it still surfaces.
export const HARD_SECRET_KINDS = new Set([
  "github_token",
  "github_pat",
  "private_key_block",
  "aws_access_key",
  "slack_token",
  "google_api_key",
  "gitlab_token",
  "npm_token",
  "stripe_secret_key",
  "sendgrid_key",
  "huggingface_token",
  "voyage_api_key",
  "firecrawl_api_key",
  "jwt",
]);

// The one kind excluded from HARD_SECRET_KINDS above: still detected and still worth a human's attention, but
// never an unconditional auto-block/auto-close on its own -- see that constant's doc comment for why. Consumed
// by src/review/safety.ts's secretLeakFinding and src/review/content-lane/security-scan.ts to route a hit here
// to an advisory/manual-review signal instead of a hard blocker.
export const ADVISORY_ONLY_SECRET_KINDS = new Set(["generic_secret_assignment"]);
