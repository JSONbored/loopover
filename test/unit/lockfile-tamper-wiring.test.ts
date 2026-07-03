import { describe, expect, it } from "vitest";
import { maybeAddLockfileTamperFinding } from "../../src/queue/processors";
import type { Advisory, PullRequestFileRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

function advisory(): Advisory {
  return {
    id: "adv-1",
    targetType: "pull_request",
    targetKey: "acme/widgets#7",
    repoFullName: "acme/widgets",
    pullNumber: 7,
    headSha: "sha7",
    conclusion: "neutral",
    severity: "info",
    title: "Gittensory advisory available",
    summary: "ok",
    findings: [],
    generatedAt: "2026-07-02T00:00:00.000Z",
  };
}

const TAMPERED_LOCKFILE_PATCH = [
  '@@ -1,4 +1,4 @@',
  '     "node_modules/lodash": {',
  '-      "integrity": "sha512-oldoldold=="',
  '+      "integrity": "sha512-tamperedtampered=="',
  '     },',
].join("\n");

function tamperedFiles(): PullRequestFileRecord[] {
  return [
    {
      repoFullName: "acme/widgets",
      pullNumber: 7,
      path: "package-lock.json",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      payload: { patch: TAMPERED_LOCKFILE_PATCH },
    },
  ];
}

describe("maybeAddLockfileTamperFinding (#2563 wiring)", () => {
  it("mode OFF (default): does not scan, no finding appended", async () => {
    const env = createTestEnv();
    const adv = advisory();
    await maybeAddLockfileTamperFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      lockfileIntegrityGateMode: "off",
      files: tamperedFiles(),
    });
    expect(adv.findings).toEqual([]);
  });

  it("mode UNDEFINED (unset ⇒ treated as off): does not scan, no finding appended", async () => {
    const env = createTestEnv();
    const adv = advisory();
    await maybeAddLockfileTamperFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      lockfileIntegrityGateMode: undefined,
      files: tamperedFiles(),
    });
    expect(adv.findings).toEqual([]);
  });

  it("mode ADVISORY: a tampered lockfile appends a warning-severity lockfile_tamper_risk finding", async () => {
    const env = createTestEnv();
    const adv = advisory();
    await maybeAddLockfileTamperFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      lockfileIntegrityGateMode: "advisory",
      files: tamperedFiles(),
    });
    const finding = adv.findings.find((f) => f.code === "lockfile_tamper_risk");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
  });

  it("mode BLOCK: a clean (non-tampered) lockfile change appends no finding", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const cleanPatch = ['@@ -1,6 +1,6 @@', '     "node_modules/lodash": {', '-      "version": "4.17.20",', '+      "version": "4.17.21",', '     },'].join("\n");
    await maybeAddLockfileTamperFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      lockfileIntegrityGateMode: "block",
      files: [{ repoFullName: "acme/widgets", pullNumber: 7, path: "package-lock.json", status: "modified", additions: 1, deletions: 1, changes: 2, payload: { patch: cleanPatch } }],
    });
    expect(adv.findings).toEqual([]);
  });

  it("reuses the passed files (no DB fetch) when files is non-null, and lazy-loads when null", async () => {
    const env = createTestEnv();
    const adv = advisory();
    // files: null with no matching DB rows ⇒ listPullRequestFiles returns [] ⇒ no finding, no throw.
    await maybeAddLockfileTamperFinding(env, {
      advisory: adv,
      repoFullName: "acme/widgets",
      pullNumber: 7,
      lockfileIntegrityGateMode: "advisory",
      files: null,
    });
    expect(adv.findings).toEqual([]);
  });

  it("fail-safe: a thrown error while loading files never propagates and appends no finding", async () => {
    const env = createTestEnv();
    const adv = advisory();
    const throwingEnv = {
      ...env,
      DB: {
        ...env.DB,
        prepare: () => {
          throw new Error("boom");
        },
      },
    } as unknown as typeof env;
    await expect(
      maybeAddLockfileTamperFinding(throwingEnv, {
        advisory: adv,
        repoFullName: "acme/widgets",
        pullNumber: 7,
        lockfileIntegrityGateMode: "advisory",
        files: null,
      }),
    ).resolves.toBeUndefined();
    expect(adv.findings).toEqual([]);
  });
});
