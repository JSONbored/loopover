import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readWorkflowStep(name: string): { run: string } {
  const workflow = parse(readFileSync(".github/workflows/release-selfhost.yml", "utf8")) as {
    jobs: { release: { steps: Array<{ name?: string; run?: string }> } };
  };
  const step = workflow.jobs.release.steps.find((s) => s.name === name);
  if (!step?.run) throw new Error(`step "${name}" not found or has no run: block`);
  return { run: step.run };
}

// #1937: executes the ACTUAL bash from the "Resolve version" step (extracted straight out of the committed
// workflow YAML, not a re-derived copy) against a real GITHUB_OUTPUT file, so a regex/logic regression here
// fails this test rather than only surfacing on an actual tag push.
function resolveVersion(env: { EVENT_NAME: string; INPUT_VERSION: string; REF_NAME: string }): { status: number; outputs: Record<string, string>; stderr: string } {
  const { run } = readWorkflowStep("Resolve version");
  const dir = mkdtempSync(join(tmpdir(), "gtorb-version-"));
  tmpDirs.push(dir);
  const outputFile = join(dir, "github_output");
  writeFileSync(outputFile, "");
  try {
    execFileSync("bash", ["-c", run], {
      encoding: "utf8",
      env: { ...process.env, ...env, GITHUB_OUTPUT: outputFile },
    });
    const outputs = parseGithubOutput(readFileSync(outputFile, "utf8"));
    return { status: 0, outputs, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? 1, outputs: {}, stderr: e.stderr ?? "" };
  }
}

function parseGithubOutput(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

describe("release-selfhost.yml \"Resolve version\" step (#1937)", () => {
  it("accepts a stable semver tag and marks it non-prerelease", () => {
    const r = resolveVersion({ EVENT_NAME: "push", INPUT_VERSION: "", REF_NAME: "orb-v0.1.0" });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({ v: "0.1.0", tag: "orb-v0.1.0", release: "gittensory-orb@0.1.0", prerelease: "false" });
  });

  it.each(["rc", "beta"])("accepts an -%s.N prerelease tag and marks it prerelease", (kind) => {
    const r = resolveVersion({ EVENT_NAME: "push", INPUT_VERSION: "", REF_NAME: `orb-v0.1.0-${kind}.1` });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({ v: `0.1.0-${kind}.1`, tag: `orb-v0.1.0-${kind}.1`, prerelease: "true" });
  });

  it("resolves the version from workflow_dispatch input instead of the ref when dispatched manually", () => {
    const r = resolveVersion({ EVENT_NAME: "workflow_dispatch", INPUT_VERSION: "0.2.0-rc.3", REF_NAME: "main" });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({ v: "0.2.0-rc.3", tag: "orb-v0.2.0-rc.3", prerelease: "true" });
  });

  it("rejects a non-orb-v tag on push", () => {
    const r = resolveVersion({ EVENT_NAME: "push", INPUT_VERSION: "", REF_NAME: "v0.1.0" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("expected an orb-v<semver> tag");
  });

  it.each(["0.1", "0.1.0.0", "0.1.0-alpha.1", "0.1.0-rc", "0.1.0-rc.", "not-a-version"])(
    "rejects a malformed or unsupported-prerelease-kind version: %s",
    (version) => {
      const r = resolveVersion({ EVENT_NAME: "push", INPUT_VERSION: "", REF_NAME: `orb-v${version}` });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("expected semver version");
    },
  );
});

describe("release-selfhost.yml \"Resolve image tags\" step (#1937)", () => {
  function resolveTags(env: { PRERELEASE: string; VERSION_TAG: string }): { list: string } {
    const { run } = readWorkflowStep("Resolve image tags");
    const dir = mkdtempSync(join(tmpdir(), "gtorb-tags-"));
    tmpDirs.push(dir);
    const outputFile = join(dir, "github_output");
    writeFileSync(outputFile, "");
    execFileSync("bash", ["-c", run], { encoding: "utf8", env: { ...process.env, ...env, GITHUB_OUTPUT: outputFile } });
    // GITHUB_OUTPUT's heredoc multiline form (`key<<EOF\n...\nEOF`) needs its own parse, distinct from the
    // simple `key=value` lines parseGithubOutput handles for the single-line "Resolve version" outputs.
    const content = readFileSync(outputFile, "utf8");
    const match = /^list<<GTORBTAGS\n([\s\S]*?)\nGTORBTAGS$/m.exec(content);
    if (!match) throw new Error(`could not parse multiline "list" output from:\n${content}`);
    return { list: match[1]! };
  }

  it("includes the latest tag for a stable version", () => {
    const { list } = resolveTags({ PRERELEASE: "false", VERSION_TAG: "orb-v0.1.0" });
    expect(list).toBe("type=raw,value=orb-v0.1.0\ntype=raw,value=latest\ntype=sha,format=short");
  });

  it("omits the latest tag for a prerelease version", () => {
    const { list } = resolveTags({ PRERELEASE: "true", VERSION_TAG: "orb-v0.1.0-rc.1" });
    expect(list).toBe("type=raw,value=orb-v0.1.0-rc.1\ntype=sha,format=short");
    expect(list).not.toContain("latest");
  });
});

describe("release-selfhost.yml GitHub Release step (#1937)", () => {
  it("computes --prerelease --latest=false gh flags only when PRERELEASE is true", () => {
    const { run } = readWorkflowStep("GitHub Release");
    expect(run).toContain("PRERELEASE_ARGS=(--prerelease --latest=false)");
    expect(run).toContain('if [ "$PRERELEASE" = "true" ]; then');
    // Both gh invocations expand the resolved args array rather than hard-coding the flags inline, so a
    // stable release's empty PRERELEASE_ARGS produces byte-identical behavior to before this change.
    expect(run).toContain('"${PRERELEASE_ARGS[@]}"');
  });

  it("threads the prerelease flag into both gh release create and gh release edit", () => {
    const { run } = readWorkflowStep("GitHub Release");
    const createIndex = run.indexOf("gh release create");
    const editIndex = run.indexOf("gh release edit");
    expect(editIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(editIndex);
    expect(run.slice(editIndex, createIndex)).toContain('"${PRERELEASE_ARGS[@]}"');
    expect(run.slice(createIndex)).toContain('"${PRERELEASE_ARGS[@]}"');
  });
});
