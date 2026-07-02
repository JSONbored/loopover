import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

// `npm run ui:build` also regenerates apps/gittensory-ui/public/openapi.json. Both call sites below
// chain it immediately after `ui:openapi:check`, which just proved the committed spec is already fresh --
// regenerating it again is pure repeat work. These assert the two split commands stay in place instead of
// the aggregate `ui:build` script sneaking back in (ui:build itself is untouched for standalone callers).
describe("UI build steps skip the redundant OpenAPI regen", () => {
  it("ci.yml's UI build step runs the split commands, not the aggregate ui:build script", () => {
    const workflow = read(".github/workflows/ci.yml");
    const stepStart = workflow.indexOf("- name: UI build");
    expect(stepStart).toBeGreaterThan(-1);
    const stepEnd = workflow.indexOf("\n\n", stepStart);
    const step = workflow.slice(stepStart, stepEnd === -1 ? undefined : stepEnd);

    expect(step).toContain("run: npm run extension:build && npm --workspace @jsonbored/gittensory-ui run build");
    expect(step).not.toContain("npm run ui:build");
  });

  it("ui-deploy.yml's Validate frontend step runs the split commands after the openapi check", () => {
    const workflow = read(".github/workflows/ui-deploy.yml");

    expect(workflow).toContain(
      "run: npm run ui:openapi:check && npm run ui:lint && npm run ui:typecheck && npm run extension:build && npm --workspace @jsonbored/gittensory-ui run build",
    );
    expect(workflow).not.toContain("&& npm run ui:build");
  });
});
