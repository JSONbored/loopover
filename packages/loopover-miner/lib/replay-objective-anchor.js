// Deterministic structural "objective-anchor" score for the historical-replay calibration harness (#3012).
//
// Once a replay run produces a plan/PR against a frozen snapshot, half of the calibration score is meant to
// come from a deterministic, auditable structural comparison rather than an LLM judgment. This module is that
// structural half: it compares what the miner's replayed output *targeted* (modules touched + change kind)
// against what the revealed post-T history *actually* changed, and returns a reproducible `[0, 1]` score plus
// a full audit breakdown. There is no model call in this path — given the same two feature sets it is
// byte-for-byte reproducible.
// Fixed change-kind vocabulary. Conventional-Commit types collapse onto these buckets; anything unrecognized
// degrades to "other" so a novel prefix lowers the signal instead of throwing.
export const CHANGE_KINDS = Object.freeze([
    "feature",
    "fix",
    "refactor",
    "docs",
    "test",
    "chore",
    "perf",
    "build",
    "ci",
    "style",
    "other",
]);
const CONVENTIONAL_TYPE_TO_KIND = new Map([
    ["feat", "feature"],
    ["feature", "feature"],
    ["fix", "fix"],
    ["bugfix", "fix"],
    ["refactor", "refactor"],
    ["docs", "docs"],
    ["doc", "docs"],
    ["test", "test"],
    ["tests", "test"],
    ["chore", "chore"],
    ["perf", "perf"],
    ["build", "build"],
    ["ci", "ci"],
    ["style", "style"],
]);
// Fixed weights for the two structural components. They sum to 1 so the composed score stays in [0, 1].
export const MODULE_OVERLAP_WEIGHT = 0.7;
export const CHANGE_KIND_WEIGHT = 0.3;
const SCORE_PRECISION = 1e4;
function roundScore(value) {
    return Math.round(value * SCORE_PRECISION) / SCORE_PRECISION;
}
// A path's "module" is its directory (everything before the final slash); a bare filename is its own module.
// Grouping by directory is what makes two different files in one directory a *partial* overlap, not a miss.
function pathToModule(path) {
    const trimmed = path.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (!trimmed)
        return null;
    const slash = trimmed.lastIndexOf("/");
    return slash === -1 ? trimmed : trimmed.slice(0, slash);
}
function normalizeModules(pathsTouched) {
    if (!Array.isArray(pathsTouched))
        return [];
    const modules = new Set();
    for (const entry of pathsTouched) {
        if (typeof entry !== "string")
            continue;
        const module = pathToModule(entry);
        if (module)
            modules.add(module);
    }
    return [...modules].sort();
}
function normalizeKindList(value) {
    if (!Array.isArray(value))
        return [];
    const kinds = new Set();
    for (const entry of value) {
        if (typeof entry === "string" && isChangeKind(entry))
            kinds.add(entry);
    }
    return [...kinds].sort();
}
function isChangeKind(value) {
    return CHANGE_KINDS.includes(value);
}
function normalizeModuleList(value) {
    if (!Array.isArray(value))
        return [];
    const modules = new Set();
    for (const entry of value) {
        if (typeof entry === "string" && entry)
            modules.add(entry);
    }
    return [...modules].sort();
}
// Deterministically map a Conventional-Commit-style subject (`feat(scope)!: …`) to a change-kind bucket.
// Missing prefix, unknown type, or non-string input all resolve to "other" rather than throwing.
export function classifyChangeKind(value) {
    if (typeof value !== "string")
        return "other";
    const match = /^\s*([A-Za-z]+)\s*(?:\([^)]*\))?\s*!?\s*:/.exec(value);
    if (!match)
        return "other";
    return CONVENTIONAL_TYPE_TO_KIND.get(match[1].toLowerCase()) ?? "other";
}
function resolveChangeKind(entry) {
    if (entry && typeof entry.changeKind === "string") {
        const explicit = entry.changeKind.trim().toLowerCase();
        if (isChangeKind(explicit))
            return explicit;
    }
    return classifyChangeKind(entry?.title);
}
// Structural features of the miner's replayed plan/PR: the sorted, de-duplicated set of modules it targeted
// and its single change kind (explicit `changeKind` wins; otherwise classified from `title`).
export function extractReplayTargetFeatures(plan) {
    return {
        modules: normalizeModules(plan?.pathsTouched),
        changeKind: resolveChangeKind(plan),
    };
}
// Structural features of the revealed post-T history. The history is a list of commits/PRs (a single object
// is tolerated as a one-element list); modules are unioned and change kinds collected into a set, since the
// revealed side legitimately spans several changes.
export function extractRevealedFeatures(history) {
    const entries = Array.isArray(history) ? history : history ? [history] : [];
    const modules = new Set();
    const changeKinds = new Set();
    for (const entry of entries) {
        if (!entry || typeof entry !== "object")
            continue;
        const record = entry;
        for (const module of normalizeModules(record.pathsTouched))
            modules.add(module);
        changeKinds.add(resolveChangeKind(record));
    }
    return {
        modules: [...modules].sort(),
        changeKinds: [...changeKinds].sort(),
    };
}
// Deterministic objective-anchor score from two already-extracted feature sets. No LLM, no clock, no
// randomness — identical inputs always yield an identical breakdown. A zero-overlap comparison (disjoint
// modules and a change kind the revealed side never shows) resolves to the score floor `0`, never an error.
export function scoreObjectiveAnchor(replayFeatures, revealedFeatures) {
    const replayModules = normalizeModuleList(replayFeatures?.modules);
    const revealedModules = normalizeModuleList(revealedFeatures?.modules);
    const replayChangeKind = typeof replayFeatures?.changeKind === "string" && isChangeKind(replayFeatures.changeKind)
        ? replayFeatures.changeKind
        : "other";
    const revealedChangeKinds = normalizeKindList(revealedFeatures?.changeKinds);
    const replaySet = new Set(replayModules);
    const revealedSet = new Set(revealedModules);
    const sharedModules = replayModules.filter((module) => revealedSet.has(module));
    const replayOnlyModules = replayModules.filter((module) => !revealedSet.has(module));
    const revealedOnlyModules = revealedModules.filter((module) => !replaySet.has(module));
    const unionSize = replayModules.length + revealedModules.length - sharedModules.length;
    const moduleOverlap = unionSize === 0 ? 0 : sharedModules.length / unionSize;
    const changeKindMatch = revealedChangeKinds.includes(replayChangeKind) ? 1 : 0;
    return {
        score: roundScore(MODULE_OVERLAP_WEIGHT * moduleOverlap + CHANGE_KIND_WEIGHT * changeKindMatch),
        moduleOverlap: roundScore(moduleOverlap),
        changeKindMatch,
        replayChangeKind,
        revealedChangeKinds,
        sharedModules,
        replayOnlyModules,
        revealedOnlyModules,
    };
}
// One-shot entry point: extract both sides, score them, and return the score together with the extracted
// feature sets so a low score is auditable after the fact without re-running the extraction.
export function computeObjectiveAnchor(input) {
    const replayFeatures = extractReplayTargetFeatures(input?.replayPlan);
    const revealedFeatures = extractRevealedFeatures(input?.revealedHistory);
    return {
        ...scoreObjectiveAnchor(replayFeatures, revealedFeatures),
        replayFeatures,
        revealedFeatures,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVwbGF5LW9iamVjdGl2ZS1hbmNob3IuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZXBsYXktb2JqZWN0aXZlLWFuY2hvci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwyR0FBMkc7QUFDM0csRUFBRTtBQUNGLDRHQUE0RztBQUM1Ryw4R0FBOEc7QUFDOUcsMkdBQTJHO0FBQzNHLDhHQUE4RztBQUM5RyxzR0FBc0c7QUFDdEcsOEJBQThCO0FBZTlCLDZHQUE2RztBQUM3RywrRUFBK0U7QUFDL0UsTUFBTSxDQUFDLE1BQU0sWUFBWSxHQUEwQixNQUFNLENBQUMsTUFBTSxDQUFDO0lBQy9ELFNBQVM7SUFDVCxLQUFLO0lBQ0wsVUFBVTtJQUNWLE1BQU07SUFDTixNQUFNO0lBQ04sT0FBTztJQUNQLE1BQU07SUFDTixPQUFPO0lBQ1AsSUFBSTtJQUNKLE9BQU87SUFDUCxPQUFPO0NBQ1IsQ0FBQyxDQUFDO0FBRUgsTUFBTSx5QkFBeUIsR0FBRyxJQUFJLEdBQUcsQ0FBcUI7SUFDNUQsQ0FBQyxNQUFNLEVBQUUsU0FBUyxDQUFDO0lBQ25CLENBQUMsU0FBUyxFQUFFLFNBQVMsQ0FBQztJQUN0QixDQUFDLEtBQUssRUFBRSxLQUFLLENBQUM7SUFDZCxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUM7SUFDakIsQ0FBQyxVQUFVLEVBQUUsVUFBVSxDQUFDO0lBQ3hCLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQztJQUNoQixDQUFDLEtBQUssRUFBRSxNQUFNLENBQUM7SUFDZixDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUM7SUFDaEIsQ0FBQyxPQUFPLEVBQUUsTUFBTSxDQUFDO0lBQ2pCLENBQUMsT0FBTyxFQUFFLE9BQU8sQ0FBQztJQUNsQixDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUM7SUFDaEIsQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDO0lBQ2xCLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQztJQUNaLENBQUMsT0FBTyxFQUFFLE9BQU8sQ0FB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