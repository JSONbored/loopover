import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #6985: a real fetch failure used to render the same generic text as "still loading" — these tests
// pin the three render paths (loading / error / success) now that LoadingState/ErrorState replace it.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));

import { NotificationReadinessCard } from "./notification-readiness-card";

const notificationModelFixture = {
  notificationModel: {
    mode: "opt_in",
    defaultState: "disabled",
    channels: [
      {
        id: "browser_push",
        transport: "web_push",
        defaultEnabled: false,
        purpose: "PR review updates",
      },
    ],
    privacyGuards: ["No content leaves the browser without consent."],
    fallbackWhenUnavailable: "email digest",
  },
  pwa: { nativeDependency: false, manifestPath: "/manifest.json", serviceWorkerPath: "/sw.js" },
  mobileReadyRoutes: [],
  nativeMobileFuture: [],
};

describe("NotificationReadinessCard loading/error states (#6985)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows a LoadingState (not the generic spinner-free text) while the model loads", () => {
    useApiResource.mockReturnValue({
      status: "loading",
      data: null,
      error: null,
      loadedAt: null,
      reload: () => {},
    });

    render(<NotificationReadinessCard />);

    expect(screen.getByText("Loading notification model…")).toBeTruthy();
    expect(screen.queryByText("Notification model unavailable.")).toBeNull();
  });

  it("shows an ErrorState with the real error message and a working retry, distinguishing it from loading", () => {
    const reload = vi.fn();
    useApiResource.mockReturnValue({
      status: "error",
      data: null,
      error: "The server returned a 500.",
      errorKind: "http",
      loadedAt: null,
      reload,
    });

    render(<NotificationReadinessCard />);

    expect(screen.getByText("The server returned a 500.")).toBeTruthy();
    expect(screen.queryByText("Loading notification model…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("renders the network-specific ErrorState copy when errorKind indicates an unreachable server", () => {
    useApiResource.mockReturnValue({
      status: "error",
      data: null,
      error: "Failed to fetch",
      errorKind: "network",
      loadedAt: null,
      reload: () => {},
    });

    render(<NotificationReadinessCard />);

    expect(screen.getByText("Can't reach the server")).toBeTruthy();
  });

  it("still renders the privacy guards list unchanged on success", () => {
    useApiResource.mockReturnValue({
      status: "ready",
      data: notificationModelFixture,
      error: null,
      loadedAt: Date.now(),
      reload: () => {},
    });

    const { container } = render(<NotificationReadinessCard />);

    expect(container.textContent).toContain("No content leaves the browser without consent.");
    expect(screen.queryByText("Loading notification model…")).toBeNull();
  });

  it("migrates a pre-rebrand gittensory_ opt-in flag so the pill shows enabled (#7782)", async () => {
    window.localStorage.setItem("gittensory_notification_opt_in", JSON.stringify(true));
    useApiResource.mockReturnValue({
      status: "ready",
      data: notificationModelFixture,
      error: null,
      loadedAt: Date.now(),
      reload: () => {},
    });

    render(<NotificationReadinessCard />);
    await waitFor(() => expect(screen.getByText("opt-in enabled")).toBeTruthy());
    expect(window.localStorage.getItem("loopover_notification_opt_in")).toBe(JSON.stringify(true));
    expect(screen.queryByText("opt-in required")).toBeNull();
  });
});
