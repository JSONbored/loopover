import { describe, expect, it } from "vitest";
import { buildPrTextLint, type PrTextLintReport } from "../../src/signals/engine";

const FORBIDDEN_PUBLIC_TERMS = /wallet|hotkey|coldkey|mnemonic|payout|reward|farming|raw trust|trust score|scoreability|reviewability/i;
const GOOD_COMMIT = "feat(api): add cursor pagination to the labels endpoint for large repositories";
const GOOD_BODY =
  "This pull request adds cursor-based pagination to the repository labels endpoint so labels beyond the first cached page are returned. Tested with vitest covering the new pagination path.";

function component(report: PrTextLintReport, key: string) {
  return report.components.find((c) => c.key === key)!;
}

function assertPublicSafe(report: PrTextLintReport): void {
  for (const line of [report.summary, ...report.fixes, ...report.components.flatMap((c) => [c.evidence, c.fix ?? ""])]) {
    expect(line).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  }
}

describe("buildPrTextLint", () => {
  it("returns strong for linked, descriptive, validated text", () => {
    const report = buildPrTextLint({ commitMessages: [GOOD_COMMIT], prBody: GOOD_BODY, linkedIssue: 160 });
    expect(report.verdict).toBe("strong");
    expect(report.score).toBe(100);
    expect(report.fixes).toHaveLength(0);
    expect(component(report, "traceability").evidence).toMatch(/#160/);
    expect(component(report, "pr_body").evidence).toMatch(/validation notes/i);
    assertPublicSafe(report);
  });

  it("accepts a no-issue rationale in place of a linked issue", () => {
    const report = buildPrTextLint({ commitMessages: [GOOD_COMMIT], prBody: "Docs only change to clarify the README setup steps; no issue needed for this maintenance edit." });
    expect(component(report, "traceability").status).toBe("ok");
    expect(component(report, "traceability").evidence).toMatch(/no-issue rationale/i);
    assertPublicSafe(report);
  });

  it("describes the change without flagging a missing validation note", () => {
    const body = "This change refactors the pagination helper so the labels endpoint returns every page of results for large repositories without duplicate calls.";
    const report = buildPrTextLint({ commitMessages: [GOOD_COMMIT], prBody: body, linkedIssue: 1 });
    expect(component(report, "pr_body").status).toBe("ok");
    expect(component(report, "pr_body").evidence).toMatch(/specific detail/i);
    assertPublicSafe(report);
  });

  it("is adequate when only the commit message is generic", () => {
    const report = buildPrTextLint({ commitMessages: ["wip"], prBody: GOOD_BODY, linkedIssue: 160 });
    expect(component(report, "commit_message").status).toBe("weak");
    expect(component(report, "commit_message").evidence).toMatch(/generic/i);
    expect(report.verdict).toBe("adequate");
    expect(report.fixes.some((f) => /conventional commit subject/i.test(f))).toBe(true);
    assertPublicSafe(report);
  });

  it("flags an empty commit message", () => {
    const report = buildPrTextLint({ commitMessages: [], prBody: GOOD_BODY, linkedIssue: 160 });
    expect(component(report, "commit_message").evidence).toMatch(/No commit message/i);
    expect(report.verdict).toBe("adequate");
    assertPublicSafe(report);
  });

  it("flags a too-short commit message", () => {
    const report = buildPrTextLint({ commitMessages: ["fix(ui): typo"], prBody: GOOD_BODY, linkedIssue: 160 });
    expect(component(report, "commit_message").status).toBe("weak");
    expect(component(report, "commit_message").evidence).toMatch(/too short|specific detail/i);
    assertPublicSafe(report);
  });

  it("flags a descriptive commit that is not Conventional-Commit format", () => {
    const report = buildPrTextLint({ commitMessages: ["Add cursor pagination to the labels endpoint"], prBody: GOOD_BODY, linkedIssue: 160 });
    expect(component(report, "commit_message").status).toBe("weak");
    expect(component(report, "commit_message").evidence).toMatch(/conventional commit/i);
    expect(report.fixes.some((f) => /conventional commit/i.test(f))).toBe(true);
    assertPublicSafe(report);
  });

  it("is weak when traceability is missing even if the rest is good", () => {
    const report = buildPrTextLint({ commitMessages: [GOOD_COMMIT], prBody: GOOD_BODY });
    expect(component(report, "traceability").status).toBe("weak");
    expect(report.verdict).toBe("weak");
    expect(report.fixes.some((f) => /Fixes #123|no issue applies/i.test(f))).toBe(true);
    assertPublicSafe(report);
  });

  it("flags an empty PR body", () => {
    const report = buildPrTextLint({ commitMessages: [GOOD_COMMIT], prBody: "", linkedIssue: 160 });
    expect(component(report, "pr_body").evidence).toMatch(/empty/i);
    assertPublicSafe(report);
  });

  it("flags an unfilled template PR body", () => {
    const templated = "## Summary\n\n<!-- Describe your change -->\n\n## Checklist\n- [ ] Tests\n- [ ] Docs";
    const report = buildPrTextLint({ commitMessages: [GOOD_COMMIT], prBody: templated, linkedIssue: 160 });
    expect(component(report, "pr_body").status).toBe("weak");
    expect(component(report, "pr_body").evidence).toMatch(/unfilled template/i);
    assertPublicSafe(report);
  });

  it("flags a thin PR body", () => {
    const report = buildPrTextLint({ commitMessages: [GOOD_COMMIT], prBody: "fixes stuff", linkedIssue: 160 });
    expect(component(report, "pr_body").evidence).toMatch(/thin/i);
    assertPublicSafe(report);
  });

  it("does not flag a substantive non-Latin PR body as thin", () => {
    const cyrillic =
      "Этот запрос добавляет курсорную пагинацию к конечной точке меток репозитория, чтобы возвращались все страницы результатов для больших репозиториев.";
    const cjk = "この変更は、リポジトリのラベルエンドポイントにカーソルベースのページネーションを追加し、最初のページ以降のラベルも返されるようにします。";
    for (const prBody of [cyrillic, cjk]) {
      const report = buildPrTextLint({ commitMessages: [GOOD_COMMIT], prBody, linkedIssue: 160 });
      expect(component(report, "pr_body").status).toBe("ok");
      assertPublicSafe(report);
    }
  });

  it("returns weak with all fixes when every dimension is low-effort", () => {
    const report = buildPrTextLint({ commitMessages: ["update"], prBody: "" });
    expect(report.verdict).toBe("weak");
    expect(report.fixes).toHaveLength(4);
    expect(report.score).toBeLessThan(50);
    expect(report.summary).toMatch(/low-effort/i);
    assertPublicSafe(report);
  });

  it("handles entirely empty input deterministically", () => {
    const report = buildPrTextLint({});
    expect(report.verdict).toBe("weak");
    expect(report.components).toHaveLength(4);
    assertPublicSafe(report);
  });

  it("grades validation_evidence ok when the body mentions testing", () => {
    const body = "Adds retry logic to the fetch helper. Tested with npm run test:ci — all 142 tests pass.";
    const report = buildPrTextLint({ commitMessages: [GOOD_COMMIT], prBody: body, linkedIssue: 42 });
    expect(component(report, "validation_evidence").status).toBe("ok");
    expect(report.verdict).toBe("strong");
    assertPublicSafe(report);
  });

  it("grades validation_evidence weak when the body has no test mention and surfaces a fix", () => {
    const body = "Adds retry logic to the fetch helper to handle transient network errors on the labels endpoint.";
    const report = buildPrTextLint({ commitMessages: [GOOD_COMMIT], prBody: body, linkedIssue: 42 });
    expect(component(report, "validation_evidence").status).toBe("weak");
    expect(component(report, "validation_evidence").fix).toMatch(/validated|test/i);
    expect(report.verdict).toBe("adequate");
    assertPublicSafe(report);
  });
});
