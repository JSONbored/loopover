import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Regression for #5937: three self-host/ops docs still referenced pre-rename `gittensory-*` names that no
// longer exist (a dead timer name, a dead cross-repo link, a stale env filename). Each file is grepped for
// the exact stale string and the verified-correct replacement, following the config-drift pattern in
// test/unit/miner-docker-compose.test.ts.
const SELF_HOSTING_OPS_DOC = join(
  process.cwd(),
  "apps/loopover-ui/src/routes/docs.self-hosting-operations.tsx",
);
const TERRAFORM_MAIN = join(process.cwd(), "packages/loopover-miner/terraform/main.tf");
const CAPABILITY_AUDIT_DOC = join(process.cwd(), "src/review/repo-agnostic-capability-audit.md");

describe("self-host ops docs rename residue (#5937)", () => {
  it("names the real loopover-docker-prune timer, not the dead loopover-docker-safe-prune one", () => {
    const doc = readFileSync(SELF_HOSTING_OPS_DOC, "utf8");
    expect(doc).not.toContain("loopover-docker-safe-prune");
    expect(doc).toContain("loopover-docker-prune");
  });

  it("points the terraform module's header comment at the real env filename, not .gittensory-miner.env", () => {
    const tf = readFileSync(TERRAFORM_MAIN, "utf8");
    expect(tf).not.toContain(".gittensory-miner.env");
    expect(tf).toContain(".loopover-miner.env.example");
  });

  it("links the capability audit doc at the real post-rename packages/loopover-miner path", () => {
    const audit = readFileSync(CAPABILITY_AUDIT_DOC, "utf8");
    expect(audit).not.toContain("packages/gittensory-miner/");
    expect(audit).toContain(
      "packages/loopover-miner/docs/repo-agnostic-capability-audit.md",
    );
  });
});
