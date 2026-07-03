import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/selfhost/setup-wizard";

const DOCS_PATH = "apps/gittensory-ui/src/routes/docs.self-hosting-github-app.tsx";

// docs.self-hosting-github-app.tsx claims its manual permission list "is generated from the identical
// source the wizard's manifest uses, so the two can never drift apart again" (#2542). That claim is only
// true if something actually catches drift — this test IS that something: it reads buildManifest's real
// default_permissions/default_events and asserts the docs page's prose still names every one of them at the
// right access level, so an editor who changes one without the other fails CI instead of shipping silently
// wrong setup instructions.
const PERMISSION_LABELS: Record<string, string> = {
  pull_requests: "Pull requests",
  checks: "Checks",
  issues: "Issues",
  contents: "Contents",
  statuses: "Commit statuses",
  metadata: "Metadata",
  actions: "Actions",
};

describe("self-host GitHub App manifest <-> docs parity (#2542)", () => {
  it("the docs page's manual permission list names every buildManifest permission at the correct access level", () => {
    const manifest = buildManifest("https://example.com", "state") as { default_permissions: Record<string, string> };
    const docsSource = readFileSync(DOCS_PATH, "utf8");

    expect(Object.keys(manifest.default_permissions).sort()).toEqual(Object.keys(PERMISSION_LABELS).sort());
    for (const [key, level] of Object.entries(manifest.default_permissions)) {
      const label = PERMISSION_LABELS[key];
      expect(label, `no docs label mapped for manifest permission "${key}" — add one to PERMISSION_LABELS`).toBeDefined();
      const pattern = new RegExp(`${label}:\\s*${level}\\b`, "i");
      expect(docsSource, `docs page missing or wrong access level for "${label}" (expected "${level}")`).toMatch(pattern);
    }
  });

  it("the docs page's events sentence names every buildManifest default_event, and only those", () => {
    // Scoped to the "Events: ...." sentence specifically — a bare substring search (e.g. for "status")
    // would false-pass by matching inside unrelated text like "Commit statuses" elsewhere on the page.
    const manifest = buildManifest("https://example.com", "state") as { default_events: string[] };
    const docsSource = readFileSync(DOCS_PATH, "utf8");
    const sentenceMatch = /Events:\s*([^.]+)\./.exec(docsSource);
    expect(sentenceMatch, "docs page has no \"Events: ...\" sentence to check").not.toBeNull();
    const eventsSentence = sentenceMatch![1]!;
    const docsEvents = eventsSentence
      .split(",")
      .map((s) => s.replace(/\band\b/i, "").trim().toLowerCase())
      .filter(Boolean);

    const manifestEvents = manifest.default_events.map((e) => e.replace(/_/g, " "));
    expect(docsEvents.sort()).toEqual(manifestEvents.sort());
  });
});
