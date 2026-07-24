import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_ROADMAP_STATUSES,
  checkRoadmapIssueDrift,
  findStaleRoadmapItems,
  formatStaleRoadmapFailures,
  isStaleActiveRoadmapPresentation,
  parseRoadmapItems,
  type GithubApi,
  type RoadmapItemRef,
} from "../../scripts/check-roadmap-issue-drift.js";

// (#8390) Pure drift rule + parser coverage for the roadmap issue-drift check. Live GitHub is injected;
// these tests never hit the network.

describe("isStaleActiveRoadmapPresentation (#8390)", () => {
  it.each([
    {
      name: "shipping-soon + closed completed → stale",
      input: { status: "shipping-soon", issueState: "closed", issueStateReason: "completed" },
      expected: true,
    },
    {
      name: "planned + closed COMPLETED (GraphQL casing) → stale",
      input: { status: "planned", issueState: "CLOSED", issueStateReason: "COMPLETED" },
      expected: true,
    },
    {
      name: "shipping-soon + open → not stale",
      input: { status: "shipping-soon", issueState: "open", issueStateReason: null },
      expected: false,
    },
    {
      name: "planned + closed not_planned → not stale (wrong reason)",
      input: { status: "planned", issueState: "closed", issueStateReason: "not_planned" },
      expected: false,
    },
    {
      name: "planned + closed with missing reason → not stale",
      input: { status: "planned", issueState: "closed", issueStateReason: null },
      expected: false,
    },
    {
      name: "exploring + closed completed → not stale (only active columns are gated)",
      input: { status: "exploring", issueState: "closed", issueStateReason: "completed" },
      expected: false,
    },
    {
      name: "exploring + closed not_planned → not stale",
      input: { status: "exploring", issueState: "closed", issueStateReason: "not_planned" },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(isStaleActiveRoadmapPresentation(input)).toBe(expected);
  });

  it("treats only shipping-soon and planned as active presentation statuses", () => {
    expect([...ACTIVE_ROADMAP_STATUSES].sort()).toEqual(["planned", "shipping-soon"]);
  });
});

describe("parseRoadmapItems (#8390)", () => {
  it("extracts status + issue from a ROADMAP_ITEMS array literal", () => {
    const source = `
const ROADMAP_ITEMS: Array<{ status: string; issue: number }> = [
  {
    title: "Phase 0",
    status: "shipping-soon",
    issue: 233,
    description: "x",
  },
  {
    title: "Phase 2",
    status: "planned",
    issue: 235,
    description: "y",
  },
  {
    title: "Phase 4",
    status: "exploring",
    issue: 237,
    description: "z",
  },
];
`;
    expect(parseRoadmapItems(source)).toEqual([
      { status: "shipping-soon", issue: 233 },
      { status: "planned", issue: 235 },
      { status: "exploring", issue: 237 },
    ]);
  });

  it("throws when ROADMAP_ITEMS is missing or empty of parseable entries", () => {
    expect(() => parseRoadmapItems("const OTHER = [];")).toThrow(/ROADMAP_ITEMS array not found/);
    expect(() => parseRoadmapItems("const ROADMAP_ITEMS = [];")).toThrow(/no parseable/);
  });

  it("parses the real apps/loopover-ui roadmap source", () => {
    const source = readFileSync(join(process.cwd(), "apps/loopover-ui/src/routes/roadmap.tsx"), "utf8");
    const items = parseRoadmapItems(source);
    expect(items.length).toBeGreaterThanOrEqual(6);
    expect(items.every((item) => typeof item.issue === "number" && item.issue > 0)).toBe(true);
    expect(items.some((item) => ACTIVE_ROADMAP_STATUSES.has(item.status))).toBe(true);
  });
});

describe("findStaleRoadmapItems / checkRoadmapIssueDrift (#8390)", () => {
  const items: RoadmapItemRef[] = [
    { status: "shipping-soon", issue: 233 },
    { status: "planned", issue: 235 },
    { status: "exploring", issue: 237 },
  ];

  function issueApi(byNumber: Record<number, { state: string; state_reason: string | null }>): GithubApi {
    return async (path: string) => {
      const match = /\/issues\/(\d+)$/.exec(path);
      if (!match) throw new Error(`unexpected path: ${path}`);
      const issue = byNumber[Number(match[1])];
      if (!issue) throw new Error(`unexpected issue: ${match[1]}`);
      return issue;
    };
  }

  it("returns stale active items and skips exploring even when completed", async () => {
    const stale = await findStaleRoadmapItems({
      items,
      owner: "JSONbored",
      repo: "loopover",
      githubApi: issueApi({
        233: { state: "closed", state_reason: "completed" },
        235: { state: "open", state_reason: null },
        237: { state: "closed", state_reason: "completed" },
      }),
    });
    expect(stale).toEqual([{ status: "shipping-soon", issue: 233, state: "closed", stateReason: "completed" }]);
    expect(formatStaleRoadmapFailures(stale)[0]).toContain("#233");
    expect(formatStaleRoadmapFailures(stale)[0]).toContain("stateReason=completed");
  });

  it("passes when every active item is still open", async () => {
    const failures = await checkRoadmapIssueDrift({
      roadmapSourceText: `
const ROADMAP_ITEMS = [
  { status: "shipping-soon", issue: 1 },
  { status: "planned", issue: 2 },
  { status: "exploring", issue: 3 },
];
`,
      githubApi: issueApi({
        1: { state: "open", state_reason: null },
        2: { state: "open", state_reason: null },
        3: { state: "closed", state_reason: "completed" },
      }),
    });
    expect(failures).toEqual([]);
  });

  it("fails with clear messages when planned/shipping-soon issues are completed", async () => {
    const failures = await checkRoadmapIssueDrift({
      roadmapSourceText: `
const ROADMAP_ITEMS = [
  { status: "shipping-soon", issue: 10 },
  { status: "planned", issue: 11 },
];
`,
      githubApi: issueApi({
        10: { state: "closed", state_reason: "completed" },
        11: { state: "closed", state_reason: "completed" },
      }),
    });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/#10.*shipping-soon/);
    expect(failures[1]).toMatch(/#11.*planned/);
  });
});
