import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Drift guard (#1823): the self-host update/rollback docs must stay aligned with the shipped deploy
// scripts and the post-update verification helper.

const OPERATIONS = "apps/gittensory-ui/src/routes/docs.self-hosting-operations.tsx";
const IMAGE_SCRIPT = "scripts/deploy-selfhost-image.sh";
const PREBUILT_SCRIPT = "scripts/deploy-selfhost-prebuilt.sh";
const POST_UPDATE_SCRIPT = "scripts/selfhost-post-update-check.sh";

const operations = readFileSync(OPERATIONS, "utf8");
const imageScript = readFileSync(IMAGE_SCRIPT, "utf8");
const prebuiltScript = readFileSync(PREBUILT_SCRIPT, "utf8");
const postUpdateScript = readFileSync(POST_UPDATE_SCRIPT, "utf8");

describe("self-host update + rollback docs (#1823)", () => {
  it("documents both deploy paths, operator-owned paths, and the post-update helper", () => {
    expect(operations).toContain("deploy-selfhost-image.sh");
    expect(operations).toContain("deploy-selfhost-prebuilt.sh");
    expect(operations).toContain("selfhost-post-update-check.sh");
    expect(operations).toContain("Preflight checklist");
    expect(operations).toContain("Post-update checklist");
    expect(operations).toContain("Operator-owned");
    expect(operations).toContain("gittensory-config/");
    expect(operations).toContain("gittensory-data");
    expect(operations).toContain("Migrations are forward-only");
  });

  it("deploy scripts restart only gittensory with --no-deps", () => {
    expect(imageScript).toContain('up -d --no-build --no-deps "$SERVICE"');
    expect(prebuiltScript).toContain('up -d --no-deps "$SERVICE"');
  });

  it("post-update script probes /ready without mutating operator-owned state", () => {
    expect(postUpdateScript).toContain("/ready");
    expect(postUpdateScript).toContain("GITTENSORY_IMAGE");
    expect(postUpdateScript).toContain("GITTENSORY_VERSION");
    expect(postUpdateScript).toContain("SENTRY_RELEASE");
    expect(postUpdateScript).not.toContain("env_put");
    expect(postUpdateScript).not.toContain("docker compose down");
  });
});
