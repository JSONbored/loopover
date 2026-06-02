import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BETA_ONBOARDING_PATH = resolve(
  import.meta.dirname,
  "../../apps/gittensory-ui/src/routes/docs.beta-onboarding.tsx",
);

describe("docs beta onboarding page", () => {
  const source = readFileSync(BETA_ONBOARDING_PATH, "utf8");

  it("documents miner MCP flow through packet", () => {
    expect(source).toMatch(/gittensory-mcp login/);
    expect(source).toMatch(/gittensory-mcp doctor/);
    expect(source).toMatch(/agent plan/);
    expect(source).toMatch(/preflight/);
    expect(source).toMatch(/agent packet/);
  });

  it("documents maintainer GitHub App setup, preview, and commands", () => {
    expect(source).toMatch(/GitHub App/);
    expect(source).toMatch(/settings-preview/);
    expect(source).toMatch(/@gittensory help/);
    expect(source).toMatch(/@gittensory preflight/);
  });

  it("documents repo owner readiness and config guidance", () => {
    expect(source).toMatch(/registration-readiness/);
    expect(source).toMatch(/gittensor-config-recommendation/);
    expect(source).toMatch(/\/app\/owner/);
  });

  it("documents operator usage, value, and drift reporting", () => {
    expect(source).toMatch(/operator-dashboard/);
    expect(source).toMatch(/weekly value report/i);
    expect(source).toMatch(/upstream\/drift/);
  });

  it("positions Gittensory as independent control-plane, not official Gittensor frontend", () => {
    expect(source).toMatch(/official Gittensor product surface/i);
    expect(source).toMatch(/official Gittensor frontend/i);
    expect(source).toMatch(/independent of/i);
    expect(source).toMatch(/base-agent/i);
    expect(source).not.toMatch(/the official Gittensor frontend/i);
  });
});
