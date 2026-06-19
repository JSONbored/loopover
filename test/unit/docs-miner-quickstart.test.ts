import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MINER_QUICKSTART_PATH = resolve(
  import.meta.dirname,
  "../../apps/gittensory-ui/src/routes/docs.miner-quickstart.tsx",
);

describe("docs miner quickstart page", () => {
  const source = readFileSync(MINER_QUICKSTART_PATH, "utf8");
  const normalizedSource = source.replace(/\s+/g, " ");

  it("documents the full miner loop: install, auth, doctor, plan, preflight, packet", () => {
    expect(source).toMatch(/@jsonbored\/gittensory-mcp/);
    expect(source).toMatch(/gittensory-mcp login/);
    expect(source).toMatch(/gittensory-mcp whoami/);
    expect(source).toMatch(/gittensory-mcp status/);
    expect(source).toMatch(/gittensory-mcp doctor/);
    expect(source).toMatch(/agent plan --login/);
    expect(source).toMatch(/gittensory-mcp preflight --login/);
    expect(source).toMatch(/agent packet --login/);
  });

  it("uses CLI commands that match the current MCP package syntax", () => {
    // Real flags from `gittensory-mcp --help` — guards against drift in documented syntax.
    expect(source).toMatch(/--repo owner\/repo/);
    expect(source).toMatch(/--base origin\/main/);
    expect(source).toMatch(/--branch-eligibility eligible/);
    expect(source).toMatch(/--pending-merged-prs/);
    expect(source).toMatch(/--expected-open-prs/);
    expect(source).toMatch(/repo-decision --login/);
    expect(source).toMatch(/decision-pack --login/);
    expect(source).toMatch(/analyze-branch --login/);
  });

  it("organizes the quickstart by contribution lane", () => {
    expect(source).toMatch(/Direct PR lane/);
    expect(source).toMatch(/Issue-solving PR lane/);
    expect(source).toMatch(/Issue discovery lane/);
    expect(source).toMatch(/Docs and context work/);
    expect(source).toMatch(/Repo-specific lanes/);
    expect(source).toMatch(/Choose your lane/);
  });

  it("maps lanes to the repo's configured participation lane from code", () => {
    // These must match ParticipationLane in src/signals/engine.ts so the doc reflects real config.
    expect(source).toMatch(/direct_pr/);
    expect(source).toMatch(/issue_discovery/);
    expect(source).toMatch(/split/);
    expect(source).toMatch(/inactive/);
    expect(source).toMatch(/unknown/);
  });

  it("includes JSON-output notes for automation on every command", () => {
    expect(source).toMatch(/--json/);
    expect(normalizedSource).toMatch(/machine-readable output/i);
  });

  it("documents the local privacy boundary and packet redaction", () => {
    expect(normalizedSource).toMatch(/source never leaves your machine/i);
    expect(source).toMatch(/GITTENSORY_UPLOAD_SOURCE=false/);
    expect(source).toMatch(/local absolute paths are redacted/i);
    expect(source).toMatch(/public-safe/i);
    expect(normalizedSource).toMatch(/scrubbed of economic and identity signals/i);
  });

  it("documents validation expectations with the real --validation flag", () => {
    expect(source).toMatch(/Validation expectations/);
    expect(source).toMatch(/--validation/);
  });

  it("avoids reward guarantees and public score-prediction language", () => {
    expect(source).toMatch(/makes no earnings\s+promises/i);
    expect(source).toMatch(/never predicts a public number/i);
    expect(source).not.toMatch(/you will (earn|receive|get)/i);
    expect(source).not.toMatch(/guaranteed (reward|payout|score)/i);
    expect(source).not.toMatch(/predict(s|ed)?\s+your\s+score/i);
    // Identity secrets must never appear in onboarding copy or examples.
    expect(source).not.toMatch(/seed phrase|mnemonic|private key/i);
  });
});
