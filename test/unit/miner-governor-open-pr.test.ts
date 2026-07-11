import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { evaluateOpenPrSelfPlagiarism } from "../../packages/gittensory-miner/lib/governor-open-pr.js";
import { initGovernorLedger } from "../../packages/gittensory-miner/lib/governor-ledger.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("evaluateOpenPrSelfPlagiarism (#2345)", () => {
  it("records a throttled open_pr denial to the governor ledger with the matched prior submission", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-open-pr-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const shared = "shared diff fingerprint for throttle test";
    const { verdict, recorded } = evaluateOpenPrSelfPlagiarism(
      {
        candidate: {
          repoFullName: "acme/repo-b",
          fingerprint: shared,
          submittedAt: "2026-07-10T12:00:00.000Z",
          pullRequestNumber: 20,
        },
        recentOwnSubmissions: [
          {
            repoFullName: "acme/repo-a",
            fingerprint: shared,
            submittedAt: "2026-07-10T11:00:00.000Z",
            pullRequestNumber: 10,
          },
        ],
        selfPlagiarismConfig: { similarityThreshold: 0.85 },
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(verdict.allowed).toBe(false);
    expect(recorded.eventType).toBe("throttled");
    expect(recorded.actionClass).toBe("open_pr");
    expect(recorded.payload).toMatchObject({
      matchedRepoFullName: "acme/repo-a",
      matchedPullRequestNumber: 10,
    });
  });

  it("accepts a bare numeric selfPlagiarismConfig threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-governor-open-pr-num-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const shared = "numeric threshold config fingerprint";
    const { verdict } = evaluateOpenPrSelfPlagiarism(
      {
        candidate: {
          repoFullName: "acme/repo-b",
          fingerprint: shared,
          submittedAt: "2026-07-10T12:00:00.000Z",
          pullRequestNumber: 20,
        },
        recentOwnSubmissions: [
          {
            repoFullName: "acme/repo-a",
            fingerprint: shared,
            submittedAt: "2026-07-10T11:00:00.000Z",
            pullRequestNumber: 10,
          },
        ],
        selfPlagiarismConfig: 0.85,
      },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(verdict.eventType).toBe("throttled");
  });
});
