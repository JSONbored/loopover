import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import { GateRampControl } from "@/components/site/app-panels/gate-ramp-control";

const REVIEWABILITY = [{ pr: "acme/widgets#1" }];

const ADVISORY_SETTINGS = {
  commentMode: "detected_contributors_only" as const,
  publicAudienceMode: "oss_maintainer" as const,
  publicSignalLevel: "standard" as const,
  publicSurface: "comment_and_label" as const,
  checkRunMode: "enabled" as const,
  checkRunDetailLevel: "standard" as const,
  reviewCheckMode: "required" as const,
  gatePack: "gittensor" as const,
  linkedIssueGateMode: "advisory" as const,
  duplicatePrGateMode: "advisory" as const,
  qualityGateMode: "advisory" as const,
  qualityGateMinScore: null,
  mergeReadinessGateMode: "off" as const,
  manifestPolicyGateMode: "off" as const,
  firstTimeContributorGrace: false,
  slopGateMode: "off" as const,
  slopGateMinScore: null,
  slopAiAdvisory: false,
  autoLabelEnabled: true,
  gittensorLabel: "gittensor",
  createMissingLabel: true,
  includeMaintainerAuthors: false,
  requireLinkedIssue: false,
  badgeEnabled: false,
  publicQualityMetrics: false,
  commandAuthorization: {},
  autonomy: {},
  autoMaintain: { requireApprovals: 1, mergeMethod: "squash" as const },
  agentPaused: false,
  agentDryRun: false,
};

const BLOCKING_SETTINGS = {
  ...ADVISORY_SETTINGS,
  linkedIssueGateMode: "block" as const,
  duplicatePrGateMode: "block" as const,
  qualityGateMode: "block" as const,
};

describe("GateRampControl (#2218)", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("loads settings and shows advisory phase with ramp switch off", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: ADVISORY_SETTINGS });
    render(<GateRampControl reviewability={REVIEWABILITY} />);

    await waitFor(() => expect(screen.getByText(/Advisory/i)).toBeTruthy());
    const rampSwitch = screen.getByRole("switch", { name: /blocking enforcement/i });
    expect(rampSwitch.getAttribute("aria-checked")).toBe("false");
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/repos/acme/widgets/settings"),
      expect.objectContaining({ label: "Repository settings" }),
    );
  });

  it("opens confirm on switch, saves blocking ramp on confirm, and toasts success", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: ADVISORY_SETTINGS });
    render(<GateRampControl reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());

    apiFetch.mockResolvedValueOnce({ ok: true, data: BLOCKING_SETTINGS });
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText(/Enable blocking gate rules/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Enable blocking$/i }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Blocking mode enabled",
        expect.objectContaining({
          description: expect.stringContaining("can now block merges"),
        }),
      ),
    );

    const putCall = apiFetch.mock.calls.find(
      ([, opts]) => (opts as { method?: string })?.method === "PUT",
    );
    expect(putCall?.[0]).toContain("/v1/repos/acme/widgets/settings");
    const body = JSON.parse(String((putCall?.[1] as { body?: string })?.body ?? "{}"));
    expect(body.linkedIssueGateMode).toBe("block");
    expect(body.duplicatePrGateMode).toBe("block");
    expect(body.qualityGateMode).toBe("block");
    expect(body.commentMode).toBe("detected_contributors_only");
  });

  it("closes confirm without saving when cancel is clicked", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: ADVISORY_SETTINGS });
    render(<GateRampControl reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());

    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText(/Enable blocking gate rules/i)).toBeNull());
    expect(
      apiFetch.mock.calls.filter(([, opts]) => (opts as { method?: string })?.method === "PUT"),
    ).toHaveLength(0);
  });

  it("toasts an error when the blocking ramp save fails", async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: ADVISORY_SETTINGS });
    render(<GateRampControl reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());

    fireEvent.click(screen.getByRole("switch"));
    apiFetch.mockResolvedValueOnce({ ok: false, message: "403 Forbidden" });
    fireEvent.click(screen.getByRole("button", { name: /^Enable blocking$/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Could not enable blocking",
        expect.objectContaining({ description: "403 Forbidden" }),
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("disables the switch when the gate is inactive (reviewCheckMode disabled)", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: { ...ADVISORY_SETTINGS, reviewCheckMode: "disabled" },
    });
    render(<GateRampControl reviewability={REVIEWABILITY} />);

    await waitFor(() => expect(screen.getByText(/Gate off/i)).toBeTruthy());
    expect(screen.getByRole("switch")).toHaveProperty("disabled", true);
  });

  it("shows blocking phase with switch on and disabled when already ramped", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: BLOCKING_SETTINGS });
    render(<GateRampControl reviewability={REVIEWABILITY} />);

    await waitFor(() => expect(screen.getByText(/Blocking/i)).toBeTruthy());
    const rampSwitch = screen.getByRole("switch");
    expect(rampSwitch.getAttribute("aria-checked")).toBe("true");
    expect(rampSwitch).toHaveProperty("disabled", true);
  });

  it("shows a no-repos hint and skips the load call when reviewability is empty", () => {
    render(<GateRampControl reviewability={[]} />);
    expect(screen.getByText(/Enter an installed repository to manage the gate ramp/i)).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("surfaces the load error via StateBoundary when the settings fetch fails", async () => {
    apiFetch.mockResolvedValue({ ok: false, message: "500 Internal Server Error" });
    render(<GateRampControl reviewability={REVIEWABILITY} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load repository settings/i)).toBeTruthy(),
    );
  });
});
