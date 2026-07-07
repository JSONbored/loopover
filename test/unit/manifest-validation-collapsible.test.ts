import { afterEach, describe, expect, it } from "vitest";
import { buildManifestValidationCollapsible, buildUnifiedCommentBody } from "../../src/review/unified-comment-bridge";
import { loadPublicRepoFocusManifest, setLocalManifestReader } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";
import type { GateCheckEvaluation } from "../../src/rules/advisory";
import type { PublicPrPanelSignalRow } from "../../src/signals/engine";

function gate(over: Partial<GateCheckEvaluation> = {}): GateCheckEvaluation {
  return {
    enabled: true,
    conclusion: "success",
    title: "Gittensory Orb Review Agent passed",
    summary: "No configured hard blocker was found.",
    blockers: [],
    warnings: [],
    ...over,
  };
}

const panelRows: PublicPrPanelSignalRow[] = [
  { key: "gateResult", cells: ["Gate result", "✅ Passing", "No configured blocker found.", "No action."] },
];
const footer = "💰 Earn for open-source contributions. Checked by Gittensory.";

describe("buildManifestValidationCollapsible (#2056)", () => {
  it("returns null for an empty warnings array", () => {
    expect(buildManifestValidationCollapsible([])).toBeNull();
  });

  it("returns null when every warning is blank", () => {
    expect(buildManifestValidationCollapsible(["", "   "])).toBeNull();
  });

  it("builds a titled collapsible listing each grouped warning", () => {
    const c = buildManifestValidationCollapsible(["bad review.tone value", "bad review.profile value"]);
    expect(c).not.toBeNull();
    expect(c?.title).toBe("Manifest validation");
    expect(c?.body).toBe("- bad review.tone value\n- bad review.profile value");
  });

  it("dedupes identical warnings", () => {
    const c = buildManifestValidationCollapsible(["same warning", "same warning"]);
    expect(c?.body).toBe("- same warning");
  });
});

describe("buildUnifiedCommentBody: manifest validation wiring (#2056)", () => {
  afterEach(() => setLocalManifestReader(null));

  it("uses only repo-published warnings for public comments, not private self-host manifest warnings", async () => {
    const env = createTestEnv();
    const secret = "OPERATOR_ONLY_SECRET_9f3c";
    setLocalManifestReader(async () => `gate:
  linkedIssue: "wallet hotkey reward scoreability ${secret}"
`);

    const publicManifest = await loadPublicRepoFocusManifest(env, "owner/repo", {
      fetcher: async () => `review:
  profile: loud
`,
    });
    const body = buildUnifiedCommentBody({
      gate: gate(),
      panelRows,
      readinessTotal: 88,
      changedFiles: 1,
      footerMarkdown: footer,
      manifestWarnings: publicManifest.warnings,
    });

    expect(body).toContain("Manifest validation");
    expect(body).toContain('Manifest "review.profile"');
    expect(body).not.toContain(secret);
    expect(body).not.toMatch(/wallet|hotkey|reward|scoreability/i);
  });

  it("appends a Manifest validation collapsible when manifestWarnings is non-empty", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      panelRows,
      readinessTotal: 88,
      changedFiles: 1,
      footerMarkdown: footer,
      manifestWarnings: ["Manifest field \"review.tone\" must be a string; ignoring it."],
    });
    expect(body).toContain("<summary><b>Manifest validation</b></summary>");
    expect(body).toContain("Manifest field \"review.tone\" must be a string; ignoring it.");
  });

  it("omits the section when manifestWarnings is empty or absent (byte-identical)", () => {
    const withEmpty = buildUnifiedCommentBody({
      gate: gate(),
      panelRows,
      readinessTotal: 88,
      changedFiles: 1,
      footerMarkdown: footer,
      manifestWarnings: [],
    });
    const withoutField = buildUnifiedCommentBody({
      gate: gate(),
      panelRows,
      readinessTotal: 88,
      changedFiles: 1,
      footerMarkdown: footer,
    });
    expect(withEmpty).toBe(withoutField);
    expect(withEmpty).not.toContain("Manifest validation");
  });

  it("renders the Manifest validation section ahead of the Changed files section", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      panelRows,
      readinessTotal: 88,
      changedFiles: 1,
      footerMarkdown: footer,
      manifestWarnings: ["a config warning"],
      changedFilesSummary: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
    });
    expect(body.indexOf("Manifest validation")).toBeLessThan(body.indexOf("Changed files"));
  });

  it("renders Changed files with no Manifest validation section when only manifestWarnings is absent", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      panelRows,
      readinessTotal: 88,
      changedFiles: 1,
      footerMarkdown: footer,
      changedFilesSummary: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
    });
    expect(body).toContain("Changed files");
    expect(body).not.toContain("Manifest validation");
  });
});
