import { describe, expect, it } from "vitest";

import { parseFocusManifest } from "../../src/signals/focus-manifest";
import { compileRepoPolicyCompilerOutput } from "../../src/signals/repo-policy-compiler";

describe("compileRepoPolicyCompilerOutput", () => {
  it("returns empty lanes when manifest is absent", () => {
    const output = compileRepoPolicyCompilerOutput({
      repoFullName: "owner/repo",
      manifest: parseFocusManifest(null),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(output.contributionLanes).toEqual([]);
    expect(output.labelPolicy.note).toMatch(/accepted scope/i);
  });

  it("covers direct-PR and issue-discovery lane preference branches", () => {
    const discouraged = compileRepoPolicyCompilerOutput({
      repoFullName: "owner/discouraged",
      manifest: parseFocusManifest({
        wantedPaths: ["src/"],
        issueDiscoveryPolicy: "discouraged",
      }),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(discouraged.contributionLanes[0]?.summary).toMatch(/discouraged/i);
    expect(discouraged.contributionLanes[1]?.summary).toMatch(/direct fixes/i);

    const preferred = compileRepoPolicyCompilerOutput({
      repoFullName: "owner/preferred",
      manifest: parseFocusManifest({
        wantedPaths: ["src/"],
        issueDiscoveryPolicy: "encouraged",
        linkedIssuePolicy: "required",
      }),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(preferred.contributionLanes[0]?.title).toMatch(/discouraged/i);
    expect(preferred.contributionLanes[1]?.title).toMatch(/preferred/i);
    expect(preferred.labelPolicy.note).toMatch(/tracked issue before opening/i);

    const linkedPreferred = compileRepoPolicyCompilerOutput({
      repoFullName: "owner/neutral",
      manifest: parseFocusManifest({ wantedPaths: ["src/"], linkedIssuePolicy: "preferred" }),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(linkedPreferred.labelPolicy.note).toMatch(/when one exists/i);

    const neutralLanes = compileRepoPolicyCompilerOutput({
      repoFullName: "owner/neutral-lanes",
      manifest: parseFocusManifest({ preferredLabels: ["bug"] }),
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(neutralLanes.contributionLanes[0]?.summary).toMatch(/accepted when they stay inside/i);
    expect(neutralLanes.contributionLanes[1]?.summary).toMatch(/optional/i);
    expect(neutralLanes.contributionLanes[0]?.title).toBe("Direct pull request lane");
    expect(neutralLanes.contributionLanes[1]?.title).toBe("Issue discovery lane");
  });

  it("filters unsafe public notes from boundaries", () => {
    const output = compileRepoPolicyCompilerOutput({
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
    expect(output.publicOutputBoundaries.join(" ")).not.toMatch(/wallet|payout/i);
  });
});
