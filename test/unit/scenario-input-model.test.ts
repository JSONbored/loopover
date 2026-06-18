import { describe, expect, it } from "vitest";
import {
  SCENARIO_MAX_BRANCH_REF_CHARS,
  SCENARIO_MAX_LINKED_ISSUE_NUMBERS,
  SCENARIO_MAX_REPO_FULL_NAME_CHARS,
  SCENARIO_MAX_SIGNAL_DETAIL_CHARS,
  assertScenarioLocalBranchInputSafe,
  buildScenarioInput,
  createScenarioSignalEntry,
  normalizeScenarioInput,
  parseAgentScenarioInput,
  scenarioInputFromLocalBranchMetadata,
  serializeScenarioInputPrivate,
  serializeScenarioInputPublic,
} from "../../src/scenarios/input-model";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward[-\s]?estimate|farming|raw trust|trust[-\s]?score|scoreability|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)/i;

function completeInput() {
  return buildScenarioInput({
    scenarioType: "branch_preflight",
    repoFullName: "octo/demo",
    facts: [
      createScenarioSignalEntry({
        id: "queue",
        kind: "fact",
        label: "Queue",
        detail: "Repo has two open PRs in cached metadata.",
        source: "github_observed",
      }),
    ],
    assumptions: [
      createScenarioSignalEntry({
        id: "pending",
        kind: "assumption",
        label: "Pending merges",
        detail: "Caller assumes one approved PR will land soon.",
        source: "user_supplied",
      }),
    ],
    estimates: [
      createScenarioSignalEntry({
        id: "pressure",
        kind: "estimate",
        label: "Queue pressure",
        detail: "Opening another PR would add moderate review load.",
        source: "gittensory_projection",
      }),
    ],
    unavailableSignals: [
      createScenarioSignalEntry({
        id: "official_stats",
        kind: "unavailable",
        label: "Official stats",
        detail: "Contributor official stats are not available in cache.",
        source: "missing",
      }),
    ],
  });
}

describe("agent scenario input model", () => {
  it("parses complete, partial, and unavailable-signal inputs", () => {
    const complete = completeInput();
    expect(complete.facts[0]?.kind).toBe("fact");
    expect(complete.assumptions[0]?.kind).toBe("assumption");
    expect(complete.estimates[0]?.kind).toBe("estimate");
    expect(complete.unavailableSignals[0]?.kind).toBe("unavailable");
    expect(complete.advisoryOnly).toBe(true);
    expect(complete.notAutonomousPrBot).toBe(true);
    expect(complete.notPublicScoring).toBe(true);

    const partial = buildScenarioInput({
      scenarioType: "general_repo",
      repoFullName: "octo/demo",
      facts: [
        createScenarioSignalEntry({
          id: "repo_only",
          kind: "fact",
          label: "Repo only",
          detail: "Only repo context is known.",
          source: "registry",
        }),
      ],
    });
    expect(partial.assumptions).toEqual([]);
    expect(partial.unavailableSignals).toEqual([]);
  });

  it("rejects invalid schema payloads", () => {
    expect(() => parseAgentScenarioInput({ version: 2 })).toThrow();
    expect(() => parseAgentScenarioInput({ version: 1, scenarioType: "not_real", repo: { repoFullName: "octo/demo" } })).toThrow();
  });

  it("rejects bucket/kind mismatches deterministically", () => {
    expect(() =>
      parseAgentScenarioInput({
        ...completeInput(),
        facts: [
          createScenarioSignalEntry({
            id: "wrong",
            kind: "assumption",
            label: "Wrong bucket",
            detail: "This belongs in assumptions.",
            source: "user_supplied",
          }),
        ],
      }),
    ).toThrow();
  });

  it("sorts entries by id during normalization", () => {
    const normalized = normalizeScenarioInput(
      buildScenarioInput({
        scenarioType: "open_pr_pressure",
        repoFullName: "octo/demo",
        facts: [
          createScenarioSignalEntry({ id: "z", kind: "fact", label: "Z", detail: "last", source: "github_observed" }),
          createScenarioSignalEntry({ id: "a", kind: "fact", label: "A", detail: "first", source: "github_observed" }),
        ],
      }),
    );
    expect(normalized.facts.map((entry) => entry.id)).toEqual(["a", "z"]);
  });
});

describe("public vs private serialization", () => {
  it("sanitizes forbidden language in public output only", () => {
    const input = buildScenarioInput({
      scenarioType: "pending_pr_resolution",
      repoFullName: "octo/demo",
      assumptions: [
        createScenarioSignalEntry({
          id: "unsafe",
          kind: "assumption",
          label: "Wallet hotkey payout",
          detail: "Raw trust score and scoreability leak",
          source: "user_supplied",
        }),
      ],
    });
    const publicSnapshot = serializeScenarioInputPublic(input);
    const serialized = JSON.stringify(publicSnapshot);
    expect(serialized).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(serialized).toMatch(/private context/i);

    const privateSnapshot = serializeScenarioInputPrivate(input);
    expect(privateSnapshot.assumptions[0]?.detail).toMatch(/trust score/i);
  });

  it("omits optional state sections when not provided", () => {
    const snapshot = serializeScenarioInputPublic(
      buildScenarioInput({
        scenarioType: "linked_issue_context",
        repoFullName: "octo/demo",
        issueState: { openIssueCount: 0, linkedIssueNumbers: [] },
      }),
    );
    expect(snapshot.pullRequestState).toBeUndefined();
    expect(snapshot.branchState).toBeUndefined();
    expect(snapshot.issueState?.linkedIssueNumbers).toEqual([]);
  });

  it("includes PR and branch state in public snapshots when present", () => {
    const snapshot = serializeScenarioInputPublic(
      buildScenarioInput({
        scenarioType: "open_pr_pressure",
        repoFullName: "octo/demo",
        pullRequestState: { openPrCount: 1 },
        branchState: { branchName: "feat/x" },
      }),
    );
    expect(snapshot.pullRequestState?.openPrCount).toBe(1);
    expect(snapshot.branchState?.branchName).toBe("feat/x");
  });

  it("allows public repo and branch identifiers that contain protocol terms", () => {
    const snapshot = serializeScenarioInputPublic(
      buildScenarioInput({
        scenarioType: "branch_preflight",
        repoFullName: "wallet-tools/api",
        branchState: { branchName: "feature/wallet-ui", baseRef: "hotkey-fix" },
        facts: [
          createScenarioSignalEntry({
            id: "branch",
            kind: "fact",
            label: "Branch",
            detail: "Active branch feature/wallet-ui against hotkey-fix.",
            source: "local_metadata",
          }),
        ],
      }),
    );

    expect(snapshot.repo.repoFullName).toBe("wallet-tools/api");
    expect(snapshot.branchState).toMatchObject({ branchName: "feature/wallet-ui", baseRef: "hotkey-fix" });
    expect(JSON.stringify(snapshot.facts)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("keeps advisory-only flags in both serializations", () => {
    const input = completeInput();
    expect(serializeScenarioInputPublic(input)).toMatchObject({
      advisoryOnly: true,
      notAutonomousPrBot: true,
      notPublicScoring: true,
    });
    expect(serializeScenarioInputPrivate(input)).toMatchObject({
      advisoryOnly: true,
      notAutonomousPrBot: true,
      notPublicScoring: true,
    });
  });
});

describe("source-upload safety", () => {
  it("rejects oversized changedFiles metadata strings", () => {
    expect(() => assertScenarioLocalBranchInputSafe({ changedFiles: [{ path: "a.ts", body: "x".repeat(5000) }] })).toThrow(
      /oversized/i,
    );
    expect(() => assertScenarioLocalBranchInputSafe({ changedFiles: [null, { path: "ok.ts" }] })).not.toThrow();
    expect(() => assertScenarioLocalBranchInputSafe({ login: "miner", repoFullName: "octo/demo" })).not.toThrow();
    expect(() =>
      assertScenarioLocalBranchInputSafe({ changedFiles: [{ path: "src/a.ts", additions: 1, deletions: 0, status: "modified" }] }),
    ).not.toThrow();
  });

  it("rejects source-upload env flag and forbidden local branch keys", () => {
    const previous = process.env.GITTENSORY_UPLOAD_SOURCE;
    process.env.GITTENSORY_UPLOAD_SOURCE = "true";
    expect(() => assertScenarioLocalBranchInputSafe({ login: "miner", repoFullName: "octo/demo" })).toThrow(/metadata-only/i);
    process.env.GITTENSORY_UPLOAD_SOURCE = previous;
    expect(() => assertScenarioLocalBranchInputSafe({ fileContent: "secret" })).toThrow(/never uploaded/i);
    expect(() => assertScenarioLocalBranchInputSafe({ changedFiles: [{ path: "a.ts", diff: "code" }] })).toThrow(/never uploaded/i);
  });

  it("builds branch metadata with and without optional fields", () => {
    const minimal = scenarioInputFromLocalBranchMetadata({
      scenarioType: "general_repo",
      login: "miner",
      repoFullName: "octo/demo",
    });
    expect(minimal.branchState).toBeUndefined();

    const eligible = scenarioInputFromLocalBranchMetadata({
      scenarioType: "general_repo",
      login: "miner",
      repoFullName: "octo/demo",
      eligibilityStatus: "eligible",
    });
    expect(minimal.facts.map((entry) => entry.id)).toEqual(["actor", "repo"]);
    expect(minimal.unavailableSignals).toEqual([]);
    expect(eligible.branchState?.eligibilityStatus).toBe("eligible");

    const branchOnly = scenarioInputFromLocalBranchMetadata({
      scenarioType: "branch_preflight",
      login: "miner",
      repoFullName: "octo/demo",
      branchName: "feat/demo",
    });
    expect(branchOnly.facts.find((entry) => entry.id === "branch")?.detail).not.toMatch(/against/);

    const rich = buildScenarioInput({
      scenarioType: "open_pr_pressure",
      repoFullName: "octo/demo",
      registered: true,
      maintainerLane: false,
      issueState: { openIssueCount: 4 },
      pullRequestState: { openPrCount: 2, stalePrCount: 1 },
      branchState: { branchName: "feat/x", baseRef: "origin/main", headRef: "feat/x" },
    });
    expect(rich.repo.registered).toBe(true);
    expect(rich.pullRequestState?.openPrCount).toBe(2);
  });

  it("builds metadata-only scenario input from local branch notes", () => {
    const input = scenarioInputFromLocalBranchMetadata({
      scenarioType: "branch_preflight",
      login: "miner",
      repoFullName: "octo/demo",
      branchName: "feat/demo",
      baseRef: "origin/main",
      changedFileCount: 3,
      linkedIssues: [12],
      scenarioNotes: ["approved PR may land tonight"],
      eligibilityStatus: "unknown",
    });
    expect(input.branchState?.changedFileCount).toBe(3);
    expect(input.issueState?.linkedIssueNumbers).toEqual([12]);
    expect(input.assumptions[0]?.source).toBe("user_supplied");
    expect(input.unavailableSignals[0]?.kind).toBe("unavailable");
    expect(JSON.stringify(input)).not.toMatch(/fileContent|sourceContent|upload/i);
  });

  it("bounds local branch metadata before scenario validation", () => {
    const input = scenarioInputFromLocalBranchMetadata({
      scenarioType: "branch_preflight",
      login: "miner",
      repoFullName: `octo/${"r".repeat(260)}`,
      branchName: "b".repeat(260),
      baseRef: "m".repeat(260),
      linkedIssues: Array.from({ length: 75 }, (_, index) => index + 1),
      scenarioNotes: ["n".repeat(SCENARIO_MAX_SIGNAL_DETAIL_CHARS + 100)],
    });

    expect(input.repo.repoFullName).toHaveLength(SCENARIO_MAX_REPO_FULL_NAME_CHARS);
    expect(input.branchState?.branchName).toHaveLength(SCENARIO_MAX_BRANCH_REF_CHARS);
    expect(input.branchState?.baseRef).toHaveLength(SCENARIO_MAX_BRANCH_REF_CHARS);
    expect(input.issueState?.linkedIssueNumbers).toHaveLength(SCENARIO_MAX_LINKED_ISSUE_NUMBERS);
    expect(input.assumptions[0]?.detail).toHaveLength(SCENARIO_MAX_SIGNAL_DETAIL_CHARS);
  });
});

describe("invariants", () => {
  it("does not embed ranking or strategy rendering fields", () => {
    const serialized = JSON.stringify(completeInput());
    expect(serialized).not.toMatch(/recommendedOption|rank:|strategy ranking|renderStrategy/i);
  });

  it("property: public serialization never reintroduces forbidden tokens", () => {
    const samples = [
      "wallet",
      "hotkey reward estimate",
      "raw trust score",
      "public score estimate",
      "private reviewability",
      "farming loop",
    ];
    for (const sample of samples) {
      const input = buildScenarioInput({
        scenarioType: "general_repo",
        repoFullName: "octo/demo",
        facts: [
          createScenarioSignalEntry({
            id: "sample",
            kind: "fact",
            label: sample,
            detail: sample,
            source: "user_supplied",
          }),
        ],
      });
      expect(JSON.stringify(serializeScenarioInputPublic(input))).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    }
  });
});
