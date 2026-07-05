import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractObjectiveAnchorHistory,
  extractObjectiveAnchorFeatures,
  renderObjectiveAnchorAuditMarkdown,
  scoreObjectiveAnchor,
  scoreObjectiveAnchorHistory,
  type ObjectiveAnchorInput,
} from "../dist/index.js";

function replay(overrides: ObjectiveAnchorInput = {}): ObjectiveAnchorInput {
  return {
    paths: ["packages/gittensory-engine/src/opportunity-ranker.ts", "packages/gittensory-engine/test/opportunity-ranker.test.ts"],
    labels: ["gittensor:feature"],
    titles: ["feat(miner): add deterministic ranking"],
    ...overrides,
  };
}

function revealed(overrides: ObjectiveAnchorInput = {}): ObjectiveAnchorInput {
  return {
    paths: ["packages/gittensory-engine/src/opportunity-ranker.ts", "packages/gittensory-engine/test/opportunity-ranker.test.ts"],
    labels: ["gittensor:feature"],
    titles: ["feat(miner): add deterministic ranking"],
    ...overrides,
  };
}

test("barrel: the public entrypoint re-exports objective-anchor APIs (#3012)", () => {
  assert.equal(typeof extractObjectiveAnchorFeatures, "function");
  assert.equal(typeof extractObjectiveAnchorHistory, "function");
  assert.equal(typeof scoreObjectiveAnchor, "function");
  assert.equal(typeof scoreObjectiveAnchorHistory, "function");
  assert.equal(typeof renderObjectiveAnchorAuditMarkdown, "function");
});

test("extractObjectiveAnchorFeatures normalizes paths, derives modules, and classifies change kind", () => {
  const features = extractObjectiveAnchorFeatures({
    paths: [
      ".\\Packages\\Gittensory-Engine\\src\\Objective-Anchor.ts",
      "./packages/gittensory-engine/src/objective-anchor.ts",
      "README.md",
      ".github/workflows/ci.yml",
      "package.json",
      "",
    ],
    labels: ["enhancement", "security"],
    titles: ["refactor scoring support"],
    notes: ["adds tests and docs"],
  });

  assert.deepEqual(features.paths, [
    ".github/workflows/ci.yml",
    "package.json",
    "packages/gittensory-engine/src/objective-anchor.ts",
    "readme.md",
  ]);
  assert.deepEqual(features.modules, [".github/workflows", "package.json", "packages/gittensory-engine", "readme.md"]);
  assert.deepEqual(features.changeKinds, [
    "feature",
    "test",
    "docs",
    "refactor",
    "config",
    "ci",
    "security",
    "dependency",
  ]);
});

test("scoreObjectiveAnchor returns 1 for full structural overlap", () => {
  const result = scoreObjectiveAnchor({ replayed: replay(), revealed: revealed() });

  assert.equal(result.score, 1);
  assert.deepEqual(result.dimensions, { paths: 1, modules: 1, changeKinds: 1 });
  assert.deepEqual(result.audit.intersections.paths, [
    "packages/gittensory-engine/src/opportunity-ranker.ts",
    "packages/gittensory-engine/test/opportunity-ranker.test.ts",
  ]);
  assert.deepEqual(result.audit.misses.revealedOnlyModules, []);
});

test("scoreObjectiveAnchor gives a low floor, not an error, when revealed history touches zero overlapping modules", () => {
  const result = scoreObjectiveAnchor({
    replayed: replay({
      paths: ["packages/gittensory-engine/src/opportunity-ranker.ts"],
      labels: ["feature"],
    }),
    revealed: revealed({
      paths: ["apps/gittensory-ui/src/routes/index.tsx"],
      labels: ["bug"],
      titles: ["fix(site): repair the homepage"],
    }),
  });

  assert.equal(result.dimensions.paths, 0);
  assert.equal(result.dimensions.modules, 0);
  assert.equal(result.dimensions.changeKinds, 0);
  assert.equal(result.score, 0);
  assert.deepEqual(result.audit.misses.replayedOnlyModules, ["packages/gittensory-engine"]);
  assert.deepEqual(result.audit.misses.revealedOnlyModules, ["apps/gittensory-ui"]);
});

test("scoreObjectiveAnchor grants partial module credit when paths differ inside the same module", () => {
  const result = scoreObjectiveAnchor({
    replayed: replay({
      paths: ["packages/gittensory-engine/src/opportunity-ranker.ts"],
      labels: ["feature"],
    }),
    revealed: revealed({
      paths: ["packages/gittensory-engine/src/objective-anchor.ts"],
      labels: ["feature"],
    }),
  });

  assert.equal(result.dimensions.paths, 0);
  assert.equal(result.dimensions.modules, 1);
  assert.equal(result.dimensions.changeKinds, 1);
  assert.equal(result.score, 0.55);
  assert.deepEqual(result.audit.intersections.modules, ["packages/gittensory-engine"]);
});

test("scoreObjectiveAnchor exposes deterministic intermediate features for audit without rerunning extraction", () => {
  const result = scoreObjectiveAnchor({
    replayed: replay({
      paths: ["src/review/enrichment-wire.ts", "test/unit/enrichment-wire.test.ts"],
      labels: ["bug"],
      titles: [],
      notes: ["regression test for an auth failure"],
    }),
    revealed: revealed({
      paths: ["src/review/enrichment-wire.ts", "src/review/enrichment-config.ts"],
      labels: ["fix"],
      titles: [],
      notes: ["auth configuration bug fixed"],
    }),
  });

  assert.deepEqual(result.audit.replayed.modules, ["src/review", "test/unit"]);
  assert.deepEqual(result.audit.revealed.modules, ["src/review"]);
  assert.deepEqual(result.audit.intersections.paths, ["src/review/enrichment-wire.ts"]);
  assert.deepEqual(result.audit.intersections.changeKinds, ["fix", "security"]);
  assert.deepEqual(result.audit.misses.replayedOnlyPaths, ["test/unit/enrichment-wire.test.ts"]);
  assert.deepEqual(result.audit.misses.revealedOnlyPaths, ["src/review/enrichment-config.ts"]);
});

test("scoreObjectiveAnchor is byte-stable for the same inputs and normalized weights", () => {
  const input = {
    replayed: replay({
      paths: ["src/mcp/server.ts", "test/unit/mcp-discovery.test.ts"],
      labels: ["feature"],
    }),
    revealed: revealed({
      paths: ["src/mcp/server.ts", "src/mcp/schema.ts", "test/unit/mcp-find-opportunities.test.ts"],
      labels: ["feature"],
    }),
    weights: { paths: 9, modules: 8, changeKinds: 3 },
  };

  const first = JSON.stringify(scoreObjectiveAnchor(input));
  const second = JSON.stringify(scoreObjectiveAnchor(input));

  assert.equal(first, second);
});

test("scoreObjectiveAnchor normalizes caller weights and ignores invalid weight values", () => {
  const result = scoreObjectiveAnchor({
    replayed: replay({ paths: ["src/review/a.ts"], labels: ["feature"] }),
    revealed: revealed({ paths: ["src/review/b.ts"], labels: ["feature"] }),
    weights: { paths: Number.NaN, modules: 8, changeKinds: -1 },
  });

  assert.deepEqual(result.audit.weights, { paths: 0, modules: 1, changeKinds: 0 });
  assert.equal(result.score, 1);
});

test("scoreObjectiveAnchor accepts pre-extracted features from a caller-side cache", () => {
  const replayed = extractObjectiveAnchorFeatures(replay({ paths: ["src/rules/predicted-gate.ts"], labels: ["fix"] }));
  const revealedFeatures = extractObjectiveAnchorFeatures(
    revealed({ paths: ["src/rules/predicted-gate.ts"], labels: ["fix"] }),
  );

  const result = scoreObjectiveAnchor({ replayed, revealed: revealedFeatures });

  assert.equal(result.score, 1);
  assert.deepEqual(result.audit.replayed, replayed);
  assert.deepEqual(result.audit.revealed, revealedFeatures);
});

test("scoreObjectiveAnchor falls back to unknown change kind when no kind signal exists", () => {
  const result = scoreObjectiveAnchor({
    replayed: { paths: ["src/opaque.ts"] },
    revealed: { paths: ["src/other.ts"] },
  });

  assert.deepEqual(result.audit.replayed.changeKinds, ["unknown"]);
  assert.deepEqual(result.audit.revealed.changeKinds, ["unknown"]);
  assert.equal(result.dimensions.changeKinds, 1);
});

test("extractObjectiveAnchorHistory keeps per-item extraction evidence and aggregates the union", () => {
  const extraction = extractObjectiveAnchorHistory([
    {
      id: "plan:1",
      source: "plan",
      paths: ["packages/gittensory-engine/src/objective-anchor.ts"],
      labels: ["feature"],
    },
    {
      id: "commit:abc",
      source: "commit",
      paths: ["packages/gittensory-engine/test/objective-anchor.test.ts", "README.md"],
      titles: ["test(engine): cover objective-anchor scoring"],
    },
  ]);

  assert.deepEqual(extraction.features.paths, [
    "packages/gittensory-engine/src/objective-anchor.ts",
    "packages/gittensory-engine/test/objective-anchor.test.ts",
    "readme.md",
  ]);
  assert.deepEqual(extraction.features.modules, ["packages/gittensory-engine", "readme.md"]);
  assert.deepEqual(extraction.features.changeKinds, ["feature", "test", "docs"]);
  assert.deepEqual(
    extraction.items.map((item) => [item.id, item.source, item.features.modules]),
    [
      ["plan:1", "plan", ["packages/gittensory-engine"]],
      ["commit:abc", "commit", ["packages/gittensory-engine", "readme.md"]],
    ],
  );
});

test("extractObjectiveAnchorHistory supplies deterministic ids and unknown source for sparse history items", () => {
  const extraction = extractObjectiveAnchorHistory([
    { paths: ["src/a.ts"] },
    { id: "  ", source: undefined, paths: ["src/b.ts"] },
  ]);

  assert.deepEqual(
    extraction.items.map((item) => [item.id, item.source]),
    [
      ["item:1", "unknown"],
      ["item:2", "unknown"],
    ],
  );
});

test("extractObjectiveAnchorHistory handles an empty history without throwing", () => {
  const extraction = extractObjectiveAnchorHistory([]);

  assert.deepEqual(extraction.features, { paths: [], modules: [], changeKinds: ["unknown"] });
  assert.deepEqual(extraction.items, []);
});

test("scoreObjectiveAnchorHistory scores aggregate replayed and revealed records while retaining item audits", () => {
  const result = scoreObjectiveAnchorHistory({
    replayed: [
      {
        id: "plan:objective-anchor",
        source: "plan",
        paths: ["packages/gittensory-engine/src/objective-anchor.ts"],
        labels: ["feature"],
      },
      {
        id: "plan:tests",
        source: "plan",
        paths: ["packages/gittensory-engine/test/objective-anchor.test.ts"],
        labels: ["test"],
      },
    ],
    revealed: [
      {
        id: "pr:3142",
        source: "pull_request",
        paths: ["packages/gittensory-engine/src/objective-anchor.ts"],
        labels: ["feature"],
      },
      {
        id: "commit:test",
        source: "commit",
        paths: ["packages/gittensory-engine/test/objective-anchor.test.ts"],
        labels: ["test"],
      },
    ],
  });

  assert.equal(result.score, 1);
  assert.deepEqual(
    result.history.replayed.items.map((item) => item.id),
    ["plan:objective-anchor", "plan:tests"],
  );
  assert.deepEqual(
    result.history.revealed.items.map((item) => item.source),
    ["pull_request", "commit"],
  );
});

test("scoreObjectiveAnchorHistory matches scoreObjectiveAnchor on aggregated features", () => {
  const historyResult = scoreObjectiveAnchorHistory({
    replayed: [
      { paths: ["src/mcp/server.ts"], labels: ["feature"] },
      { paths: ["test/unit/mcp.test.ts"], labels: ["test"] },
    ],
    revealed: [
      { paths: ["src/mcp/server.ts"], labels: ["feature"] },
      { paths: ["src/mcp/schema.ts"], labels: ["feature"] },
    ],
    weights: { paths: 2, modules: 2, changeKinds: 1 },
  });
  const directResult = scoreObjectiveAnchor({
    replayed: historyResult.history.replayed.features,
    revealed: historyResult.history.revealed.features,
    weights: { paths: 2, modules: 2, changeKinds: 1 },
  });

  assert.deepEqual(historyResult.score, directResult.score);
  assert.deepEqual(historyResult.dimensions, directResult.dimensions);
  assert.deepEqual(historyResult.audit, directResult.audit);
});

test("renderObjectiveAnchorAuditMarkdown renders a deterministic single-score audit", () => {
  const result = scoreObjectiveAnchor({
    replayed: replay({ paths: ["src/review/a.ts"], labels: ["feature"] }),
    revealed: revealed({ paths: ["src/review/b.ts"], labels: ["feature"] }),
  });
  const markdown = renderObjectiveAnchorAuditMarkdown(result);

  assert.ok(markdown.startsWith("# Objective-Anchor Score\n\nScore: 0.550000\n"));
  assert.match(markdown, /## Dimensions\n\n- paths: 0\.000000\n- modules: 1\.000000\n- changeKinds: 1\.000000/u);
  assert.match(markdown, /## Intersections[\s\S]*Modules:\n- src\/review/u);
  assert.match(markdown, /Replayed-only paths:\n- src\/review\/a\.ts/u);
  assert.match(markdown, /Revealed-only paths:\n- src\/review\/b\.ts/u);
});

test("renderObjectiveAnchorAuditMarkdown includes per-item history evidence for history scores", () => {
  const result = scoreObjectiveAnchorHistory({
    replayed: [{ id: "plan:one", source: "plan", paths: ["src/review/a.ts"], labels: ["feature"] }],
    revealed: [{ id: "pr:two", source: "pull_request", paths: ["src/review/a.ts"], labels: ["feature"] }],
  });
  const markdown = renderObjectiveAnchorAuditMarkdown(result);

  assert.match(markdown, /## Replayed History Items\n\n### plan:one \(plan\)/u);
  assert.match(markdown, /## Revealed History Items\n\n### pr:two \(pull\\_request\)/u);
  assert.match(markdown, /Paths:\n- src\/review\/a\.ts/u);
});

test("renderObjectiveAnchorAuditMarkdown reports none for empty miss lists", () => {
  const result = scoreObjectiveAnchor({
    replayed: replay({ paths: ["src/review/a.ts"], labels: ["feature"] }),
    revealed: revealed({ paths: ["src/review/a.ts"], labels: ["feature"] }),
  });
  const markdown = renderObjectiveAnchorAuditMarkdown(result);

  assert.match(markdown, /Replayed-only paths:\n- none/u);
  assert.match(markdown, /Revealed-only modules:\n- none/u);
});

test("renderObjectiveAnchorAuditMarkdown escapes markdown controls and collapses newlines from audit values", () => {
  const result = scoreObjectiveAnchorHistory({
    replayed: [
      {
        id: "plan:*bold*\nnext",
        source: "manual",
        paths: ["src/review/[unsafe].ts"],
        labels: ["feature"],
      },
    ],
    revealed: [
      {
        id: "pr:`code`",
        source: "pull_request",
        paths: ["src/review/<unsafe>.ts"],
        labels: ["feature"],
      },
    ],
  });
  const markdown = renderObjectiveAnchorAuditMarkdown(result);

  assert.ok(markdown.includes("### plan:\\*bold\\* next (manual)"));
  assert.ok(markdown.includes("### pr:\\`code\\` (pull\\_request)"));
  assert.ok(markdown.includes("- src/review/\\[unsafe\\].ts"));
  assert.ok(markdown.includes("- src/review/\\<unsafe\\>.ts"));
});
