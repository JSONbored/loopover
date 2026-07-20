import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

import { InstallPage } from "./install.index";

// Self-serve signup & App-install entry surface (part of #4802).
describe("InstallPage (#4802 self-serve install entry)", () => {
  it("presents the three self-serve steps: sign up, install, confirm permissions", () => {
    render(<InstallPage />);
    expect(
      screen.getByRole("heading", { name: /Connect your repository in three steps/i }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign up" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Install the App" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Confirm scoped permissions" })).toBeTruthy();
    // The steps are numbered 1..3 in order.
    ["Step 1", "Step 2", "Step 3"].forEach((label) => expect(screen.getByText(label)).toBeTruthy());
  });

  it("routes the install CTA to the real GitHub App configuration guide, not a fabricated live install", () => {
    render(<InstallPage />);
    const cta = screen.getByRole("link", { name: /Install on GitHub/i });
    // Deliberately the documented setup route -- hosted self-serve install is a follow-up, so this slice
    // must not pretend a one-click live install exists.
    expect(cta.getAttribute("href")).toBe("/docs/github-app");
  });

  it("surfaces the scoped-permissions guarantee with a link to privacy & security", () => {
    render(<InstallPage />);
    const callout = screen.getByText(/only the permissions review needs/i).closest("div");
    expect(callout).toBeTruthy();
    const privacyLink = screen.getByRole("link", { name: /privacy & security/i });
    expect(privacyLink.getAttribute("href")).toBe("/docs/privacy-security");
  });

  it("offers the onboarding guide as a secondary path", () => {
    render(<InstallPage />);
    const guide = screen.getByRole("link", { name: /Read the onboarding guide/i });
    expect(guide.getAttribute("href")).toBe("/docs/beta-onboarding");
  });
});
