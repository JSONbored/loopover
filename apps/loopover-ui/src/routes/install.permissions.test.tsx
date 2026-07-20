import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

import { InstallPermissionsPage } from "./install.permissions";

// Scoped-permissions confirmation step (part of #4802). The page must present the real installation
// permission set (mirroring REQUIRED_INSTALLATION_PERMISSIONS / OPTIONAL_* in src/github/backfill.ts)
// so a customer sees exactly what they're granting before finishing the GitHub install.
describe("InstallPermissionsPage (#4802 confirm scoped permissions)", () => {
  it("presents the baseline (always-requested) scopes with their access levels", () => {
    render(<InstallPermissionsPage />);
    expect(screen.getByRole("heading", { name: /Exactly what you.re granting/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Metadata" })).toBeTruthy();
    // "Pull requests" appears in both baseline (read) and opt-in (write) groups.
    expect(screen.getAllByRole("heading", { name: "Pull requests" }).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getByRole("heading", { name: "Issues" })).toBeTruthy();
    // Access badges: at least one READ and one WRITE are rendered.
    expect(screen.getAllByText("Read").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Write").length).toBeGreaterThan(0);
  });

  it("presents the opt-in write scopes, each explaining what enables it", () => {
    render(<InstallPermissionsPage />);
    expect(screen.getByRole("heading", { name: "Checks" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Contents" })).toBeTruthy();
    // Every opt-in scope is gated on a setting, surfaced as an "Enabled when ..." note.
    expect(screen.getAllByText(/Enabled when/i).length).toBe(3);
  });

  it("lists the webhook events the installation subscribes to", () => {
    render(<InstallPermissionsPage />);
    for (const event of ["issues", "issue_comment", "pull_request", "repository"]) {
      expect(screen.getByText(event)).toBeTruthy();
    }
  });

  it("links back to the install setup steps and to privacy & security", () => {
    render(<InstallPermissionsPage />);
    expect(screen.getByRole("link", { name: /Back to setup steps/i }).getAttribute("href")).toBe(
      "/install",
    );
    expect(screen.getByRole("link", { name: /privacy & security/i }).getAttribute("href")).toBe(
      "/docs/privacy-security",
    );
  });
});
