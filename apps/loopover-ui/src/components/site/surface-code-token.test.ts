import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #6820: `bg-[oklch(0.13_0.005_260)]` (the always-dark code-surface color) was copy-pasted across
// 4 call sites in 3 unrelated files with no shared token. These lock in the `bg-surface-code`
// utility (backed by `--surface-code` in theme.css) as the one place that color is now defined.
const THEME_CSS_PATH = "../../packages/loopover-ui-kit/src/theme.css";
const CALL_SITES = [
  "src/components/site/control-primitives.tsx",
  "src/components/site/app-panels/maintainer-panel.tsx",
  "src/components/site/api/try-it.tsx",
];

describe("surface-code design token (#6820)", () => {
  it("defines --surface-code once and maps it through @theme inline", () => {
    const css = readFileSync(THEME_CSS_PATH, "utf8");
    expect(css).toContain("--surface-code: oklch(0.13 0.005 260);");
    expect(css).toContain("--color-surface-code: var(--surface-code);");
  });

  it("is not redefined inside the .dark block, so it renders identically in both themes", () => {
    const css = readFileSync(THEME_CSS_PATH, "utf8");
    const darkBlockStart = css.indexOf(".dark {");
    const darkBlockEnd = css.indexOf("\n}", darkBlockStart);
    const darkBlock = css.slice(darkBlockStart, darkBlockEnd);
    expect(darkBlockStart).toBeGreaterThan(-1);
    expect(darkBlock).not.toContain("--surface-code");
  });

  it.each(CALL_SITES)(
    "uses the shared bg-surface-code utility, not a raw literal, in %s",
    (path) => {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("bg-surface-code");
      expect(source).not.toContain("oklch(0.13_0.005_260)");
      expect(source).not.toContain("oklch(0.13 0.005 260)");
    },
  );
});
