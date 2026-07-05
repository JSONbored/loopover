import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAiPolicyVerdict } from "../../packages/gittensory-engine/src/ai-policy-map";

// Fixture-corpus companion to miner-ai-policy-map.test.ts (#2306). The sibling test exercises the
// scanner with inline strings; this one drives resolveAiPolicyVerdict over real .md documents on disk
// (varied real-world phrasings of AI-PR bans, plus near-miss non-bans) to prove the verdict is stable
// against realistic file content, not just hand-tuned one-liners.

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ai-policy");

function readFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

type DocKind = "AI-USAGE.md" | "CONTRIBUTING.md";

type FixtureCase = {
  file: string;
  docKind: DocKind;
  allowed: boolean;
  matchedPhrase: string | null;
};

// The source column mirrors how the fan-out loads each doc: an AI-USAGE.md fixture is passed as
// { aiUsage, contributing: null }, a CONTRIBUTING.md fixture as { aiUsage: null, contributing }.
const cases: FixtureCase[] = [
  {
    file: "banned-explicit.md",
    docKind: "CONTRIBUTING.md",
    allowed: false,
    matchedPhrase: "no ai-generated pull requests",
  },
  {
    file: "banned-ai-usage.md",
    docKind: "AI-USAGE.md",
    allowed: false,
    matchedPhrase: "ai-generated prs are rejected",
  },
  {
    file: "allowed-silent.md",
    docKind: "CONTRIBUTING.md",
    allowed: true,
    matchedPhrase: null,
  },
  {
    file: "allowed-encourages-ai.md",
    docKind: "AI-USAGE.md",
    allowed: true,
    matchedPhrase: null,
  },
  {
    file: "ambiguous-mentions-ai-tools.md",
    docKind: "CONTRIBUTING.md",
    allowed: true,
    matchedPhrase: null,
  },
];

describe("AI policy fixture corpus (#2306)", () => {
  it.each(cases)(
    "resolves $file ($docKind) to allowed=$allowed",
    ({ file, docKind, allowed, matchedPhrase }) => {
      const content = readFixture(file);
      const docs =
        docKind === "AI-USAGE.md"
          ? { aiUsage: content, contributing: null }
          : { aiUsage: null, contributing: content };

      expect(resolveAiPolicyVerdict(docs)).toEqual({
        allowed,
        matchedPhrase,
        source: docKind,
      });
    },
  );

  it("denies every banned-* fixture and allows every allowed-*/ambiguous-* fixture", () => {
    for (const testCase of cases) {
      const expectedAllowed = !testCase.file.startsWith("banned-");
      expect(testCase.allowed).toBe(expectedAllowed);
    }
  });
});
