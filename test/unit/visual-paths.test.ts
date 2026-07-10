import { describe, expect, it } from "vitest";
import { isVisualPath } from "../../src/review/visual/paths";

describe("isVisualPath (web-visible-only capture gate)", () => {
  it("matches frontend app paths (apps/gittensory-ui/**)", () => {
    expect(isVisualPath("apps/gittensory-ui/src/routes/index.tsx")).toBe(true);
    expect(isVisualPath("apps/gittensory-ui/src/routes/app.analytics.tsx")).toBe(true);
    // Even a non-source file under the UI app is web-visible scope.
    expect(isVisualPath("apps/gittensory-ui/public/og.png")).toBe(true);
    expect(isVisualPath("apps/gittensory-ui/README.md")).toBe(true);
  });

  it("matches ANY app folder, not just gittensory-ui (#3611 follow-up — e.g. metagraphed's apps/ui/**)", () => {
    expect(isVisualPath("apps/ui/src/routes/index.tsx")).toBe(true);
    // Same non-extension-matching-file case as gittensory-ui above, now for a different app folder name.
    expect(isVisualPath("apps/ui/components.json")).toBe(true);
    expect(isVisualPath("apps/marketing-site/README.md")).toBe(true);
  });

  it("matches public asset paths (public/** — OG images etc.) at any depth", () => {
    expect(isVisualPath("public/og-image.png")).toBe(true);
    expect(isVisualPath("apps/web/public/banner.jpg")).toBe(true);
    expect(isVisualPath("packages/site/public/favicon.ico")).toBe(true);
  });

  it("matches front-of-house source extensions anywhere", () => {
    for (const path of [
      "src/components/Button.tsx",
      "src/Button.jsx",
      "src/styles/main.css",
      "src/styles/theme.scss",
      "src/styles/legacy.sass",
      "src/styles/old.less",
      "site/index.html",
      "assets/logo.svg",
      "src/pages/home.astro",
      "src/App.vue",
      "src/Widget.svelte",
      "docs/guide.mdx",
    ]) {
      expect(isVisualPath(path), path).toBe(true);
    }
  });

  it("does NOT match backend / non-web files (the emphatic constraint)", () => {
    for (const path of [
      "src/queue/processors.ts",
      "src/review/visual/paths.ts",
      "README.md",
      "package.json",
      "wrangler.jsonc",
      "scripts/build.py",
      "src/types.d.ts",
      "go.mod",
      "Cargo.toml",
      "src/data/seed.sql",
      "config.yaml",
    ]) {
      expect(isVisualPath(path), path).toBe(false);
    }
  });

  it("is case-insensitive on extensions and the app prefix", () => {
    expect(isVisualPath("APPS/GITTENSORY-UI/src/Page.TSX")).toBe(true);
    expect(isVisualPath("src/Icon.SVG")).toBe(true);
    // A .ts (backend) must still be false even upper-cased — it is not a web-visible extension.
    expect(isVisualPath("src/Worker.TS")).toBe(false);
  });
});
