import { describe, expect, it } from "vitest";
import {
  buildPerRepoRecapSection,
  type PerRepoRecapInput,
  type PerRepoRecapSource,
} from "../../src/services/maintainer-recap-per-repo";

const WINDOW = 7;

function repo(repoFullName: string, reviewed: number, merged = 0, closed = 0): PerRepoRecapInput {
  return { repoFullName, reviewed, merged, closed };
}

function source(repos: PerRepoRecapInput[], windowDays = WINDOW): PerRepoRecapSource {
  return { windowDays, repos };
}

describe("buildPerRepoRecapSection (#2241)", () => {
  it("sorts active repos by volume (reviewed) descending and excludes zero-activity repos", () => {
    const section = buildPerRepoRecapSection(
      source([
        repo("acme/small", 2, 1, 1),
        repo("acme/idle", 0, 0, 0), // zero-activity — must be excluded
        repo("acme/big", 10, 7, 3),
        repo("acme/mid", 5, 4, 1),
      ]),
    );

    expect(section.title).toBe("Per-repo");
    expect(section.rows.map((r) => r.repo)).toEqual(["acme/big", "acme/mid", "acme/small"]);
    expect(section.rows.map((r) => r.reviewed)).toEqual([10, 5, 2]);
    expect(section.remainder).toBe(0);
    expect(section.lines).toEqual([
      "acme/big: reviewed 10, merged 7, closed 3",
      "acme/mid: reviewed 5, merged 4, closed 1",
      "acme/small: reviewed 2, merged 1, closed 1",
    ]);
    // No "(+N more)" line when nothing is truncated (remainder === 0 arm).
    expect(section.lines.some((l) => /\+\d+ more/.test(l))).toBe(false);
  });

  it("breaks a volume tie by repo label ascending (deterministic — the localeCompare arm)", () => {
    // Equal `reviewed` forces the `|| a.repoFullName.localeCompare(b.repoFullName)` branch.
    const section = buildPerRepoRecapSection(
      source([repo("zeta/repo", 4), repo("alpha/repo", 4), repo("mid/repo", 4)]),
    );
    expect(section.rows.map((r) => r.repo)).toEqual(["alpha/repo", "mid/repo", "zeta/repo"]);
  });

  it("caps the list at 8 and reports the surplus via remainder + a (+N more) line", () => {
    // 10 active repos with distinct volumes ⇒ top 8 shown, remainder 2 (the remainder > 0 arm).
    const many = Array.from({ length: 10 }, (_, i) => repo(`acme/r${i}`, 100 - i, 1, 0));
    const section = buildPerRepoRecapSection(source(many));

    expect(section.rows).toHaveLength(8);
    expect(section.rows[0]?.repo).toBe("acme/r0"); // reviewed 100 — highest volume first
    expect(section.remainder).toBe(2);
    expect(section.lines).toHaveLength(9); // 8 rows + the remainder line
    expect(section.lines[8]).toBe("(+2 more)");
  });

  it("shows exactly 8 with no remainder line at the cap boundary (remainder === 0 boundary)", () => {
    const eight = Array.from({ length: 8 }, (_, i) => repo(`acme/r${i}`, 50 - i, 1, 0));
    const section = buildPerRepoRecapSection(source(eight));
    expect(section.rows).toHaveLength(8);
    expect(section.remainder).toBe(0);
    expect(section.lines.some((l) => /more/.test(l))).toBe(false);
  });

  it("emits a no-activity line when every repo is zero-activity (empty rows arm)", () => {
    const section = buildPerRepoRecapSection(source([repo("acme/idle", 0), repo("acme/quiet", 0)]));
    expect(section.rows).toEqual([]);
    expect(section.remainder).toBe(0);
    expect(section.lines).toEqual(["No repo activity in the last 7 day(s)."]);
  });

  it("emits a no-activity line for an empty repos list too (echoes the configured window)", () => {
    const section = buildPerRepoRecapSection(source([], 30));
    expect(section.lines).toEqual(["No repo activity in the last 30 day(s)."]);
  });

  it("redacts a local-path leak in a repo label before emitting (defense-in-depth)", () => {
    // A mis-shaped label that embeds an absolute local path must be scrubbed via PUBLIC_LOCAL_PATH_SCRUB_PATTERN.
    const section = buildPerRepoRecapSection(source([repo("/tmp/evil-checkout/gittensory", 3, 2, 1)]));
    expect(section.rows[0]?.repo).toBe("<redacted-path>");
    expect(section.lines[0]).toBe("<redacted-path>: reviewed 3, merged 2, closed 1");
    for (const line of section.lines) {
      expect(line).not.toMatch(/\/tmp\//);
    }
  });
});
