import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePortfolioQueueCaps } from "../../packages/gittensory-miner/lib/portfolio-queue-caps.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolvePortfolioQueueCaps (#4850)", () => {
  it("defaults to global/per-repo cap of 1", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-queue-caps-"));
    roots.push(root);
    expect(
      resolvePortfolioQueueCaps({
        env: { GITTENSORY_MINER_CONFIG_DIR: root } as NodeJS.ProcessEnv,
      }),
    ).toEqual({ globalWipCap: 1, perRepoWipCap: 1 });
  });

  it("reads portfolioQueue caps from .gittensory-miner.yml in the state dir", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-queue-caps-"));
    roots.push(root);
    writeFileSync(
      join(root, ".gittensory-miner.yml"),
      "portfolioQueue:\n  globalWipCap: 4\n  perRepoWipCap: 2\n",
      "utf8",
    );
    expect(
      resolvePortfolioQueueCaps({
        env: { GITTENSORY_MINER_CONFIG_DIR: root } as NodeJS.ProcessEnv,
      }),
    ).toEqual({ globalWipCap: 4, perRepoWipCap: 2 });
  });

  it("env vars override config file and CLI flags override env", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-queue-caps-"));
    roots.push(root);
    writeFileSync(join(root, ".gittensory-miner.yml"), "portfolioQueue:\n  globalWipCap: 4\n", "utf8");
    const env = {
      GITTENSORY_MINER_CONFIG_DIR: root,
      GITTENSORY_MINER_GLOBAL_WIP_CAP: "3",
      GITTENSORY_MINER_PER_REPO_WIP_CAP: "2",
    } as NodeJS.ProcessEnv;
    expect(resolvePortfolioQueueCaps({ env })).toEqual({ globalWipCap: 3, perRepoWipCap: 2 });
    expect(
      resolvePortfolioQueueCaps({
        env,
        cliCaps: { globalWipCap: 5 },
      }),
    ).toEqual({ globalWipCap: 5, perRepoWipCap: 2 });
  });

  it("ignores invalid config content and falls back to defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-queue-caps-"));
    roots.push(root);
    writeFileSync(join(root, ".gittensory-miner.yml"), "not: [valid", "utf8");
    expect(
      resolvePortfolioQueueCaps({
        env: { GITTENSORY_MINER_CONFIG_DIR: root } as NodeJS.ProcessEnv,
      }),
    ).toEqual({ globalWipCap: 1, perRepoWipCap: 1 });
  });
});
