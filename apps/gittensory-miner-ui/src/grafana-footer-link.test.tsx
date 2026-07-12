import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrafanaFooterLink } from "./components/grafana-footer-link";

afterEach(() => vi.unstubAllEnvs());

describe("GrafanaFooterLink (#5194)", () => {
  it("renders a footer with a new-tab link to the configured dashboard URL", () => {
    vi.stubEnv("VITE_MINER_UI_GRAFANA_URL", "https://grafana.example.internal/d/ams");
    render(<GrafanaFooterLink />);
    expect(screen.getByRole("contentinfo")).toBeTruthy(); // the <footer> itself
    const link = screen.getByRole("link", { name: /Grafana dashboard/i });
    expect(link.getAttribute("href")).toBe("https://grafana.example.internal/d/ams");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders NOTHING when unset/empty — no footer wrapper, not just no link", () => {
    vi.stubEnv("VITE_MINER_UI_GRAFANA_URL", "");
    const { container } = render(<GrafanaFooterLink />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull(); // no empty padded <footer> either
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("uses the URL verbatim as the href — never appends a token or credential", () => {
    const url = "https://dash.example.internal/grafana";
    vi.stubEnv("VITE_MINER_UI_GRAFANA_URL", url);
    render(<GrafanaFooterLink />);
    const href = screen.getByRole("link").getAttribute("href") ?? "";
    expect(href).toBe(url); // exact — no `?token=`, no appended session/credential
    expect(href).not.toMatch(/token|api[_-]?key|secret|session|auth=/i);
  });
});
