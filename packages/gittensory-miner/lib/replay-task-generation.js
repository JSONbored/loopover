// Leakage-safe task generation for the historical-replay calibration harness (#3011).
//
// A frozen snapshot at commit T is only useful for calibration if (a) the freeze point has enough real
// history on both sides to be worth scoring, and (b) nothing in the frozen context lets a replay run infer
// the future by pattern-matching text rather than reasoning. This module selects calibration-worthy freeze
// points, scrubs forward references out of the frozen context, tags each point's recency pool, and returns
// the frozen snapshot and the revealed post-T ground truth as *separate* bundles so the replay pipeline never
// holds both at once. Every function here is pure and deterministic — no clock, no randomness, no IO — so a
// given (candidate, context) always yields an identical task.

// What a scrubbed-away forward reference is replaced with. A fixed, self-delimiting token so the scrubbed
// text stays readable and the substitution is itself deterministic.
export const FORWARD_REF_PLACEHOLDER = "[redacted-forward-ref]";

// Recency pools. Freeze points are mixed across these bands so a judge/planner that has memorized recent
// public history cannot dominate the calibration signal.
export const RECENCY_POOLS = Object.freeze(["recent", "older"]);

function toIssueNumberSet(values) {
  const set = new Set();
  if (Array.isArray(values)) {
    for (const value of values) {
      if (Number.isInteger(value) && value > 0) set.add(value);
    }
  }
  return set;
}

function toShaSet(values) {
  const set = new Set();
  if (Array.isArray(values)) {
    for (const value of values) {
      if (typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value)) set.add(value.toLowerCase());
    }
  }
  return set;
}

function resolveContext(context) {
  return {
    knownIssueMax:
      Number.isInteger(context?.knownIssueMax) && context.knownIssueMax >= 0 ? context.knownIssueMax : 0,
    knownCommitShas: toShaSet(context?.knownCommitShas),
    revealedIssueNumbers: toIssueNumberSet(context?.revealedIssueNumbers),
  };
}

// Core scanner shared by scrub/detect/lint. Walks a text in a fixed priority order (deep-links first, so an
// issue/PR/commit URL is handled before its inner number/SHA can match a barer pattern) and classifies each
// forward reference as either:
//   - scrubbable: a self-delimited token (`#123`, a GitHub issues/pull/commit URL, or a raw commit SHA) that
//     resolves only to post-T state and can be safely replaced with the placeholder; or
//   - unscrubbable: a *bare* integer that exactly matches a known post-T issue number. A bare number cannot be
//     blanket-removed without destroying legitimate pre-T numbers (versions, counts), so it is detected but
//     left in place — its presence must fail the freeze point rather than be silently mangled.
function processForwardReferences(rawText, context) {
  const resolved = resolveContext(context);
  const removed = [];

  const text = typeof rawText === "string" ? rawText : "";

  // 1. GitHub issue/pull deep-links whose number is after T.
  let scrubbed = text.replace(
    /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+)\b/gi,
    (match, digits) => {
      if (Number(digits) > resolved.knownIssueMax) {
        removed.push({ kind: "link", value: match });
        return FORWARD_REF_PLACEHOLDER;
      }
      return match;
    },
  );

  // 2. GitHub commit deep-links whose SHA is not in pre-T history.
  scrubbed = scrubbed.replace(
    /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/([0-9a-f]{7,40})\b/gi,
    (match, sha) => {
      if (!resolved.knownCommitShas.has(sha.toLowerCase())) {
        removed.push({ kind: "link", value: match });
        return FORWARD_REF_PLACEHOLDER;
      }
      return match;
    },
  );

  // 3. Bare `#123` issue/PR references after T (not already inside a now-removed link).
  scrubbed = scrubbed.replace(/(^|[^\w/])#(\d+)\b/g, (match, prefix, digits) => {
    if (Number(digits) > resolved.knownIssueMax) {
      removed.push({ kind: "hashref", value: `#${digits}` });
      return `${prefix}${FORWARD_REF_PLACEHOLDER}`;
    }
    return match;
  });

  // 4. Raw commit SHAs not in pre-T history. Require at least one hex letter so a plain decimal number is
  //    never misread as a SHA — those flow to the bare-issue-number residual check below instead.
  scrubbed = scrubbed.replace(/(^|[^\w/#])([0-9a-f]{7,40})\b/gi, (match, prefix, sha) => {
    if (!/[a-f]/i.test(sha)) return match;
    if (!resolved.knownCommitShas.has(sha.toLowerCase())) {
      removed.push({ kind: "sha", value: sha });
      return `${prefix}${FORWARD_REF_PLACEHOLDER}`;
    }
    return match;
  });

  // Residual: bare integers that name a real post-T issue and so leak the future, but cannot be safely
  // auto-removed. Detected against the surviving text — if any remain, the freeze point is not usable as-is.
  const residual = [];
  if (resolved.revealedIssueNumbers.size > 0) {
    for (const bareMatch of scrubbed.matchAll(/(?:^|[^\w#/])(\d+)\b/g)) {
      const value = Number(bareMatch[1]);
      if (resolved.revealedIssueNumbers.has(value)) {
        residual.push({ kind: "bare-issue-number", value });
      }
    }
  }

  return { scrubbed, removed, residual };
}

// Detect forward references in text without modifying it, split by whether they can be safely scrubbed.
export function detectForwardReferences(text, context) {
  const { removed, residual } = processForwardReferences(text, context);
  return { scrubbable: removed, unscrubbable: residual };
}

// Scrub the safely-removable forward references from text, returning the cleaned text, what was removed, and
// any unscrubbable references that remain (a non-empty `residual` means the text still leaks the future).
export function scrubForwardReferences(text, context) {
  return processForwardReferences(text, context);
}

// A freeze point's frozen context is clean iff every provided text scrubs to zero residual forward references.
export function lintFrozenContext(texts, context) {
  const list = Array.isArray(texts) ? texts : texts == null ? [] : [texts];
  const residual = [];
  for (const text of list) {
    residual.push(...processForwardReferences(text, context).residual);
  }
  return { ok: residual.length === 0, residual };
}

// Selection: a freeze point is calibration-worthy only with enough real history on both sides of T.
export function selectFreezePoint(candidate, thresholds) {
  const minPriorCommits = Number.isInteger(thresholds?.minPriorCommits) ? thresholds.minPriorCommits : 0;
  const minRevealedCommits = Number.isInteger(thresholds?.minRevealedCommits)
    ? thresholds.minRevealedCommits
    : 0;
  const priorCommitCount = Number.isInteger(candidate?.priorCommitCount) ? candidate.priorCommitCount : 0;
  const revealedCommitCount = Number.isInteger(candidate?.revealedCommitCount)
    ? candidate.revealedCommitCount
    : 0;

  const reasons = [];
  if (priorCommitCount < minPriorCommits) reasons.push("insufficient_prior_history");
  if (revealedCommitCount < minRevealedCommits) reasons.push("insufficient_revealed_history");

  return { eligible: reasons.length === 0, reasons, priorCommitCount, revealedCommitCount };
}

// Pool provenance: a freeze point whose last activity is at/after the calibration run's model cutoff is
// "recent" (higher memorization risk); everything else, including an unknown date, is "older". ISO-8601
// timestamps sort lexicographically, so no clock is needed.
export function classifyRecencyPool(candidate, options) {
  const modelCutoffIso = typeof options?.modelCutoffIso === "string" ? options.modelCutoffIso : "";
  const lastActivityAt = typeof candidate?.lastActivityAt === "string" ? candidate.lastActivityAt : "";
  if (!modelCutoffIso || !lastActivityAt) return "older";
  return lastActivityAt >= modelCutoffIso ? "recent" : "older";
}

// One-shot generator. Applies selection, then scrubs and lints the frozen context, then returns the frozen
// snapshot and the revealed post-T ground truth as SEPARATE bundles — never merged — so a caller persists and
// scopes them independently. An ineligible or un-scrubbable candidate is rejected without producing a task.
export function generateReplayTask(candidate, context, options) {
  const selection = selectFreezePoint(candidate, options?.thresholds);
  if (!selection.eligible) {
    return { eligible: false, rejected: "selection", reasons: selection.reasons };
  }

  const frozenTexts = Array.isArray(candidate?.frozenContextTexts) ? candidate.frozenContextTexts : [];
  const lint = lintFrozenContext(frozenTexts, context);
  if (!lint.ok) {
    return { eligible: false, rejected: "unscrubbable_forward_reference", residual: lint.residual };
  }

  const pool = classifyRecencyPool(candidate, options);
  const scrubbedTexts = frozenTexts.map((text) => processForwardReferences(text, context).scrubbed);

  return {
    eligible: true,
    pool,
    frozen: {
      repo: typeof candidate?.repo === "string" ? candidate.repo : null,
      commitT: typeof candidate?.commitT === "string" ? candidate.commitT : null,
      contextTexts: scrubbedTexts,
    },
    revealed: {
      commitCount: selection.revealedCommitCount,
      groundTruth: candidate?.revealedGroundTruth ?? null,
    },
  };
}
