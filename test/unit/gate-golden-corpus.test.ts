import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateGateCheck, type GateCheckPolicy } from "../../src/rules/advisory";
import type { Advisory, AdvisoryFinding } from "../../src/types";

// #8832 (epic #8828): the golden gate corpus. Each entry replays the PURE gate evaluation against a
// decision-input snapshot drawn from a real production failure archetype and pins the expected conclusion +
// blocker set. This suite runs on every PR (the fast tier the issue requires — the corpus is pure and
// millisecond-cheap); entries marked knownBad additionally pin the invariant that they may NEVER evaluate to
// success, the exact regression class that motivated the epic. Adding to the corpus is append-only: a
// production failure becomes a labeled entry here in the same PR that fixes it.
type CorpusEntry = {
  id: string;
  source: string;
  description: string;
  knownBad: boolean;
  findings: Array<Pick<AdvisoryFinding, "code" | "title" | "severity" | "detail"> & { confidence?: number }>;
  policy: GateCheckPolicy;
  expected: { conclusion: string; blockerCodes: string[]; displayConclusion?: string };
};

const corpus = JSON.parse(readFileSync("test/golden-corpus/gate-corpus.json", "utf8")) as { version: number; entries: CorpusEntry[] };

function advisoryOf(entry: CorpusEntry): Advisory {
  return {
    id: `golden-${entry.id}`,
    targetType: "pull_request",
    targetKey: "golden/corpus#1",
    repoFullName: "golden/corpus",
    pullNumber: 1,
    conclusion: "neutral",
    severity: "info",
    title: "golden",
    summary: "golden corpus entry",
    findings: entry.findings as AdvisoryFinding[],
    generatedAt: "2026-07-26T00:00:00.000Z",
  };
}

describe("golden gate corpus (#8832)", () => {
  it("corpus file is well-formed: version, unique ids, non-empty archetype coverage", () => {
    expect(corpus.version).toBe(2);
    expect(corpus.entries.length).toBeGreaterThanOrEqual(14);
    expect(new Set(corpus.entries.map((entry) => entry.id)).size).toBe(corpus.entries.length);
    // The corpus must always carry at least one knownBad guard — the never-flips-to-merge invariant is its point.
    expect(corpus.entries.some((entry) => entry.knownBad)).toBe(true);
  });

  it.each(corpus.entries.map((entry) => [entry.id, entry] as const))("replays %s to its pinned verdict", (_id, entry) => {
    const evaluation = evaluateGateCheck(advisoryOf(entry), entry.policy);
    expect(evaluation.conclusion).toBe(entry.expected.conclusion);
    expect(evaluation.blockers.map((blocker) => blocker.code).sort()).toEqual([...entry.expected.blockerCodes].sort());
    if (entry.expected.displayConclusion !== undefined) {
      expect(evaluation.displayConclusion).toBe(entry.expected.displayConclusion);
    }
  });

  it("INVARIANT: no knownBad entry may EVER evaluate to success — under its own policy or the permissive default", () => {
    for (const entry of corpus.entries.filter((candidate) => candidate.knownBad)) {
      expect(evaluateGateCheck(advisoryOf(entry), entry.policy).conclusion).not.toBe("success");
      // A knownBad violation must also survive a maintainer relaxing every optional mode to default.
      expect(evaluateGateCheck(advisoryOf(entry), {}).conclusion).not.toBe("success");
    }
  });
});
