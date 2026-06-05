import { describe, expect, it } from "vitest";

import { parseFocusManifest } from "../../src/signals/focus-manifest";
import {
  compileRepoPolicyCompilerOutput,
  type RepoPolicyCompilerInput,
} from "../../src/signals/repo-policy-compiler";
import type { RepoPolicyCompilerOutput } from "../../src/signals/onboarding-pack";

function lanes(output: RepoPolicyCompilerOutput, min = 1) {
  expect(output.contributionLanes).toBeDefined();
  expect(output.contributionLanes!.length).toBeGreaterThanOrEqual(min);
  return output.contributionLanes!;
}

function labelPolicy(output: RepoPolicyCompilerOutput) {
  expect(output.labelPolicy).toBeDefined();
  return output.labelPolicy!;
}

function compile(input: RepoPolicyCompilerInput) {
  return compileRepoPolicyCompilerOutput(input);
}

describe("compileRepoPolicyCompilerOutput", () => {
  it("returns empty lanes when manifest is absent", () => {
    const output = compile({
      repoFullName: "owner/repo",
      manifest: parseFocusManifest(null),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(output.contributionLanes).toEqual([]);
    expect(labelPolicy(output).note).toMatch(/accepted scope/i);
  });

  it("covers direct-PR and issue-discovery lane preference branches", () => {
    const discouraged = compile({
      repoFullName: "owner/discouraged",
      manifest: parseFocusManifest({
        wantedPaths: ["src/"],
        issueDiscoveryPolicy: "discouraged",
      }),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(lanes(discouraged, 2)[0]!.summary).toMatch(/discouraged/i);
    expect(lanes(discouraged, 2)[1]!.summary).toMatch(/direct fixes/i);

    const preferred = compile({
      repoFullName: "owner/preferred",
      manifest: parseFocusManifest({
        wantedPaths: ["src/"],
        issueDiscoveryPolicy: "encouraged",
        linkedIssuePolicy: "required",
      }),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(lanes(preferred, 2)[0]!.title).toMatch(/discouraged/i);
    expect(lanes(preferred, 2)[1]!.title).toMatch(/preferred/i);
    expect(labelPolicy(preferred).note).toMatch(/tracked issue before opening/i);

    const linkedPreferred = compile({
      repoFullName: "owner/neutral",
      manifest: parseFocusManifest({ wantedPaths: ["src/"], linkedIssuePolicy: "preferred" }),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(labelPolicy(linkedPreferred).note).toMatch(/when one exists/i);

    const neutralLanes = compile({
      repoFullName: "owner/neutral-lanes",
      manifest: parseFocusManifest({ preferredLabels: ["bug"] }),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    const neutral = lanes(neutralLanes, 2);
    expect(neutral[0]!.summary).toMatch(/accepted when they stay inside/i);
    expect(neutral[1]!.summary).toMatch(/optional/i);
    expect(neutral[0]!.title).toBe("Direct pull request lane");
    expect(neutral[1]!.title).toBe("Issue discovery lane");
  });

  it("filters unsafe public notes from boundaries", () => {
    const output = compile({
      repoFullName: "owner/repo",
      manifest: parseFocusManifest({
        wantedPaths: ["src/"],
        publicNotes: ["Stay focused.", "wallet hotkey payout"],
      }),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(output.publicOutputBoundaries).toEqual(
      expect.arrayContaining([expect.stringContaining("Stay focused.")]),
    );
    expect(output.publicOutputBoundaries!.join(" ")).not.toMatch(/wallet|payout/i);
  });
});
