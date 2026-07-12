import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API layer so the component never touches the network.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import { ActivationPreview } from "@/components/site/app-panels/activation-preview";

const REVIEWABILITY = [{ pr: "acme/widgets#1" }];

const BASE_PREVIEW = {
  repoFullName: "acme/widgets",
  generatedAt: "2026-07-05T00:00:00.000Z",
  currentGateMode: "off" as const,
  aiReviewConfigured: false,
  evaluatedCount: 3,
  withFindingsCount: 2,
  findingCodeCounts: [{ code: "missing_tests", count: 2 }],
  samples: [
    {
      number: 12,
      title: "Add cursor pagination",
      severity: "warning" as const,
      findingCount: 1,
      findings: [],
    },
    {
      number: 11,
      title: "Fix flaky test",
      severity: "info" as const,
      findingCount: 0,
      findings: [],
    },
  ],
  recommendedAction: "enable_advisory" as const,
  summary:
    "Gittensory reviewed your 3 most recent pull request(s) and would have surfaced guidance on 2 of them.",
};

describe("ActivationPreview", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("shows a loading state, then renders the real preview data on load", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: BASE_PREVIEW });
    render(<ActivationPreview reviewability={REVIEWABILITY} />);

    expect(screen.getByText(/Building activation preview/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(BASE_PREVIEW.summary)).toBeTruthy());
    expect(screen.getByText("Add cursor pagination")).toBeTruthy();
    expect(screen.getByText("missing_tests × 2")).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/repos/acme/widgets/activation-preview"),
      expect.objectContaining({ label: "Activation preview" }),
    );
  });

  it("renders an error state with the failure message when the preview fails to load", async () => {
    apiFetch.mockResolvedValue({ ok: false, message: "503 Service Unavailable" });
    render(<ActivationPreview reviewability={REVIEWABILITY} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load the activation preview/i)).toBeTruthy(),
    );
    expect(screen.getByText("503 Service Unavailable")).toBeTruthy();
  });

  it("renders an empty state when zero pull requests have been evaluated", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...BASE_PREVIEW,
        evaluatedCount: 0,
        withFindingsCount: 0,
        samples: [],
        findingCodeCounts: [],
        recommendedAction: null,
      },
    });
    render(<ActivationPreview reviewability={REVIEWABILITY} />);

    await waitFor(() => expect(screen.getByText(/No recent pull requests yet/i)).toBeTruthy());
  });

  it("shows the enable-advisory action, posts activation, and reflects the enabled state after the round-trip", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: BASE_PREVIEW });
    render(<ActivationPreview reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText(BASE_PREVIEW.summary)).toBeTruthy());

    const activateButton = screen.getByRole("button", { name: /enable advisory mode/i });

    apiFetch.mockResolvedValueOnce({
      ok: true,
      data: {
        repoFullName: "acme/widgets",
        reviewCheckMode: "required",
        checkRunMode: "enabled",
        linkedIssueGateMode: "advisory",
        duplicatePrGateMode: "advisory",
        qualityGateMode: "advisory",
      },
    });
    // Reload after activation reports the gate is now on — the button should disappear.
    apiFetch.mockResolvedValueOnce({
      ok: true,
      data: { ...BASE_PREVIEW, currentGateMode: "enabled", recommendedAction: null },
    });

    fireEvent.click(activateButton);

    await waitFor(() =>
      expect(
        screen.getByText(/Advisory mode enabled\. Gittensory will now surface guidance/i),
      ).toBeTruthy(),
    );
    await waitFor(() => expect(screen.getByText(/Advisory mode is already enabled/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /enable advisory mode/i })).toBeNull();

    const postCall = apiFetch.mock.calls.find(
      ([, opts]) => (opts as { method?: string })?.method === "POST",
    );
    expect(postCall?.[0]).toContain("/v1/repos/acme/widgets/activation");
  });

  it("surfaces the error message inline when activation fails, without touching the preview data", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: BASE_PREVIEW });
    render(<ActivationPreview reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText(BASE_PREVIEW.summary)).toBeTruthy());

    apiFetch.mockResolvedValueOnce({ ok: false, message: "403 Forbidden" });

    fireEvent.click(screen.getByRole("button", { name: /enable advisory mode/i }));

    await waitFor(() => expect(screen.getByText("403 Forbidden")).toBeTruthy());
    // Still showing the previously-loaded preview, unchanged.
    expect(screen.getByText(BASE_PREVIEW.summary)).toBeTruthy();
  });

  it("falls back to a manual owner/repo entry when no repos are registered yet", () => {
    render(<ActivationPreview reviewability={[]} />);
    expect(screen.getByText(/No registered repositories detected yet/i)).toBeTruthy();
    expect(screen.getByText(/Enter an installed repository to preview activation\./i)).toBeTruthy();
  });

  it("shows the 'settings unavailable' copy for a typed repo string that doesn't parse as owner\\/repo", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: BASE_PREVIEW });
    render(<ActivationPreview reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText(BASE_PREVIEW.summary)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("owner/repo"), {
      target: { value: "not-a-valid-slug" },
    });
    expect(screen.getByText(/Settings are unavailable for this repository\./i)).toBeTruthy();
  });
});
