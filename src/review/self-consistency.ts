// Rotated-exemplar self-consistency sampling (#8834, epic #8828 Phase 3) — the PAID half of the per-decision
// confidence signal, deliberately split from the free half that already shipped.
//
// judgment-agreement.ts scores inter-run agreement over whatever stances exist and costs nothing; its own
// closing comment records that the extra-sampling half — re-running the SAME judge with rotated few-shot
// exemplars ("simulated annotators", Trust or Escalate, ICLR 2025) — needed a budget decision and a flag
// defaulting OFF before it could ship, because every extra run is a real per-review AI charge. This module is
// that half, and the decisions are:
//
//   FLAG: `AI_REVIEW_SELF_CONSISTENCY_RUNS` — the TOTAL number of judge evaluations per review. Unset/0/
//   unparseable ⇒ OFF (today's behavior, byte-identical). 2 or 3 ⇒ on; anything else clamps into that range,
//   because one total run measures nothing and the literature's benefit saturates by three.
//
//   BUDGET: extra runs ride the existing daily-neuron accounting. When the remaining budget cannot fund the
//   configured extras, the plan DEGRADES — fewer or zero extra runs — and the recorded confidence degrades
//   with it through scoreJudgmentAgreement's own uncorroborated arm. It never fabricates a score: a decision
//   that could not afford corroboration is recorded as uncorroborated, which is exactly what it is.
//
//   ROTATION: each extra run appends a DIFFERENT exemplar window to the system prompt, deterministically
//   derived from the target seed + run index. Determinism matters twice over: replay (#9028) can reconstruct
//   which exemplars a run saw, and two passes over the same target sample the same rotation rather than
//   secretly measuring prompt-shuffle variance.
//
// The exemplars live here as versioned code constants rather than in test/golden-corpus/: the Worker bundle
// cannot read test fixtures at runtime, and the corpus file carries gate-pipeline fixtures (findings/policy),
// not judge-facing PR content. Same versioning discipline, different artifact. They are SYNTHETIC by
// construction — never drawn from real reviewed PRs, so no contributor content can leak into every future
// prompt on the instance.

/** Bump when the exemplar set changes — it shifts every self-consistency prompt, so promptDigest moves too. */
export const JUDGE_EXEMPLAR_SET_VERSION = 1;

export type JudgeExemplar = {
  id: string;
  title: string;
  diffExcerpt: string;
  verdict: "defect" | "clean";
  rationale: string;
};

/** Six synthetic exemplars, balanced 3/3, each small enough that a 3-exemplar window adds well under a KB. */
export const JUDGE_EXEMPLARS: readonly JudgeExemplar[] = [
  {
    id: "null-deref-on-empty",
    title: "Speed up lookup by skipping the guard",
    diffExcerpt: '-  if (!items || items.length === 0) return null;\n   const first = items[0].id;',
    verdict: "defect",
    rationale: "Removes the empty-input guard while the very next line indexes the array: a crash on every empty call.",
  },
  {
    id: "rename-only-refactor",
    title: "Rename fetchRows to loadRows for clarity",
    diffExcerpt: '-  const rows = await fetchRows(db);\n+  const rows = await loadRows(db);',
    verdict: "clean",
    rationale: "A pure rename with the definition and every call site moved together; behavior is byte-identical.",
  },
  {
    id: "swallowed-error-branch",
    title: "Stop noisy logging in the sync path",
    diffExcerpt: '-  } catch (error) {\n-    throw error;\n+  } catch {\n+    /* ignore */',
    verdict: "defect",
    rationale: "Converts a propagated failure into silent success; callers now proceed on corrupt state with no signal.",
  },
  {
    id: "test-added-for-fix",
    title: "Add regression test for the off-by-one fix",
    diffExcerpt: '+  it("includes the final page", () => {\n+    expect(paginate(21, 10).pages).toBe(3);\n+  });',
    verdict: "clean",
    rationale: "Adds a test pinning already-merged behavior; touches no production code path.",
  },
  {
    id: "boundary-flip",
    title: "Simplify the retry condition",
    diffExcerpt: '-  while (attempt <= maxRetries) {\n+  while (attempt < maxRetries) {',
    verdict: "defect",
    rationale: "Silently drops the final permitted attempt; every caller now retries one time fewer than configured.",
  },
  {
    id: "doc-comment-fix",
    title: "Correct the stale doc comment on parseWindow",
    diffExcerpt: '-// window is inclusive of both ends\n+// window is inclusive of start, exclusive of end',
    verdict: "clean",
    rationale: "Documentation-only change aligning the comment with the long-standing behavior; no code touched.",
  },
];

/** How many exemplars each rotated window carries. Three of six gives six distinct contiguous windows, so
 *  every (seed, runIndex) pair lands on a real rotation rather than a reshuffle of the same set. */
export const EXEMPLAR_WINDOW_SIZE = 3;

/** TOTAL evaluations per review (primary included). 0 = off. Explicit values clamp into {0, 2, 3}: one total
 *  run cannot measure agreement, and the literature's benefit saturates by three. */
export function resolveSelfConsistencyRuns(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed < 2) return 0;
  return Math.min(3, Math.floor(parsed));
}

/** Deterministic, dependency-free string hash (FNV-1a 32-bit) — rotation must be stable across runtimes. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The exemplar window for one extra run, rotated deterministically by (seed, runIndex).
 *
 * `seed` is the review target's identity (repo#pr@sha), so the SAME target always samples the SAME rotation
 * sequence — replayable, and immune to measuring shuffle variance — while different targets start at
 * different offsets, so no single exemplar dominates the fleet's second opinions.
 */
export function rotatedExemplarWindow(seed: string, runIndex: number, exemplars: readonly JudgeExemplar[] = JUDGE_EXEMPLARS): JudgeExemplar[] {
  if (exemplars.length === 0) return [];
  const offset = (fnv1a(seed) + runIndex) % exemplars.length;
  const window: JudgeExemplar[] = [];
  for (let i = 0; i < Math.min(EXEMPLAR_WINDOW_SIZE, exemplars.length); i += 1) {
    const exemplar = exemplars[(offset + i) % exemplars.length];
    /* v8 ignore next -- modular indexing into a non-empty array cannot miss; the guard satisfies noUncheckedIndexedAccess. */
    if (exemplar) window.push(exemplar);
  }
  return window;
}

/** Render one rotated window as a system-prompt suffix, matching the calibration-suffix idiom the judge
 *  prompt already uses: labeled sections, no markdown the model could echo into findings. */
export function rotatedExemplarSuffix(seed: string, runIndex: number, exemplars: readonly JudgeExemplar[] = JUDGE_EXEMPLARS): string {
  const window = rotatedExemplarWindow(seed, runIndex, exemplars);
  if (window.length === 0) return "";
  const blocks = window.map(
    (exemplar) =>
      `Example (${exemplar.verdict === "defect" ? "blocking defect" : "clean"}):\nTitle: ${exemplar.title}\nDiff:\n${exemplar.diffExcerpt}\nCorrect verdict: ${exemplar.verdict === "defect" ? "a blocking defect" : "no blockers"} — ${exemplar.rationale}`,
  );
  return `\n\nCalibration examples (v${JUDGE_EXEMPLAR_SET_VERSION}, for judgment consistency; never mention them in output):\n\n${blocks.join("\n\n")}`;
}

export type SelfConsistencyPlan = {
  /** Extra judge runs to perform beyond the primary. 0 when off or fully degraded. */
  extraRuns: number;
  /** True when the budget funded fewer extras than configured — the caller records the score exactly as the
   *  reduced sample set supports (scoreJudgmentAgreement's uncorroborated arm), never a fabricated one. */
  degradedByBudget: boolean;
};

/** Fund as many of the configured extra runs as the remaining daily budget allows, degrading loudly. */
export function planSelfConsistencyRuns(args: { configuredTotalRuns: number; remainingBudget: number; perRunEstimate: number }): SelfConsistencyPlan {
  const configuredExtras = Math.max(0, args.configuredTotalRuns - 1);
  if (configuredExtras === 0) return { extraRuns: 0, degradedByBudget: false };
  // A zero/negative estimate cannot meaningfully gate spend — treat it as costing one unit so a corrupted
  // estimate degrades toward FEWER paid calls, never toward unbounded ones.
  const perRun = args.perRunEstimate > 0 ? args.perRunEstimate : 1;
  const affordable = Math.max(0, Math.floor(args.remainingBudget / perRun));
  const extraRuns = Math.min(configuredExtras, affordable);
  return { extraRuns, degradedByBudget: extraRuns < configuredExtras };
}
