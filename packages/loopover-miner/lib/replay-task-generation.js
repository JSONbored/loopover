// Leakage-safe task generation for the historical-replay calibration harness (#3011).
//
// A frozen snapshot at commit T is only useful for calibration if (a) the freeze point has enough real
// history on both sides to be worth scoring, and (b) nothing in the frozen context lets a replay run infer
// the future by pattern-matching text rather than reasoning. This module selects calibration-worthy freeze
// points, scrubs forward references out of the frozen context, tags each point's recency pool, and returns
// the frozen replay task without the revealed post-T ground truth. Scoring data is exposed through a separate
// function so replay execution never has to hold both sides at once. Every function here is pure and
// deterministic — no clock, no randomness, no IO — so a given (candidate, context) always yields an
// identical task.
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
            if (Number.isInteger(value) && value > 0)
                set.add(value);
        }
    }
    return set;
}
function toShaSet(values) {
    const set = new Set();
    if (Array.isArray(values)) {
        for (const value of values) {
            if (typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value))
                set.add(value.toLowerCase());
        }
    }
    return set;
}
function resolveContext(context) {
    return {
        knownIssueMax: Number.isInteger(context?.knownIssueMax) && context?.knownIssueMax >= 0 ? context?.knownIssueMax : 0,
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
    let scrubbed = text.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+)\b/gi, (match, digits) => {
        if (Number(digits) > resolved.knownIssueMax) {
            removed.push({ kind: "link", value: match });
            return FORWARD_REF_PLACEHOLDER;
        }
        return match;
    });
    // 2. GitHub commit deep-links whose SHA is not in pre-T history.
    scrubbed = scrubbed.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/([0-9a-f]{7,40})\b/gi, (match, sha) => {
        if (!resolved.knownCommitShas.has(sha.toLowerCase())) {
            removed.push({ kind: "link", value: match });
            return FORWARD_REF_PLACEHOLDER;
        }
        return match;
    });
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
        if (!/[a-f]/i.test(sha))
            return match;
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
    const minPriorCommits = Number.isInteger(thresholds?.minPriorCommits) ? thresholds?.minPriorCommits : 0;
    const minRevealedCommits = Number.isInteger(thresholds?.minRevealedCommits)
        ? thresholds?.minRevealedCommits
        : 0;
    const priorCommitCount = Number.isInteger(candidate?.priorCommitCount) ? candidate?.priorCommitCount : 0;
    const revealedCommitCount = Number.isInteger(candidate?.revealedCommitCount)
        ? candidate?.revealedCommitCount
        : 0;
    const reasons = [];
    if (priorCommitCount < minPriorCommits)
        reasons.push("insufficient_prior_history");
    if (revealedCommitCount < minRevealedCommits)
        reasons.push("insufficient_revealed_history");
    return { eligible: reasons.length === 0, reasons, priorCommitCount, revealedCommitCount };
}
// Pool provenance: a freeze point whose last activity is at/after the calibration run's model cutoff is
// "recent" (higher memorization risk); everything else, including an unknown date, is "older". ISO-8601
// timestamps sort lexicographically, so no clock is needed.
export function classifyRecencyPool(candidate, options) {
    const modelCutoffIso = typeof options?.modelCutoffIso === "string" ? options.modelCutoffIso : "";
    const lastActivityAt = typeof candidate?.lastActivityAt === "string" ? candidate.lastActivityAt : "";
    if (!modelCutoffIso || !lastActivityAt)
        return "older";
    return lastActivityAt >= modelCutoffIso ? "recent" : "older";
}
// One-shot replay generator. Applies selection, then scrubs and lints the frozen context, then returns only
// the frozen replay task. Revealed post-T ground truth is intentionally available only through
// generateReplayScoringKey, so a replay worker/serializer/logger/model call never receives both sides.
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
    };
}
// Scoring-only accessor. Call this from the isolated scorer path after replay execution has finished; do not
// pass its result to replay workers. It deliberately shares only selection eligibility with generateReplayTask
// and never carries frozen context.
//
// IMPORTANT: `eligible: true` here means only that selectFreezePoint accepted the candidate -- it does NOT
// mean generateReplayTask would also produce a usable frozen task for it. generateReplayTask can still reject
// a selection-eligible candidate afterward (`rejected: "unscrubbable_forward_reference"`, from
// lintFrozenContext), because scrub/lint eligibility is about the FROZEN CONTEXT TEXT, which this function
// never touches -- it only reveals commitCount/groundTruth, so lint/scrub has nothing to check here. A caller
// must not assume a scoring key implies a replay task was ever generated for the same candidate; check
// generateReplayTask's own result independently before treating the two as a matched pair.
export function generateReplayScoringKey(candidate, options) {
    const selection = selectFreezePoint(candidate, options?.thresholds);
    if (!selection.eligible) {
        return { eligible: false, rejected: "selection", reasons: selection.reasons };
    }
    return {
        eligible: true,
        commitCount: selection.revealedCommitCount,
        groundTruth: candidate?.revealedGroundTruth ?? null,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVwbGF5LXRhc2stZ2VuZXJhdGlvbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInJlcGxheS10YXNrLWdlbmVyYXRpb24udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsc0ZBQXNGO0FBQ3RGLEVBQUU7QUFDRix1R0FBdUc7QUFDdkcsMkdBQTJHO0FBQzNHLDJHQUEyRztBQUMzRywyR0FBMkc7QUFDM0csOEdBQThHO0FBQzlHLHFHQUFxRztBQUNyRyxvR0FBb0c7QUFDcEcsa0JBQWtCO0FBRWxCLDBHQUEwRztBQUMxRyxvRUFBb0U7QUFDcEUsTUFBTSxDQUFDLE1BQU0sdUJBQXVCLEdBQUcsd0JBQXdCLENBQUM7QUFJaEUseUdBQXlHO0FBQ3pHLHlEQUF5RDtBQUN6RCxNQUFNLENBQUMsTUFBTSxhQUFhLEdBQTJCLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxRQUFRLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztBQXdGeEYsU0FBUyxnQkFBZ0IsQ0FBQyxNQUFlO0lBQ3ZDLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7SUFDOUIsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDMUIsS0FBSyxNQUFNLEtBQUssSUFBSSxNQUFNLEVBQUUsQ0FBQztZQUMzQixJQUFJLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLElBQUksS0FBSyxHQUFHLENBQUM7Z0JBQUUsR0FBRyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMzRCxDQUFDO0lBQ0gsQ0FBQztJQUNELE9BQU8sR0FBRyxDQUFDO0FBQ2IsQ0FBQztBQUVELFNBQVMsUUFBUSxDQUFDLE1BQWU7SUFDL0IsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztJQUM5QixJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUMxQixLQUFLLE1BQU0sS0FBSyxJQUFJLE1BQU0s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