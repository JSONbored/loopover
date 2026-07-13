import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFixtureServer,
  runAsync,
  startForgeFixture,
  tempEnvPrefix,
  type CliProcessResult,
} from "./support/miner-cli-harness";

const roots: string[] = [];

function isolatedMinerEnv(configDir: string): Record<string, string> {
  return {
    GITTENSORY_MINER_CONFIG_DIR: configDir,
    GITTENSORY_MINER_NO_UPDATE_CHECK: "1",
    GITHUB_TOKEN: "e2e-fixture-token",
  };
}

/** Discover exits cleanly on Linux CI but can trip a Windows libuv shutdown assertion after printing JSON. */
function expectCliSuccess(result: CliProcessResult) {
  if (result.status === 0) return;
  expect(result.stdout.trim().length).toBeGreaterThan(0);
  expect(result.stderr).not.toMatch(/Usage:|Unknown option|Unknown command/i);
}

afterEach(async () => {
  await closeFixtureServer();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner true CLI end-to-end flows (#4869)", () => {
  it("bootstraps local state and reports status + doctor through the real binary", async () => {
    const configDir = tempEnvPrefix();
    roots.push(configDir);
    const env = isolatedMinerEnv(configDir);

    const init = await runAsync(["init", "--json"], env);
    expect(init.status).toBe(0);
    const initPayload = JSON.parse(init.stdout);
    expect(initPayload.stateDir).toBe(configDir);

    const status = await runAsync(["status", "--json"], env);
    expect(status.status).toBe(0);
    const statusPayload = JSON.parse(status.stdout);
    expect(statusPayload.stateDir).toBe(configDir);
    expect(statusPayload.package.name).toBe("@jsonbored/gittensory-miner");

    const doctor = await runAsync(["doctor", "--json"], env);
    expect(doctor.status).toBe(0);
    const doctorPayload = JSON.parse(doctor.stdout);
    expect(doctorPayload.ok).toBe(true);
    expect(doctorPayload.checks.some((check: { name: string }) => check.name === "laptop-state-sqlite")).toBe(
      true,
    );
    expect(doctorPayload.checks.find((check: { name: string }) => check.name === "github-token")?.ok).toBe(true);
  });

  it("runs discover --dry-run against a local forge fixture via the real binary", async () => {
    const configDir = tempEnvPrefix();
    roots.push(configDir);
    const forgeUrl = await startForgeFixture([
      {
        owner: "acme",
        repo: "widgets",
        issues: [
          {
            number: 7,
            title: "Add queue retry helper",
            labels: [{ name: "help wanted" }],
            comments: 1,
            created_at: "2026-07-09T10:00:00.000Z",
            updated_at: "2026-07-09T10:00:00.000Z",
            html_url: "https://github.com/acme/widgets/issues/7",
          },
        ],
      },
    ]);

    const discover = await runAsync(
      ["discover", "acme/widgets", "--dry-run", "--json", "--api-base-url", forgeUrl],
      isolatedMinerEnv(configDir),
    );

    expectCliSuccess(discover);
    const payload = JSON.parse(discover.stdout);
    expect(payload.outcome).toBe("dry_run");
    expect(payload.fanOutCount).toBe(1);
    expect(payload.ranked[0]?.repoFullName).toBe("acme/widgets");
    expect(payload.ranked[0]?.issueNumber).toBe(7);
    expect(payload.enqueueSummary.enqueued).toBe(1);
  });

  it("discovers, enqueues, and inspects the portfolio queue through the real binary", async () => {
    const configDir = tempEnvPrefix();
    roots.push(configDir);
    const env = isolatedMinerEnv(configDir);

    const init = await runAsync(["init", "--json"], env);
    expect(init.status).toBe(0);

    const forgeUrl = await startForgeFixture([
      {
        owner: "acme",
        repo: "widgets",
        issues: [
          {
            number: 11,
            title: "Improve discover ranking",
            labels: [{ name: "help wanted" }],
            comments: 0,
            created_at: "2026-07-09T11:00:00.000Z",
            updated_at: "2026-07-09T11:00:00.000Z",
            html_url: "https://github.com/acme/widgets/issues/11",
          },
        ],
      },
    ]);

    const discover = await runAsync(
      ["discover", "acme/widgets", "--json", "--api-base-url", forgeUrl],
      env,
    );
    expectCliSuccess(discover);
    const discoverPayload = JSON.parse(discover.stdout);
    expect(discoverPayload.enqueueSummary.enqueued).toBe(1);

    const list = await runAsync(["queue", "list", "--json"], env);
    expect(list.status).toBe(0);
    const listPayload = JSON.parse(list.stdout);
    expect(listPayload.entries).toHaveLength(1);
    expect(listPayload.entries[0]).toMatchObject({
      repoFullName: "acme/widgets",
      identifier: "issue:11",
      status: "queued",
    });

    const next = await runAsync(["queue", "next", "--dry-run", "--json"], env);
    expect(next.status).toBe(0);
    expect(JSON.parse(next.stdout)).toEqual({ outcome: "dry_run" });
  });

  it("runs discover --search --dry-run through the real binary", async () => {
    const configDir = tempEnvPrefix();
    roots.push(configDir);
    const forgeUrl = await startForgeFixture([
      {
        owner: "acme",
        repo: "widgets",
        issues: [
          {
            number: 21,
            title: "Search-mode candidate",
            labels: [{ name: "bug" }],
            comments: 2,
            created_at: "2026-07-08T00:00:00.000Z",
            updated_at: "2026-07-08T01:00:00.000Z",
            html_url: "https://github.com/acme/widgets/issues/21",
          },
        ],
      },
    ]);

    const discover = await runAsync(
      [
        "discover",
        "--search",
        "label:bug",
        "--dry-run",
        "--json",
        "--api-base-url",
        forgeUrl,
      ],
      isolatedMinerEnv(configDir),
    );

    expectCliSuccess(discover);
    const payload = JSON.parse(discover.stdout);
    expect(payload.outcome).toBe("dry_run");
    expect(payload.ranked[0]?.issueNumber).toBe(21);
    expect(payload.ranked[0]?.title).toContain("Search-mode candidate");
  });
});
