import { describe, expect, it } from "vitest";
import {
  buildVisualFollowupComment,
  resolveVisualFollowupNotifyLogins,
  selectUnrelatedVisualFindings,
} from "../../src/review/visual/visual-followup";
import { VISUAL_FOLLOWUP_COMMENT_MARKER } from "../../src/github/comments";
import { buildVisualRegressionFindings, parseVisualVisionResponse, VISUAL_REGRESSION_FINDING_CODE, VISUAL_UNRELATED_ISSUE_FINDING_CODE } from "../../src/review/visual/visual-findings";
import type { AdvisoryFinding } from "../../src/types";

const unrelatedFinding = (overrides: Partial<AdvisoryFinding> = {}): AdvisoryFinding => ({
  code: VISUAL_UNRELATED_ISSUE_FINDING_CODE,
  severity: "warning",
  title: "Possible unrelated visual issue: /footer",
  detail: "The footer logo is stretched, unrelated to this change.",
  action: "Advisory only — this doesn't look related to this PR's stated change. Consider opening a new issue to track it separately.",
  visualEvidence: { path: "/footer", beforeUrl: "https://x/loopover/shot?key=before", afterUrl: "https://x/loopover/shot?key=after" },
  ...overrides,
});

const regressionFinding = (): AdvisoryFinding => ({
  code: VISUAL_REGRESSION_FINDING_CODE,
  severity: "warning",
  title: "Possible visual regression: /pricing",
  detail: "This PR broke the layout.",
  action: "Advisory only — verify against the Visual preview screenshots before deciding.",
});

describe("selectUnrelatedVisualFindings", () => {
  it("keeps only visual_unrelated_issue_finding entries", () => {
    expect(selectUnrelatedVisualFindings([regressionFinding(), unrelatedFinding()])).toEqual([unrelatedFinding()]);
  });

  it("returns [] when there are no findings, or none are unrelated", () => {
    expect(selectUnrelatedVisualFindings([])).toEqual([]);
    expect(selectUnrelatedVisualFindings([regressionFinding()])).toEqual([]);
  });

  it("ignores an unrelated non-visual finding code that happens to share a similar shape", () => {
    expect(selectUnrelatedVisualFindings([{ code: "ai_consensus_defect", severity: "critical", title: "t", detail: "d" }])).toEqual([]);
  });
});

describe("resolveVisualFollowupNotifyLogins", () => {
  it("uses the configured list as-is when non-empty, ignoring repo owner + admin logins entirely", () => {
    expect(resolveVisualFollowupNotifyLogins(["repo-maintainer"], "someowner", new Set(["admin1"]))).toEqual(["repo-maintainer"]);
  });

  it("falls back to repo owner + ADMIN_GITHUB_LOGINS when the configured list is empty — never a hardcoded username", () => {
    const result = resolveVisualFollowupNotifyLogins([], "someowner", new Set(["admin1", "admin2"]));
    expect(new Set(result)).toEqual(new Set(["someowner", "admin1", "admin2"]));
  });

  it("dedupes the repo owner against an admin login that is already the same account", () => {
    const result = resolveVisualFollowupNotifyLogins([], "admin1", new Set(["admin1"]));
    expect(result).toEqual(["admin1"]);
  });

  it("lowercases the repo owner before adding it, so casing never produces a duplicate mention", () => {
    const result = resolveVisualFollowupNotifyLogins([], "AdMin1", new Set(["admin1"]));
    expect(result).toEqual(["admin1"]);
  });

  it("falls back to just ADMIN_GITHUB_LOGINS when the repo owner is blank", () => {
    expect(resolveVisualFollowupNotifyLogins([], "", new Set(["admin1"]))).toEqual(["admin1"]);
  });

  it("returns [] when the configured list is empty, the repo owner is blank, AND there are no admin logins", () => {
    expect(resolveVisualFollowupNotifyLogins([], "", new Set())).toEqual([]);
  });
});

describe("buildVisualFollowupComment", () => {
  it("returns null when there are no unrelated findings, even with notify logins resolved", () => {
    expect(buildVisualFollowupComment([regressionFinding()], ["jsonbored"])).toBeNull();
  });

  it("returns null when there ARE unrelated findings but no login resolved to notify", () => {
    expect(buildVisualFollowupComment([unrelatedFinding()], [])).toBeNull();
  });

  it("returns null when both are empty", () => {
    expect(buildVisualFollowupComment([], [])).toBeNull();
  });

  it("@-mentions every notify login and includes the idempotency marker", () => {
    const body = buildVisualFollowupComment([unrelatedFinding()], ["jsonbored", "octocat"]);
    expect(body).toContain("@jsonbored @octocat");
    expect(body).toContain(VISUAL_FOLLOWUP_COMMENT_MARKER);
  });

  it("renders the finding's title + detail and a Before/After screenshot row", () => {
    const body = buildVisualFollowupComment([unrelatedFinding()], ["jsonbored"]);
    expect(body).toContain("### Possible unrelated visual issue: /footer");
    expect(body).toContain("The footer logo is stretched, unrelated to this change.");
    expect(body).toContain("| Before | After |");
    expect(body).toContain("![before](https://x/loopover/shot?key=before)");
    expect(body).toContain("![after](https://x/loopover/shot?key=after)");
  });

  it("renders a dash for whichever side has no shot URL", () => {
    const onlyAfter = buildVisualFollowupComment([unrelatedFinding({ visualEvidence: { path: "/footer", afterUrl: "https://x/loopover/shot?key=after" } })], ["jsonbored"]);
    expect(onlyAfter).toContain("| — | ![after](https://x/loopover/shot?key=after) |");
    const onlyBefore = buildVisualFollowupComment([unrelatedFinding({ visualEvidence: { path: "/footer", beforeUrl: "https://x/loopover/shot?key=before" } })], ["jsonbored"]);
    expect(onlyBefore).toContain("| ![before](https://x/loopover/shot?key=before) | — |");
  });

  it("omits the screenshot table entirely when the finding has no visualEvidence at all", () => {
    const findingWithoutEvidence: AdvisoryFinding = {
      code: VISUAL_UNRELATED_ISSUE_FINDING_CODE,
      severity: "warning",
      title: "Possible unrelated visual issue: /footer",
      detail: "The footer logo is stretched, unrelated to this change.",
    };
    const body = buildVisualFollowupComment([findingWithoutEvidence], ["jsonbored"]);
    expect(body).not.toContain("| Before | After |");
    expect(body).toContain("The footer logo is stretched, unrelated to this change.");
  });

  it("separates multiple findings with a horizontal rule, one heading each", () => {
    const second = unrelatedFinding({ title: "Possible unrelated visual issue: /pricing", detail: "The pricing table lost its border." });
    const body = buildVisualFollowupComment([unrelatedFinding(), second], ["jsonbored"]);
    expect(body).toContain("### Possible unrelated visual issue: /footer");
    expect(body).toContain("### Possible unrelated visual issue: /pricing");
    expect(body).toContain("\n\n---\n\n");
  });

  it("mentions GitHub's own Reference in new issue action", () => {
    const body = buildVisualFollowupComment([unrelatedFinding()], ["jsonbored"]);
    expect(body).toContain('Reference in new issue');
  });

  it("filters out a regression finding mixed in alongside unrelated ones, mentioning only the unrelated one", () => {
    const body = buildVisualFollowupComment([regressionFinding(), unrelatedFinding()], ["jsonbored"]);
    expect(body).not.toContain("Possible visual regression");
    expect(body).toContain("Possible unrelated visual issue");
  });

  it("REGRESSION (#10062): a hostile model path is scrubbed at parse time and never reaches the follow-up body as live markup", () => {
    const hostile = JSON.stringify({
      findings: [{ path: "/app [pwn](http://evil.example) @maintainer", body: "Layout looks off, unrelated to this change.", category: "unrelated" }],
    });
    const built = buildVisualRegressionFindings(parseVisualVisionResponse(hostile));
    const body = buildVisualFollowupComment(built, ["jsonbored"]);
    expect(body).not.toBeNull();
    expect(body!).not.toContain("](http://evil.example)"); // the injected link never renders live
  });
});
