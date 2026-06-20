import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const OWNER_CHECKLIST_PATH = resolve(
  import.meta.dirname,
  "../../apps/gittensory-ui/src/routes/docs.owner-checklist.tsx",
);

describe("docs owner onboarding checklist page", () => {
  const source = readFileSync(OWNER_CHECKLIST_PATH, "utf8");
  const normalizedSource = source.replace(/\s+/g, " ");

  it("covers every required checklist dimension", () => {
    // Acceptance criteria for #254: repo policy, labels, issue quality, validation commands,
    // maintainer capacity, contribution lanes, and public/private boundaries.
    expect(source).toMatch(/checklist/i);
    expect(source).toMatch(/Repository registration/);
    expect(source).toMatch(/config quality/i);
    expect(source).toMatch(/Labels.*trusted pipeline/i);
    expect(source).toMatch(/Issue quality/i);
    expect(source).toMatch(/Contribution lanes/);
    expect(source).toMatch(/Validation expectations/i);
    expect(source).toMatch(/Maintainer capacity/i);
    expect(source).toMatch(/Public\/private boundaries/);
  });

  it("references the real owner-facing endpoints and agent profile", () => {
    expect(source).toMatch(/\/v1\/repos\/:owner\/:repo\/registration-readiness/);
    expect(source).toMatch(/\/v1\/repos\/:owner\/:repo\/gittensor-config-recommendation/);
    expect(source).toMatch(/\/v1\/repos\/:owner\/:repo\/settings-preview/);
    expect(source).toMatch(/repo-owner-intake/);
    expect(source).toMatch(/\.gittensory\.yml/);
  });

  it("uses the real contribution-lane taxonomy from the engine", () => {
    // Must match ParticipationLane in src/signals/engine.ts.
    expect(source).toMatch(/direct_pr/);
    expect(source).toMatch(/issue_discovery/);
    expect(source).toMatch(/split/);
    expect(source).toMatch(/inactive/);
    expect(source).toMatch(/unknown/);
  });

  it("states honest tradeoffs around maintainer burden and low-quality PR pressure", () => {
    expect(normalizedSource).toMatch(/honest tradeoff/i);
    expect(normalizedSource).toMatch(/low-quality PR pressure/i);
    expect(normalizedSource).toMatch(/triage load|more triage/i);
    expect(normalizedSource).toMatch(/maintainer (cut|lane)/i);
  });

  it("links to the owner workflow and the public/private boundary", () => {
    expect(source).toMatch(/\/app\/owner/);
    expect(source).toMatch(/\/docs\/beta-onboarding/);
    expect(source).toMatch(/\/docs\/privacy-security/);
  });

  it("documents the public/private boundary and quiet-by-default behavior", () => {
    expect(normalizedSource).toMatch(/quiet by default/i);
    expect(source).toMatch(/publicSurface/);
    expect(normalizedSource).toMatch(/run through the sanitizer|through the sanitizer/i);
  });

  it("avoids reward guarantees, score predictions, and secret material", () => {
    expect(source).not.toMatch(/guaranteed (reward|payout|score)/i);
    expect(source).not.toMatch(/you will (earn|receive|get)/i);
    expect(source).not.toMatch(/predict(s|ed)?\s+your\s+score/i);
    expect(source).not.toMatch(/seed phrase|mnemonic|private key/i);
  });
});
