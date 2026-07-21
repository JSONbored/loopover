import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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
  currentReviewCheckMode: "disabled" as const,
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
    "LoopOver reviewed your 3 most recent pull request(s) and would have surfaced guidance on 2 of them.",
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

  it("wraps the sample table in a keyboard-focusable, labelled scroll region with a caption and column-scoped headers (#794 a11y pattern)", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: BASE_PREVIEW });
    render(<ActivationPreview reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText("Add cursor pagination")).toBeTruthy());
    const region = screen.getByRole("region", { name: "Advisory preview sample PRs" });
    // A bare overflow-hidden div is not a tab stop; TableScroll makes it one (WCAG 2.1.1).
    expect(region.tabIndex).toBe(0);
    expect(region.className).toContain("overflow-x-auto");
    const table = screen.getByRole("table", {
      name: "Sample pull requests with their title, severity, and finding count.",
    });
    expect(within(table).getByRole("columnheader", { name: "PR" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Findings" })).toBeTruthy();
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

  it("shows informational (non-actionable) status instead of an activation button when not yet enabled (#6444)", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: BASE_PREVIEW });
    render(<ActivationPreview reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText(BASE_PREVIEW.summary)).toBeTruthy());

    expect(screen.queryByRole("button", { name: /enable advisory mode/i })).toBeNull();
    expect(screen.getByText(/Not yet enabled/i)).toBeTruthy();
    expect(document.body.textContent).toContain("gate.checkMode: required");
  });

  it("falls back to a manual owner/repo entry when no repos are registered yet", () => {
    render(<ActivationPreview reviewability={[]} />);
    expect(screen.getByText(/No registered repositories detected yet/i)).toBeTruthy();
    expect(screen.getByText(/Enter an installed repository to preview activation\./i)).toBeTruthy();
  });

  it("renders its generatedAt timestamp once the preview loads (#6174)", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: BASE_PREVIEW });
    render(<ActivationPreview reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText(BASE_PREVIEW.summary)).toBeTruthy());
    expect(screen.getByText("generated 05 Jul 2026 00:00")).toBeTruthy();
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

  it("ignores a stale earlier response that resolves after a newer repo was typed (#7784)", async () => {
    // Per-repo deferred responses keyed off the request URL, so we can resolve them out of order: the FIRST
    // repo's (slow) request is resolved LAST, after the SECOND repo's request already landed. The stale first
    // response must not overwrite the second repo's rendered preview.
    const resolvers: Record<string, (value: unknown) => void> = {};
    apiFetch.mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          const repo = url.includes("/acme/first/")
            ? "first"
            : url.includes("/acme/second/")
              ? "second"
              : "other";
          resolvers[repo] = resolve;
        }),
    );
    render(<ActivationPreview reviewability={[{ pr: "acme/first#1" }]} />);

    // Type the first repo (its request is now pending, unresolved).
    fireEvent.change(screen.getByPlaceholderText("owner/repo"), {
      target: { value: "acme/first" },
    });
    await waitFor(() => expect(resolvers.first).toBeTruthy());

    // Type a second repo before the first resolves; its request is pending too.
    fireEvent.change(screen.getByPlaceholderText("owner/repo"), {
      target: { value: "acme/second" },
    });
    await waitFor(() => expect(resolvers.second).toBeTruthy());

    // The SECOND (newest) request resolves first with the second repo's summary.
    resolvers.second({
      ok: true,
      data: { ...BASE_PREVIEW, repoFullName: "acme/second", summary: "SECOND repo summary." },
    });
    await waitFor(() => expect(screen.getByText("SECOND repo summary.")).toBeTruthy());

    // Now the STALE first request finally resolves. The cancelled-flag guard must drop it so the second repo's
    // preview stays on screen rather than being clobbered by the first repo's now-outdated data.
    resolvers.first({
      ok: true,
      data: { ...BASE_PREVIEW, repoFullName: "acme/first", summary: "FIRST repo summary (stale)." },
    });
    await Promise.resolve();
    await waitFor(() => expect(screen.getByText("SECOND repo summary.")).toBeTruthy());
    expect(screen.queryByText("FIRST repo summary (stale).")).toBeNull();
  });
});
