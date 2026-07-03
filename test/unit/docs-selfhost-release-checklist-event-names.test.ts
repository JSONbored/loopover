import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Drift guard (#1944): the beta release checklist and its smoke script reference exact selfhost_* log
// event names. If an event is ever renamed/removed in src/, this test fails instead of the checklist
// silently going stale -- mirrors docs-selfhost-troubleshooting-metric-names.test.ts's approach (#1943).

const DOC_PATH = "apps/gittensory-ui/src/routes/docs.self-hosting-release-checklist.tsx";
const SCRIPT_PATH = "scripts/smoke-selfhost.sh";
const doc = readFileSync(DOC_PATH, "utf8");
const script = readFileSync(SCRIPT_PATH, "utf8");

// The exact source files that emit every selfhost_* event referenced in the checklist/script, per an
// audit against the real console.log/console.error({ event: "selfhost_..." }) call sites.
const EVENT_SOURCE_FILES = ["src/server.ts", "src/selfhost/ai.ts", "src/selfhost/monitored-work.ts"];
const eventSource = EVENT_SOURCE_FILES.map((path) => readFileSync(path, "utf8")).join("\n");

describe("self-hosting-release-checklist doc + smoke script: event names match source (#1944)", () => {
  it("every selfhost_* event name referenced in the checklist doc is actually emitted by the code", () => {
    const names = [...new Set([...doc.matchAll(/selfhost_[a-z_]+/g)].map((m) => m[0]))];
    expect(names.length).toBeGreaterThan(5); // sanity: the extraction found the checklist's real content
    const missing = names.filter((name) => !eventSource.includes(`event: "${name}"`) && !eventSource.includes(`event": "${name}"`));
    expect(missing).toEqual([]);
  });

  it("every selfhost_* event name referenced in the smoke script is actually emitted by the code", () => {
    const names = [...new Set([...script.matchAll(/selfhost_[a-z_]+/g)].map((m) => m[0]))];
    expect(names.length).toBeGreaterThan(0);
    const missing = names.filter((name) => !eventSource.includes(`event: "${name}"`) && !eventSource.includes(`event": "${name}"`));
    expect(missing).toEqual([]);
  });
});
