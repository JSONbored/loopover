import type { AdvisoryCheckRunSpec } from "@loopover/engine";

/** True when `run` matches a configured `gate.advisoryCheckRuns` entry (name + app slug, case-insensitive). */
export function matchesConfiguredAdvisoryCheckRun(
  run: { name: string; app?: { slug?: string | null } | null },
  specs: ReadonlyArray<AdvisoryCheckRunSpec> | null | undefined,
): boolean {
  if (!specs || specs.length === 0) return false;
  const runName = run.name.trim().toLowerCase();
  const runSlug = (run.app?.slug ?? "").trim().toLowerCase();
  if (!runName || !runSlug) return false;
  return specs.some(
    (spec) => spec.name.trim().toLowerCase() === runName && spec.appSlug.trim().toLowerCase() === runSlug,
  );
}

const ADVISORY_PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** A completed advisory check-run with one of these conclusions is settled and needs no hold. */
export function isAdvisoryCheckRunSettledPass(conclusion: string): boolean {
  return ADVISORY_PASSING_CONCLUSIONS.has(conclusion.trim().toLowerCase());
}

/** Stable cache-key fragment for a repo's configured advisory check-run list (#4372). */
export function advisoryCheckRunsKeyPart(specs: ReadonlyArray<AdvisoryCheckRunSpec> | null | undefined): string {
  if (!specs || specs.length === 0) return "";
  return JSON.stringify(
    [...specs]
      .map((spec) => ({ name: spec.name, appSlug: spec.appSlug }))
      .sort((left, right) => `${left.appSlug}/${left.name}`.localeCompare(`${right.appSlug}/${right.name}`)),
  );
}

export function resolveAdvisoryCheckHold(
  advisoryHoldDetails: ReadonlyArray<{ name: string; summary?: string; appSlug?: string }> | undefined,
  advisoryCheckRuns: ReadonlyArray<AdvisoryCheckRunSpec> | null | undefined,
): { checkNames: readonly string[]; reason: string; comment: string } | undefined {
  if (!advisoryCheckRuns?.length || !advisoryHoldDetails?.length) return undefined;
  const checkNames = advisoryHoldDetails.map((detail) => detail.name);
  const lines = advisoryHoldDetails.map((detail) => {
    const app = detail.appSlug?.trim();
    const summary = detail.summary?.trim();
    const prefix = app ? `${detail.name} (${app})` : detail.name;
    return summary ? `- ${prefix}: ${summary}` : `- ${prefix}`;
  });
  return {
    checkNames,
    reason: `advisory check-run hold (${checkNames.join(", ")})`,
    comment: `LoopOver: a configured advisory check-run needs maintainer action before this PR can merge:\n${lines.join("\n")}`,
  };
}
