// Deterministic security/abuse scan for content submissions (content-lane primitive).
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence). Byte-faithful to reviewbot's
// src/agents/awesome-claude/security-scan.ts + the shared core/secrets-scan.ts. PURE — data in, data out,
// no I/O.
//
// Design principle (learned via adversarial review): the gate AUTO-CLOSES at high confidence with NO
// human queue, so a false-positive close PERMANENTLY rejects a legitimate submission — the worst
// outcome. Therefore only ONE signal is unambiguous enough to hard-close: a concrete embedded
// credential (a real-format token IS a leak regardless of framing). Every other abuse heuristic
// (pipe-to-shell installers, prompt-injection prose, "exfil-looking" code) is indistinguishable at
// the regex level from legitimate documentation or defensive-security tooling — so it routes to
// MANUAL (a human decides), never an auto-close.
//
// #4608: the format-specific patterns + placeholder-value heuristics used to be inlined here (a second,
// independent copy of src/review/secrets-scan.ts's primitives). Both files live under src/, same build,
// same deploy — no deploy-independence reason to hand-duplicate them; that duplication already caused two
// independent, currently-live drifts (see #4587/#4604). Now imported from the shared ../secret-patterns.

import {
  GENERIC_SECRET_ASSIGNMENT_PATTERN,
  HARD_SECRET_KINDS,
  hasGenericSecretAssignment,
  isPlaceholderSecretValue,
  SECRET_PATTERNS,
} from "../secret-patterns";

export interface SecretScanResult {
  found: boolean;
  kinds: string[];
}

/** Scan a string for known credential / secret patterns. Deterministic, no deps. */
export function scanForSecrets(text: string): SecretScanResult {
  if (!text) return { found: false, kinds: [] };
  const kinds = SECRET_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
  if (hasGenericSecretAssignment(text)) kinds.push("generic_secret_assignment");
  return { found: kinds.length > 0, kinds };
}

// ── Submission security scan ──────────────────────────────────────────────────────────────────

export interface SecurityFinding {
  verdict: "close" | "manual";
  reasonCode: string;
  summary: string;
}

// Categories whose entries ship a maintainer-authored EXECUTABLE artifact (a script that runs): used
// for the pipe-to-shell install check (manual-flag) and the first-party grounding relaxation.
export const EXECUTABLE_CATEGORIES = new Set(["skills", "agents", "commands", "hooks", "mcp", "statuslines"]);

// A literal pipe-to-shell install. Common in legitimate installers (uv/rustup/deno/nvm), so this is a
// MANUAL flag for a human, never an auto-close.
const PIPED_INSTALL_RE = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|python3?|node)\b/i;

function firstLineMatching(text: string, re: RegExp): { n: number; text: string } | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    // `?? ""` only exists to satisfy noUncheckedIndexedAccess -- the loop bound above guarantees lines[i] is
    // always defined here (`.split()` never produces holes), so the fallback branch is unreachable in practice.
    /* v8 ignore next */
    const line = lines[i] ?? "";
    if (re.test(line)) return { n: i + 1, text: line.trim().slice(0, 160) };
  }
  return null;
}

function firstSecretLine(text: string): { n: number; kinds: string[] } | null {
  // Per-line scan — O(n): catches every LINE-CONTAINED concrete kind (github_token, jwt, …) and cites its
  // exact line. lines[i] is defined for an in-range index (split never yields holes) — assert past
  // noUncheckedIndexedAccess. HARD_SECRET_KINDS no longer includes generic_secret_assignment (see
  // ../secret-patterns.ts's doc comment) — that kind is handled separately by
  // firstGenericSecretAssignmentLine below and routes to MANUAL, not this function's auto-close caller.
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const hits = scanForSecrets(lines[i]!).kinds.filter((k) => HARD_SECRET_KINDS.has(k));
    if (hits.length) return { n: i + 1, kinds: hits };
  }
  return null;
}

/**
 * generic_secret_assignment is a keyword-plus-quoted-value SHAPE heuristic, not a concrete credential format
 * (see ../secret-patterns.ts's HARD_SECRET_KINDS doc comment — split out post-gittensory-PR-#5346, which
 * auto-closed a legitimate contributor PR over two inert test-fixture strings). Per this file's own header
 * ("only ONE signal is unambiguous enough to hard-close... every other heuristic routes to MANUAL"), a hit
 * here routes to MANUAL, never scanSubmissionContent's auto-close. Its keyword-to-value span can wrap across
 * lines (`client_secret =\n"…"`), so this is a single whole-blob pass — LINEAR, not a quadratic prefix-rescan
 * — citing the line where the non-placeholder match COMPLETES.
 */
function firstGenericSecretAssignmentLine(text: string): number | null {
  GENERIC_SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GENERIC_SECRET_ASSIGNMENT_PATTERN.exec(text)) !== null) {
    if (!isPlaceholderSecretValue(match[1]!)) {
      return text.slice(0, match.index + match[0].length).split(/\r?\n/).length;
    }
  }
  return null;
}

/**
 * Deterministic security scan of the SUBMITTED content. Returns:
 *  - `close` (embedded_secret) on a concrete embedded credential — cited to a line; or
 *  - `manual` (possible_secret_assignment) on a secret-shaped-but-not-concrete-format assignment — cited to
 *    a line (see firstGenericSecretAssignmentLine's doc comment for why this is MANUAL, not close); or
 *  - `manual` (unsafe_install_pipeline) on a pipe-to-shell install in an executable category; or
 *  - null otherwise.
 * Prompt-injection / exfiltration prose is intentionally NOT matched here: it is indistinguishable
 * from legitimate prompt-engineering content, and is left to the grounded dual-AI review.
 */
export function scanSubmissionContent(params: { content: string; category: string }): SecurityFinding | null {
  const { content, category } = params;
  if (!content) return null;

  const secret = firstSecretLine(content);
  if (secret) {
    return {
      verdict: "close",
      reasonCode: "embedded_secret",
      summary: `Submission embeds a credential (${secret.kinds.join(", ")}) at line ${secret.n}. Remove the secret and resubmit.`,
    };
  }

  const genericLine = firstGenericSecretAssignmentLine(content);
  if (genericLine !== null) {
    return {
      verdict: "manual",
      reasonCode: "possible_secret_assignment",
      summary: `Submission contains a secret-shaped assignment (generic_secret_assignment) at line ${genericLine} that doesn't match a concrete credential format — routing to maintainer review to verify it isn't a real secret.`,
    };
  }

  if (EXECUTABLE_CATEGORIES.has(category)) {
    const pipe = firstLineMatching(content, PIPED_INSTALL_RE);
    if (pipe) {
      return {
        verdict: "manual",
        reasonCode: "unsafe_install_pipeline",
        summary: `Pipe-to-shell install detected (line ${pipe.n}): \`${pipe.text}\` — routing to maintainer review for a ${category} entry.`,
      };
    }
  }
  return null;
}

/** A concrete credential — or a secret-shaped-but-not-concrete-format assignment — exposed in a LINKED
 *  third-party body → manual either way (flag for a human; don't auto-close someone's submission over the
 *  linked artifact's own leak). */
export function scanLinkedBodiesForSecrets(bodies: string[]): SecurityFinding | null {
  for (const body of bodies) {
    const hits = scanForSecrets(body).kinds.filter((k) => HARD_SECRET_KINDS.has(k));
    if (hits.length) {
      return {
        verdict: "manual",
        reasonCode: "embedded_secret",
        summary: `The linked source appears to expose a credential (${hits.join(", ")}) — routing to maintainer review.`,
      };
    }
    if (hasGenericSecretAssignment(body)) {
      return {
        verdict: "manual",
        reasonCode: "possible_secret_assignment",
        summary: "The linked source contains a secret-shaped assignment (generic_secret_assignment) that doesn't match a concrete credential format — routing to maintainer review.",
      };
    }
  }
  return null;
}
