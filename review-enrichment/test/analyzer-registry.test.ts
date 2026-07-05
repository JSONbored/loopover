import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYZER_DESCRIPTORS,
  ANALYZER_NAMES,
  ANALYZERS,
  getAnalyzerDescriptor,
} from "../dist/analyzers/registry.js";
import { buildBrief } from "../dist/brief.js";
import { renderBrief } from "../dist/render.js";

const EXPECTED_ANALYZERS = [
  "dependency",
  "dependencyDiff",
  "lockfileDrift",
  "secret",
  "license",
  "installScript",
  "heavyDependency",
  "hardcodedUrl",
  "actionPin",
  "eol",
  "redos",
  "provenance",
  "codeowners",
  "secretLog",
  "assetWeight",
  "typosquat",
  "commitSignature",
  "iacMisconfig",
  "nativeBuild",
  "history",
  "docCommentDrift",
  "duplication",
  "churnHotspot",
  "blameLink",
  "approvalIntegrity",
  "ciCheckSignals",
  "undocumentedExport",
  "staleBranch",
  "commitHygiene",
  "pendingReviewRequests",
  "testRatio",
  "migrationSafety",
  "looseRange",
  "terminology",
  "todoMarker",
  "magicNumber",
  "conflictMarker",
  "debugLeftover",
  "sizeSmell",
  "commitLint",
];

test("analyzer descriptors cover the runtime registry in stable order", () => {
  assert.deepEqual(ANALYZER_NAMES, EXPECTED_ANALYZERS);
  assert.equal(new Set(ANALYZER_NAMES).size, ANALYZER_NAMES.length);

  for (const descriptor of ANALYZER_DESCRIPTORS) {
    assert.equal(getAnalyzerDescriptor(descriptor.name), descriptor);
    assert.equal(typeof ANALYZERS[descriptor.name], "function");
    assert.equal(descriptor.defaultEnabled, true);
    assert.ok(descriptor.title.length > 3);
    assert.ok(descriptor.docs.summary.length > 10);
    assert.ok(descriptor.docs.looksAt.length > 10);
    assert.ok(descriptor.docs.reports.length > 10);
    assert.ok(descriptor.docs.network.length > 10);
  }
});

test("buildBrief uses the descriptor-derived default registry", async () => {
  const syntheticGithubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
  const brief = await buildBrief({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1809,
    analyzers: ["secret"],
    files: [
      {
        path: "src/config.ts",
        patch: `@@ -1,0 +1,1 @@\n+const token = "${syntheticGithubToken}";`,
      },
    ],
  });

  assert.equal(brief.partial, false);
  assert.equal(brief.analyzerStatus.secret, "ok");
  assert.equal(brief.findings.secret?.[0]?.kind, "github_token");
  assert.match(brief.promptSection, /Potential leaked secrets/);
  assert.equal(brief.analyzerStatus.dependency, "skipped");
});

test("secret analyzer scans added lines beyond shared context cap", async () => {
  const syntheticGithubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
  const paddedPatch = [
    "@@ -1,0 +1,5001 @@",
    ...Array.from({ length: 5000 }, (_, index) => `+const harmless${index} = ${index};`),
    `+const token = "${syntheticGithubToken}";`,
  ].join("\n");

  const brief = await buildBrief({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1809,
    analyzers: ["secret"],
    files: [
      {
        path: "src/padded-secret.ts",
        patch: paddedPatch,
      },
    ],
  });

  assert.equal(brief.partial, false);
  assert.equal(brief.analyzerStatus.secret, "ok");
  assert.deepEqual(brief.findings.secret, [
    {
      file: "src/padded-secret.ts",
      line: 5001,
      kind: "github_token",
      confidence: "high",
    },
  ]);
  assert.match(brief.promptSection, /src\/padded-secret\.ts:5001/);
});

test("migrated analyzers own their prompt rendering through descriptors", () => {
  assert.equal(typeof getAnalyzerDescriptor("dependency")?.render, "function");
  assert.equal(typeof getAnalyzerDescriptor("secret")?.render, "function");

  const { promptSection } = renderBrief({
    dependency: [
      {
        ecosystem: "npm",
        package: "lodash",
        from: "4.17.20",
        to: "4.17.21",
        direction: "change",
        cves: [
          {
            id: "GHSA-test",
            severity: "high",
            summary: "Prototype pollution in dependency",
            fixedIn: "4.17.22",
          },
        ],
      },
    ],
    secret: [
      {
        file: "src/config.ts",
        line: 7,
        kind: "github_token",
        confidence: "high",
      },
    ],
  });

  assert.match(promptSection, /Dependency vulnerabilities/);
  assert.match(promptSection, /Potential leaked secrets/);
  assert.match(promptSection, /GHSA-test/);
  assert.match(promptSection, /src\/config\.ts:7/);
});
