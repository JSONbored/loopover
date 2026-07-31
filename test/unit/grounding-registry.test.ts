import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GROUNDING_TOOLS,
  groundingToolCatalog,
  runGroundingTool,
  stableStrings,
  type GroundingServices,
} from "../../src/chat/grounding-registry";

// #9189: the read-only grounding registry.
//
// The issue's own bar is that authz and redaction are "guaranteed by tests rather than convention", so the
// four invariants below are the point of this file — the happy paths are almost incidental by comparison:
//
//   • READ-ONLY, by construction. The tools' entire capability surface is GroundingServices, which holds no
//     Octokit, no token and no mutation. A tool cannot write because there is nothing to write with.
//   • REDACTION, structural. Responses are built by naming fields, so a field nobody wrote down cannot leak
//     — including when an upstream type grows one.
//   • DETERMINISM. Identical state must produce identical BYTES, or a retry re-grounds the model differently.
//   • BUDGETS. Declared per tool and carried on the result.

const services = (over: Partial<GroundingServices> = {}): GroundingServices => ({
  queueSnapshot: async () => ({ pending: 3, processing: 1 }),
  ledgerVerify: async () => ({ ok: true, tipSeq: 128, totalCount: 128 }),
  proofSummary: async () => ({
    decisionCount: 128,
    accuracy: { state: "published", accuracy: 0.964, decided: 112, confirmed: 108, interval: { lo: 0.912, hi: 0.987 } },
    ledgerState: "verified",
    anchorState: "anchored",
  }),
  effectiveConfig: async () => ({ present: true, source: "repo_file", fields: ["wantedPaths", "gate", "settings"] }),
  repoSettings: async () => ({ gatePack: "standard", autonomy: { merge: "auto", close: "observe" } }),
  prStatus: async () => ({ pullNumber: 42, action: "hold", reasonCode: "success", holdCause: ["screenshotEvidenceHold", "guardrailHit"], ciState: "passed", recordDigest: "d".repeat(64) }),
  ...over,
});

describe("read-only is enforced by construction (#9189 requirement 4)", () => {
  it("INVARIANT: the services surface exposes no write capability at all", () => {
    // Asserted over the SOURCE of the type, not a runtime object: the guarantee is that nothing
    // write-capable is in scope for a tool, and that is a property of the interface declaration.
    const source = readFileSync("src/chat/grounding-registry.ts", "utf8");
    const surface = source.slice(source.indexOf("export type GroundingServices"), source.indexOf("/** The subset of the proof summary"));
    for (const forbidden of ["Octokit", "octokit", "token", "Token", "write", "mutate", "createComment", "merge(", "close("]) {
      expect(surface, `GroundingServices must not expose ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("INVARIANT: no tool reaches for a capability outside the injected services", () => {
    // A tool that imported an Octokit directly would bypass the surface above entirely. The registry module
    // must therefore import nothing that can talk to GitHub.
    const source = readFileSync("src/chat/grounding-registry.ts", "utf8");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports, "the registry must stay dependency-free so its capability surface is the injected one").toEqual([]);
  });

  it("runs every tool with a services object holding only readers, and none throws", async () => {
    for (const tool of GROUNDING_TOOLS) {
      await expect(runGroundingTool(tool.name, services(), "acme/widgets", 42), tool.name).resolves.toBeTruthy();
    }
  });
});

describe("redaction is structural (#9189 requirement 3)", () => {
  it("INVARIANT: an upstream object that grows a secret field cannot leak it", () => {
    // The test that distinguishes an allowlist from a blocklist. Every service below returns a payload
    // carrying fields no response shape names; if the tools copied objects wholesale, these would appear.
    const poisoned = services({
      queueSnapshot: async () => ({ pending: 1, processing: 0, walletAddress: "0xdead", hotkey: "5Fxx" }) as never,
      repoSettings: async () => ({ gatePack: "standard", autonomy: { merge: "auto" }, rewardValue: 42, trustScore: 0.9 }) as never,
      effectiveConfig: async () => ({ present: true, source: "repo_file", fields: ["gate"], privateRanking: [1, 2] }) as never,
      prStatus: async () => ({ pullNumber: 1, action: "hold", reasonCode: "x", holdCause: [], ciState: "passed", recordDigest: "d", authorEmail: "a@b.c" }) as never,
    });
    return Promise.all(
      GROUNDING_TOOLS.map(async (tool) => {
        const result = await runGroundingTool(tool.name, poisoned, "acme/widgets", 1);
        const serialized = JSON.stringify(result);
        for (const secret of ["walletAddress", "0xdead", "hotkey", "5Fxx", "rewardValue", "trustScore", "privateRanking", "authorEmail", "a@b.c"]) {
          expect(serialized, `${tool.name} leaked ${secret}`).not.toContain(secret);
        }
      }),
    );
  });

  it("passes the accuracy union through WHOLE, so coverage and interval cannot be stripped", async () => {
    // Requirement 6. Flattening this to a bare number is the failure mode -- a percentage with no
    // denominator and no interval is marketing, and it is exactly what buildProofSummary refuses to publish.
    const result = await runGroundingTool("fairness_summary", services(), "acme/widgets");
    const accuracy = (result?.data as { accuracy: Record<string, unknown> }).accuracy;
    expect(accuracy).toMatchObject({ state: "published", decided: 112, confirmed: 108, interval: { lo: 0.912, hi: 0.987 } });
  });

  it("reports insufficient data as a state, never as a fabricated zero", async () => {
    const sparse = services({ proofSummary: async () => ({ decisionCount: 7, accuracy: { state: "insufficient_data", decided: 7, minimumDecisions: 20 }, ledgerState: "verified", anchorState: "not_yet_anchored" }) });
    const result = await runGroundingTool("fairness_summary", sparse, "acme/widgets");
    expect((result?.data as { accuracy: { state: string } }).accuracy.state).toBe("insufficient_data");
    expect(JSON.stringify(result)).not.toContain('"accuracy":0');
  });

  it("returns config field NAMES, never their values", async () => {
    const result = await runGroundingTool("effective_config", services(), "acme/widgets");
    expect((result?.data as { fields: string[] }).fields).toEqual(["gate", "settings", "wantedPaths"]);
  });
});

describe("determinism (#9189 requirement 5)", () => {
  it("INVARIANT: two identical calls produce identical bytes, for every tool", async () => {
    for (const tool of GROUNDING_TOOLS) {
      const first = JSON.stringify(await runGroundingTool(tool.name, services(), "acme/widgets", 42));
      const second = JSON.stringify(await runGroundingTool(tool.name, services(), "acme/widgets", 42));
      expect(second, tool.name).toBe(first);
    }
  });

  it("REGRESSION: query order does not change the bytes", async () => {
    // The real risk: a service returning the same set in a different order would otherwise re-ground the
    // model differently on a retry, and make any cache meaningless.
    const forward = services({ effectiveConfig: async () => ({ present: true, source: "repo_file", fields: ["gate", "settings", "wantedPaths"] }) });
    const reversed = services({ effectiveConfig: async () => ({ present: true, source: "repo_file", fields: ["wantedPaths", "settings", "gate"] }) });
    expect(JSON.stringify(await runGroundingTool("effective_config", reversed, "acme/widgets"))).toBe(
      JSON.stringify(await runGroundingTool("effective_config", forward, "acme/widgets")),
    );
  });

  it("sorts hold causes, so a reordered cause list grounds identically", async () => {
    const result = await runGroundingTool("pr_status", services(), "acme/widgets", 42);
    expect((result?.data as { holdCause: string[] }).holdCause).toEqual(["guardrailHit", "screenshotEvidenceHold"]);
  });

  it("advertises a stable catalog", () => {
    expect(groundingToolCatalog().map((tool) => tool.name)).toEqual([
      "effective_config",
      "fairness_summary",
      "ledger_verify",
      "pr_status",
      "queue_snapshot",
      "repo_settings",
    ]);
  });
});

describe("availability and budgets", () => {
  it("reports an absent source as unavailable, never as an error or a zero", async () => {
    // A deployment without a ledger is not a broken one. `available: false` stops the model narrating an
    // outage from a surface that simply is not present -- and an empty queue would read as "nothing to do".
    const absent = services({ ledgerVerify: async () => null, queueSnapshot: async () => null, proofSummary: async () => null });
    for (const name of ["ledger_verify", "queue_snapshot", "fairness_summary"]) {
      const result = await runGroundingTool(name, absent, "acme/widgets");
      expect(result?.data, name).toEqual({ available: false });
    }
  });

  it("requires a pull number where the tool declares it, rather than guessing one", async () => {
    const result = await runGroundingTool("pr_status", services(), "acme/widgets", null);
    expect(result?.data).toEqual({ available: false, reason: "pull_number_required" });
    expect(GROUNDING_TOOLS.find((tool) => tool.name === "pr_status")?.needsPullNumber).toBe(true);
  });

  it("carries each tool's declared budget on its result", async () => {
    for (const tool of GROUNDING_TOOLS) {
      const result = await runGroundingTool(tool.name, services(), "acme/widgets", 42);
      expect(result?.budgetTokens, tool.name).toBe(tool.budgetTokens);
      expect(tool.budgetTokens, tool.name).toBeGreaterThan(0);
    }
  });

  it("returns null for an unknown tool, leaving the status code to the caller", async () => {
    expect(await runGroundingTool("definitely_not_a_tool", services(), "acme/widgets")).toBeNull();
  });
});

describe("stableStrings", () => {
  it("sorts without mutating its input", () => {
    const input = ["b", "a"];
    expect(stableStrings(input)).toEqual(["a", "b"]);
    expect(input).toEqual(["b", "a"]);
  });
});
