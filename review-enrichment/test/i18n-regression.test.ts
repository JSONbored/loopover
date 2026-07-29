// Units for the i18n regression analyzer (#2029). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectHardcodedUiString,
  detectI18nConvention,
  looksLikeUserFacingLiteral,
  scanI18nRegression,
  scanPatchForI18nRegression,
} from "../dist/analyzers/i18n-regression.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectI18nConvention: recognizes common translation call patterns", () => {
  assert.equal(detectI18nConvention("const label = t('common.save');"), true);
  assert.equal(detectI18nConvention("const { t } = useTranslation();"), true);
  assert.equal(detectI18nConvention("<FormattedMessage id='save' />"), true);
  assert.equal(detectI18nConvention("<button>Save</button>"), false);
});

test("looksLikeUserFacingLiteral: distinguishes copy from keys and ids", () => {
  assert.equal(looksLikeUserFacingLiteral("Save changes"), true);
  assert.equal(looksLikeUserFacingLiteral("common.save"), false);
  assert.equal(looksLikeUserFacingLiteral("btn"), false);
  assert.equal(looksLikeUserFacingLiteral("Save"), true);
});

test("detectHardcodedUiString: flags JSX text and user-facing props", () => {
  assert.equal(detectHardcodedUiString("<button>Save changes</button>"), true);
  assert.equal(detectHardcodedUiString('<input placeholder="Enter your email" />'), true);
  assert.equal(detectHardcodedUiString("<button>{t('save')}</button>"), false);
  assert.equal(detectHardcodedUiString('<input className="w-full" />'), false);
});

test("detectHardcodedUiString: scans malformed JSX text in linear time", () => {
  const craftedLine = ">a".repeat(1000);
  const startedAt = performance.now();

  assert.equal(detectHardcodedUiString(craftedLine), false);

  assert.ok(performance.now() - startedAt < 100);
});

test("scanPatchForI18nRegression: flags hardcoded UI strings when i18n is in use", () => {
  const findings = scanPatchForI18nRegression(
    "src/Widget.tsx",
    patchOf([
      "export function Widget() {",
      "  const { t } = useTranslation();",
      "  return <button>{t('save')}</button>;",
      "}",
      "export function Banner() {",
      "  return <p>Welcome back</p>;",
      "}",
    ]),
  );
  assert.deepEqual(findings, [{ file: "src/Widget.tsx", line: 6 }]);
});

test("scanPatchForI18nRegression: inactive when the diff shows no i18n convention", () => {
  assert.deepEqual(
    scanPatchForI18nRegression("src/Widget.tsx", patchOf(["export function Widget() {", "  return <p>Hello</p>;", "}"])),
    [],
  );
});

test("scanPatchForI18nRegression: skips test files and respects the cap", () => {
  assert.deepEqual(
    scanPatchForI18nRegression("src/Widget.test.tsx", patchOf(["const { t } = useTranslation();", "<p>Hi</p>"])),
    [],
  );
  const lines = [
    "const { t } = useTranslation();",
    ...Array.from({ length: 30 }, (_, i) => `<p>Message ${i}</p>`),
  ];
  assert.equal(scanPatchForI18nRegression("src/a.tsx", patchOf(lines), { maxFindings: 3 }).length, 3);
});

test("scanI18nRegression: aggregates across files and renders a public-safe brief", async () => {
  const findings = await scanI18nRegression({
    files: [
      {
        path: "src/a.tsx",
        patch: patchOf(["const { t } = useTranslation();", "<span title=\"Save draft\">x</span>"]),
      },
    ],
  });
  assert.deepEqual(findings, [{ file: "src/a.tsx", line: 2 }]);
  const { promptSection } = renderBrief({ i18n: findings });
  assert.match(promptSection, /i18n regressions/);
  assert.match(promptSection, /src\/a\.tsx:2/);
  assert.doesNotMatch(promptSection, /Save draft/);
});
