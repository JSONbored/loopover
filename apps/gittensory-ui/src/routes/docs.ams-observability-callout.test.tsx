import { render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  AMS_OBSERVABILITY_DOC_URL,
  AmsObservabilityCallout,
  MINER_USAGE_DASHBOARD_URL,
} from "../components/site/ams-observability-callout";
import { MinerQuickstart } from "./docs.miner-quickstart";
import { MinerWorkflow } from "./docs.miner-workflow";
import { SelfHostingOperations } from "./docs.self-hosting-operations";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  };
});

vi.mock("@/components/site/docs-page", () => ({
  DocsPage: ({ children }: { children: ReactNode }) => (
    <div data-testid="docs-page">{children}</div>
  ),
}));

vi.mock("@/components/site/primitives", () => ({
  Callout: ({ children, title }: { children: ReactNode; title?: string }) => (
    <section data-testid="callout">
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </section>
  ),
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
  FeatureRow: ({ items }: { items: Array<{ title: string; description: string }> }) => (
    <dl>
      {items.map((item) => (
        <div key={item.title}>
          <dt>{item.title}</dt>
          <dd>{item.description}</dd>
        </div>
      ))}
    </dl>
  ),
}));

vi.mock("@/components/site/workflow-mirror", () => ({
  WorkflowMirror: () => <div data-testid="workflow-mirror" />,
}));

// Each of the three routes the issue names (#5191). Kept as a table so the "renders the callout on every
// route" assertion can't silently skip one if a route is added/removed later.
const ROUTES: Array<[name: string, Component: () => ReactNode]> = [
  ["self-hosting operations", SelfHostingOperations],
  ["miner quickstart", MinerQuickstart],
  ["miner workflow", MinerWorkflow],
];

describe("AMS observability cross-reference callout", () => {
  it("renders both cross-links to the exported doc/dashboard targets (success path)", () => {
    render(<AmsObservabilityCallout />);

    expect(
      screen.getByRole("link", { name: /Observing your miner/i }).getAttribute("href"),
    ).toBe(AMS_OBSERVABILITY_DOC_URL);
    expect(
      screen.getByRole("link", { name: /miner-usage\.json dashboard/i }).getAttribute("href"),
    ).toBe(MINER_USAGE_DASHBOARD_URL);
  });

  it.each([
    ["AMS observability doc", AMS_OBSERVABILITY_DOC_URL],
    ["miner-usage dashboard", MINER_USAGE_DASHBOARD_URL],
  ])(
    "keeps the %s link a well-formed, non-empty absolute https URL (invariant)",
    (_label, url) => {
      expect(url.trim().length).toBeGreaterThan(0);
      expect(() => new URL(url)).not.toThrow();
      expect(new URL(url).protocol).toBe("https:");
    },
  );

  it.each(ROUTES)("adds the AMS observability callout to the %s route", (_name, Component) => {
    render(<Component />);

    expect(
      screen.getByRole("link", { name: /Observing your miner/i }).getAttribute("href"),
    ).toBe(AMS_OBSERVABILITY_DOC_URL);
    expect(
      screen.getByRole("link", { name: /miner-usage\.json dashboard/i }).getAttribute("href"),
    ).toBe(MINER_USAGE_DASHBOARD_URL);
  });
});
