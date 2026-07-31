import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROVENANCE_INPUT,
  declaresProvenanceInput,
  dispatchesMissingFlag,
  runNameValue,
  stampProblems,
} from "../../scripts/check-dispatch-provenance-stamped";
import { AUTOMATION_RUN_NAME_MARKER } from "../../scripts/escalate-workflow-outage";

// #10234. The provenance stamp is a two-sided string with NO runtime symptom when the sides drift: the
// escalation just reads every automated run as manual and goes quiet forever, while still looking wired.
// These pin the checker that asserts the lockstep, and the last block pins the real workflow files.

const MARKER = AUTOMATION_RUN_NAME_MARKER;

const STAMPED_WORKFLOW = `name: Publish Miner Package
on:
  workflow_dispatch:
    inputs:
      ${PROVENANCE_INPUT}:
        type: boolean
        default: false

run-name: "Publish Miner Package\${{ inputs.${PROVENANCE_INPUT} && ' ${MARKER}' || '' }}"
`;

describe("declaresProvenanceInput", () => {
  it("detects the input regardless of how deeply it is indented", () => {
    expect(declaresProvenanceInput(STAMPED_WORKFLOW)).toBe(true);
    expect(declaresProvenanceInput(`on:\n  workflow_dispatch:\n    inputs:\n      ${PROVENANCE_INPUT}:\n`)).toBe(true);
  });

  it("is false for a workflow that does not opt in", () => {
    expect(declaresProvenanceInput("name: self-host\non:\n  push:\n    branches: [main]\n")).toBe(false);
  });

  it("does not match a mere prose mention of the input name", () => {
    // The publish workflows discuss the input in comments right above it; a comment must not be read as a
    // declaration, or a workflow could pass by talking about the stamp without having one.
    expect(declaresProvenanceInput(`# see ${PROVENANCE_INPUT}: below for why\n`)).toBe(false);
  });
});

describe("runNameValue", () => {
  it("reads the top-level run-name", () => {
    expect(runNameValue(STAMPED_WORKFLOW)).toBe(`"Publish Miner Package\${{ inputs.${PROVENANCE_INPUT} && ' ${MARKER}' || '' }}"`);
  });

  it("is undefined when there is none", () => {
    expect(runNameValue("name: x\non:\n  push:\n")).toBeUndefined();
  });

  it("only matches at column 0, so a nested key is not mistaken for the workflow's run name", () => {
    expect(runNameValue("jobs:\n  a:\n    run-name: nope\n")).toBeUndefined();
  });
});

describe("stampProblems", () => {
  it("is silent for a correctly stamped workflow", () => {
    expect(stampProblems(STAMPED_WORKFLOW, MARKER)).toEqual([]);
  });

  it("is silent for a workflow that does not opt in at all", () => {
    // selfhost.yml is push-triggered and has no dispatch ambiguity. Demanding a stamp there would be noise.
    expect(stampProblems("name: self-host\non:\n  push:\n", MARKER)).toEqual([]);
  });

  it("catches an opted-in workflow with no run-name — the stamp reaches display_title via nothing else", () => {
    const text = STAMPED_WORKFLOW.replace(/^run-name:.*$/m, "");
    expect(stampProblems(text, MARKER)).toHaveLength(1);
    expect(stampProblems(text, MARKER)[0]).toContain("no top-level `run-name:`");
  });

  it("catches a run-name whose marker drifted from the script's constant", () => {
    const text = STAMPED_WORKFLOW.replace(MARKER, "[auto]");
    expect(stampProblems(text, MARKER).join(" ")).toContain(MARKER);
  });

  it("catches an UNCONDITIONAL marker, which would stamp a human's dispatch as automated", () => {
    // The subtle inversion: the stamp is present, the checker's first rule passes, and every manual run now
    // reads as automated -- restoring the #10171 false alarm the whole change exists to remove.
    const text = STAMPED_WORKFLOW.replace(/^run-name:.*$/m, `run-name: "Publish Miner Package ${MARKER}"`);
    const problems = stampProblems(text, MARKER);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`inputs.${PROVENANCE_INPUT}`);
  });
});

describe("dispatchesMissingFlag", () => {
  const stamped = new Set(["publish-miner.yml"]);

  it("accepts a dispatch that passes the flag", () => {
    expect(dispatchesMissingFlag(`run: gh workflow run publish-miner.yml -f ${PROVENANCE_INPUT}=true\n`, stamped)).toEqual([]);
  });

  it("catches a stamped workflow dispatched without the flag", () => {
    expect(dispatchesMissingFlag("run: gh workflow run publish-miner.yml --ref x\n", stamped)).toEqual(["publish-miner.yml"]);
  });

  it("ignores a dispatch of a workflow that has no provenance input", () => {
    // orb-beta-release.yml dispatches release-selfhost.yml, which is not part of this mechanism at all.
    expect(dispatchesMissingFlag("run: gh workflow run release-selfhost.yml --ref x\n", stamped)).toEqual([]);
  });

  it("requires the flag for a runtime-resolved target, because the reconcile path is the one that matters", () => {
    // `gh workflow run "$workflow"` cannot be resolved statically, and it is precisely the call site that
    // wraps the escalation. Requiring the flag unconditionally there is the deliberate conservative choice.
    expect(dispatchesMissingFlag('run: gh workflow run "$workflow" --repo "$R"\n', stamped)).toEqual(["$workflow"]);
    expect(dispatchesMissingFlag(`run: gh workflow run "$workflow" -f ${PROVENANCE_INPUT}=true\n`, stamped)).toEqual([]);
  });

  it("does not read a commented mention of `gh workflow run` as a dispatch", () => {
    // These workflow files discuss `gh workflow run` at length in prose. Treating a comment as a call site
    // would make the check unsatisfiable.
    expect(dispatchesMissingFlag("# a bare `gh workflow run publish-miner.yml` is the human override path\n", stamped)).toEqual([]);
  });

  it("strips quotes from the target before matching", () => {
    expect(dispatchesMissingFlag('run: gh workflow run "publish-miner.yml"\n', stamped)).toEqual(["publish-miner.yml"]);
  });

  it("returns nothing for text containing no dispatch at all", () => {
    expect(dispatchesMissingFlag("name: x\non:\n  push:\n", stamped)).toEqual([]);
  });
});

describe("the real workflow files satisfy the invariant (#10234)", () => {
  const dir = ".github/workflows";
  const texts = new Map(
    readdirSync(dir)
      .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
      .map((entry) => [entry, readFileSync(join(dir, entry), "utf8")] as const),
  );
  const stamped = new Set([...texts].filter(([, text]) => declaresProvenanceInput(text)).map(([file]) => file));

  it("stamps all five publish workflows and nothing else", () => {
    // Pinned as an exact set: a sixth publisher added without a stamp is invisible to the escalation, and a
    // stamp appearing on an unrelated workflow means someone copied the block without the dispatch side.
    expect([...stamped].sort()).toEqual([
      "publish-contract.yml",
      "publish-engine.yml",
      "publish-mcp.yml",
      "publish-miner.yml",
      "publish-ui-kit.yml",
    ]);
  });

  it("has no stamp problems and no unflagged dispatch in any workflow", () => {
    const failures: string[] = [];
    for (const [file, text] of texts) {
      for (const problem of stampProblems(text, MARKER)) failures.push(`${file}: ${problem}`);
      for (const target of dispatchesMissingFlag(text, stamped)) failures.push(`${file}: ${target} missing the flag`);
    }
    expect(failures).toEqual([]);
  });
});
