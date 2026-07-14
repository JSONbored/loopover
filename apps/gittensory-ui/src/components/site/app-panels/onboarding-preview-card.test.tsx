import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import { OnboardingPreviewCard } from "@/components/site/app-panels/onboarding-preview-card";
import type { SettingsPreviewResponse } from "@/components/site/app-panels/maintainer-panel";

const INSTALL_PREVIEW = {
  status: "ready" as const,
  summary: "All checks pass.",
  readScope: [],
  computedContext: [],
  previewBehavior: [],
  permissions: {
    status: "ready" as const,
    required: [],
    missing: [],
    missingEvents: [],
    summary: "ok",
  },
  publicOutputs: [],
  privateOnlyContext: [],
  commandAuthorization: [],
  auditBehavior: [],
  sanitizerBoundaries: [],
  manualControls: [],
  checklist: [],
};

function preview(overrides: Partial<SettingsPreviewResponse> = {}): SettingsPreviewResponse {
  return {
    repoFullName: "acme/widgets",
    generatedAt: "2026-07-10T00:00:00.000Z",
    installation: null,
    sample: {
      authorLogin: "octocat",
      authorType: "User",
      authorAssociation: "NONE",
      minerStatus: "confirmed",
      title: "Add cursor pagination",
      labels: [],
      linkedIssues: [],
    },
    decision: {
      willComment: true,
      willLabel: true,
      willCheckRun: true,
      skipped: false,
      skipReason: null,
      actions: ["comment", "label", "check_run"],
      summary: "Would comment and label this PR.",
    },
    previewComment: "Thanks for the PR! A couple of notes...",
    appliedLabel: "gittensor:reviewed",
    checkRun: { willCreate: true, title: "LoopOver review", detailLevel: "full" },
    checkRunReadiness: null,
    installPreview: INSTALL_PREVIEW,
    warnings: [],
    summary: "Would comment and label this PR.",
    ...overrides,
  };
}

const REVIEWABILITY = [
  { pr: "acme/widgets#12", title: "Add cursor pagination", reason: "linked issue #7" },
];

describe("OnboardingPreviewCard", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    window.localStorage.clear();
  });

  it("auto-runs the demo against the most recent PR and shows flagged findings (comment+label+check-run)", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: preview() });
    render(<OnboardingPreviewCard reviewability={REVIEWABILITY} />);

    await waitFor(() => expect(screen.getByText("Would comment and label this PR.")).toBeTruthy());
    expect(screen.getByText("acme/widgets#12")).toBeTruthy();
    expect(screen.getByText("comment")).toBeTruthy();
    expect(screen.getByText("gittensor:reviewed")).toBeTruthy();

    // Real title + real linked-issue number scraped from `reason` reach the request.
    const [url, options] = apiFetch.mock.calls[0] as [string, { body: string; method: string }];
    expect(url).toContain("/v1/repos/acme/widgets/settings-preview");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body) as { sample: { title: string; linkedIssues: number[] } };
    expect(body.sample.title).toBe("Add cursor pagination");
    expect(body.sample.linkedIssues).toEqual([7]);
  });

  it("shows a clean/skip verdict for a PR the policy would not act on", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: preview({
        decision: {
          willComment: false,
          willLabel: false,
          willCheckRun: false,
          skipped: true,
          skipReason: "author is a trusted maintainer",
          actions: ["skip"],
          summary: "Nothing to flag on this PR.",
        },
        summary: "Nothing to flag on this PR.",
      }),
    });
    render(<OnboardingPreviewCard reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText("Nothing to flag on this PR.")).toBeTruthy());
    expect(screen.getByText("author is a trusted maintainer")).toBeTruthy();
  });

  it("renders an EmptyState when the repo has no recent pull requests, without calling the API", async () => {
    render(<OnboardingPreviewCard reviewability={[]} />);
    await waitFor(() => expect(screen.getByText(/No recent pull requests yet/i)).toBeTruthy());
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("renders an error state when the demo run fails", async () => {
    apiFetch.mockResolvedValue({ ok: false, message: "503 Service Unavailable" });
    render(<OnboardingPreviewCard reviewability={REVIEWABILITY} />);
    await waitFor(() =>
      expect(screen.getByText(/Couldn't run the onboarding preview/i)).toBeTruthy(),
    );
    expect(screen.getByText("503 Service Unavailable")).toBeTruthy();
  });

  it("dismisses the card and keeps it hidden (and skips the API call) across a remount", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: preview() });
    const { unmount } = render(<OnboardingPreviewCard reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText("Would comment and label this PR.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Dismiss onboarding preview" }));
    expect(screen.queryByText(/Here's what LoopOver would have flagged/)).toBeNull();

    apiFetch.mockClear();
    unmount();
    // render() flushes the synchronous hydration + load effects within its own act() wrapping (same
    // assumption ActivationPreview's tests already rely on for its own initial-load effect), so both of
    // these are safe to assert immediately rather than under waitFor.
    render(<OnboardingPreviewCard reviewability={REVIEWABILITY} />);
    expect(screen.queryByText(/Here's what LoopOver would have flagged/)).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
