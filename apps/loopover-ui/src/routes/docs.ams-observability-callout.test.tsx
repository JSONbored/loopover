import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

import {
  AMS_OBSERVABILITY_DOC_URL,
  AmsObservabilityCallout,
} from "../components/site/ams-observability-callout";

// Every route that embeds the shared callout, so a new route add/remove can't silently skip one (#5191).
// These routes render from content/docs/*.mdx via the fumadocs client-loader (see
// docs-source.server.ts's comment), so this is now a content drift-guard -- checking the .mdx source
// for the JSX tag -- rather
// than a component render, matching the pattern in docs-selfhost-activation-paths.test.ts.
const ROUTES_WITH_CALLOUT = [
  ["/docs/self-hosting-operations", "content/docs/self-hosting-operations.mdx"],
  ["/docs/miner-quickstart", "content/docs/miner-quickstart.mdx"],
  ["/docs/miner-workflow", "content/docs/miner-workflow.mdx"],
] as const;

describe("AMS observability cross-reference callout", () => {
  it("renders a link to the Observing your miner guide", () => {
    render(<AmsObservabilityCallout />);
    const link = screen.getByRole("link", { name: "Observing your miner" });
    expect(link.getAttribute("href")).toBe(AMS_OBSERVABILITY_DOC_URL);
  });

  it("targets a well-formed, non-empty in-app docs path (guards against a blank/copy-paste link)", () => {
    expect(AMS_OBSERVABILITY_DOC_URL).toBeTruthy();
    expect(AMS_OBSERVABILITY_DOC_URL.startsWith("/docs/")).toBe(true);
  });

  it.each(ROUTES_WITH_CALLOUT)("wires the callout into %s", (_path, docPath) => {
    const source = readFileSync(docPath, "utf8");
    expect(source).toContain("<AmsObservabilityCallout");
  });
});
