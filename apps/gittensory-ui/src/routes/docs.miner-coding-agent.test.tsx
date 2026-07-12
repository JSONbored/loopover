import { render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { CODING_AGENT_DRIVER_NAMES } from "../../../../packages/gittensory-engine/src/miner/driver-factory";
import {
  MINER_CODING_AGENT_ENV_ROWS,
  MINER_CODING_AGENT_PROVIDER_ITEMS,
  MinerCodingAgentDriverDocs,
} from "./docs.miner-coding-agent";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  };
});

vi.mock("@/components/site/docs-page", () => ({
  DocsPage: ({
    children,
    title,
    eyebrow,
    description,
  }: {
    children: ReactNode;
    title: string;
    eyebrow?: string;
    description?: string;
  }) => (
    <div data-testid="docs-page">
      {eyebrow ? <div>{eyebrow}</div> : null}
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
      {children}
    </div>
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

describe("miner coding-agent docs page", () => {
  it("mounts the docs route and renders the expected sections", async () => {
    render(<MinerCodingAgentDriverDocs />);

    expect(await screen.findByRole("heading", { name: "Miner coding-agent driver" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Provider selection" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Model and timeout overrides" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Recognizing a stale or missing credential" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Related docs" })).toBeTruthy();
  });

  it("keeps the provider list aligned with the engine's accepted provider names", () => {
    expect(MINER_CODING_AGENT_PROVIDER_ITEMS.map((item) => item.title)).toEqual([
      ...CODING_AGENT_DRIVER_NAMES,
    ]);
  });

  it("documents every driver env var the page claims to cover", () => {
    expect(MINER_CODING_AGENT_ENV_ROWS.map((row) => row.name)).toEqual([
      "MINER_CODING_AGENT_PROVIDER",
      "MINER_CODING_AGENT_CLAUDE_MODEL",
      "MINER_CODING_AGENT_CODEX_MODEL",
      "MINER_CODING_AGENT_TIMEOUT_MS",
    ]);
  });

  it("exports the route component used by the route definition", () => {
    expect(typeof MinerCodingAgentDriverDocs).toBe("function");
  });
});
