import { describe, expect, it } from "vitest";
import {
  classifyContributorFit,
  type ContributorFitProfile,
} from "../../packages/gittensory-engine/src/index";

function profile(overrides: Partial<ContributorFitProfile> = {}): ContributorFitProfile {
  return {
    login: "miner",
    registeredRepoActivity: {
      pullRequests: 10,
      mergedPullRequests: 9,
      reposTouched: ["JSONbored/gittensory"],
    },
    trustSignals: { level: "established", unlinkedOpenPullRequests: 0 },
    ...overrides,
  };
}

describe("classifyContributorFit", () => {
  it("is neutral with no prior activity on the target repo (a first attempt is not poor fit)", () => {
    const result = profile({
      registeredRepoActivity: { pullRequests: 0, mergedPullRequests: 0, reposTouched: [] },
      trustSignals: { level: "new", unlinkedOpenPullRequests: 5 },
    });
    expect(classifyContributorFit(result, "entrius/gittensor")).toEqual({
      fit: "neutral",
      reasons: ["No prior activity on entrius/gittensor; a first attempt is not evidence of poor fit."],
    });
  });

  it("is weak when the contributor has unlinked open pull requests against the touched repo", () => {
    const result = profile({
      trustSignals: { level: "established", unlinkedOpenPullRequests: 3 },
    });
    const { fit, reasons } = classifyContributorFit(result, "JSONbored/gittensory");
    expect(fit).toBe("weak");
    expect(reasons).toContain("3 unlinked open pull request(s)");
  });

  it("is weak for a new profile whose few attempts mostly failed to merge", () => {
    const result = profile({
      registeredRepoActivity: { pullRequests: 10, mergedPullRequests: 2, reposTouched: ["JSONbored/gittensory"] },
      trustSignals: { level: "new", unlinkedOpenPullRequests: 0 },
    });
    const { fit, reasons } = classifyContributorFit(result, "JSONbored/gittensory");
    expect(fit).toBe("weak");
    expect(reasons).toContain("new profile with low merge ratio (2/10)");
  });

  it("is strong for an established profile with a clean queue and a high merge ratio", () => {
    const result = profile();
    const { fit, reasons } = classifyContributorFit(result, "JSONbored/gittensory");
    expect(fit).toBe("strong");
    expect(reasons).toContain("trust level is 'established'");
    expect(reasons).toContain("no unlinked open pull requests");
    expect(reasons).toContain("strong merge ratio (9/10)");
  });

  it("is neutral when history exists but signals are mixed (emerging, clean queue, mid merge ratio)", () => {
    const result = profile({
      registeredRepoActivity: { pullRequests: 10, mergedPullRequests: 6, reposTouched: ["JSONbored/gittensory"] },
      trustSignals: { level: "emerging", unlinkedOpenPullRequests: 0 },
    });
    const { fit, reasons } = classifyContributorFit(result, "JSONbored/gittensory");
    expect(fit).toBe("neutral");
    expect(reasons).toContain("no unlinked open pull requests");
    expect(reasons.some((r) => r.startsWith("strong merge ratio"))).toBe(false);
  });

  it("is neutral for touched-repo history with no recorded pull-request count", () => {
    const result = profile({
      registeredRepoActivity: { pullRequests: 0, mergedPullRequests: 0, reposTouched: ["JSONbored/gittensory"] },
      trustSignals: { level: "established", unlinkedOpenPullRequests: 0 },
    });
    const { fit, reasons } = classifyContributorFit(result, "JSONbored/gittensory");
    expect(fit).toBe("neutral");
    expect(reasons).toContain("trust level is 'established'");
    expect(reasons).toContain("no unlinked open pull requests");
  });

  it("matches the exact verdicts across the strong/neutral/weak axis", () => {
    const verdicts = [
      profile(),
      profile({ trustSignals: { level: "established", unlinkedOpenPullRequests: 0 } }),
      profile({ trustSignals: { level: "established", unlinkedOpenPullRequests: 1 } }),
    ].map((p) => classifyContributorFit(p, "JSONbored/gittensory").fit);
    expect(verdicts).toEqual(["strong", "strong", "weak"]);
  });
});
