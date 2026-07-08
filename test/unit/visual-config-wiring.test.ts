import { describe, expect, it, vi } from "vitest";
import { resolveVisualCaptureConfig } from "../../src/queue/processors";
import { EMPTY_VISUAL_CONFIG, parseFocusManifest } from "../../src/signals/focus-manifest";
import * as focusManifestLoader from "../../src/signals/focus-manifest-loader";

describe("review.visual wiring (#3609 / #3610)", () => {
  it("resolves review.visual from the repo's focus manifest", async () => {
    const manifest = parseFocusManifest({
      review: {
        visual: {
          preview: { url_template: "https://pr-{number}.preview.example.com" },
          routes: { paths: ["/pricing"], max_routes: 3 },
        },
      },
    });
    const loadSpy = vi.spyOn(focusManifestLoader, "loadRepoFocusManifest").mockResolvedValue(manifest);

    await expect(resolveVisualCaptureConfig({} as Env, "acme/widgets")).resolves.toEqual({
      preview: { urlTemplate: "https://pr-{number}.preview.example.com" },
      routes: { paths: ["/pricing"], maxRoutes: 3 },
      themes: [],
      gif: false,
      enabled: null,
      themeStorageKey: null,
      actionsFallback: false,
    });
    expect(loadSpy).toHaveBeenCalledWith(expect.anything(), "acme/widgets");
    loadSpy.mockRestore();
  });

  it("yields the empty defaults when the manifest has no review.visual config", async () => {
    const loadSpy = vi.spyOn(focusManifestLoader, "loadRepoFocusManifest").mockResolvedValue(parseFocusManifest({}));
    await expect(resolveVisualCaptureConfig({} as Env, "acme/widgets")).resolves.toEqual({ ...EMPTY_VISUAL_CONFIG });
    loadSpy.mockRestore();
  });

  it("fails open to the empty defaults when the manifest load rejects", async () => {
    const loadSpy = vi.spyOn(focusManifestLoader, "loadRepoFocusManifest").mockRejectedValue(new Error("manifest unavailable"));
    await expect(resolveVisualCaptureConfig({} as Env, "acme/widgets")).resolves.toEqual({ ...EMPTY_VISUAL_CONFIG });
    loadSpy.mockRestore();
  });

  it("resolves a configured enabled: false from the repo's focus manifest (#4083)", async () => {
    const manifest = parseFocusManifest({ review: { visual: { enabled: false } } });
    const loadSpy = vi.spyOn(focusManifestLoader, "loadRepoFocusManifest").mockResolvedValue(manifest);
    await expect(resolveVisualCaptureConfig({} as Env, "acme/widgets")).resolves.toEqual({ ...EMPTY_VISUAL_CONFIG, enabled: false });
    loadSpy.mockRestore();
  });

  it("resolves a configured actions_fallback: true from the repo's focus manifest (#4112)", async () => {
    const manifest = parseFocusManifest({ review: { visual: { actions_fallback: true } } });
    const loadSpy = vi.spyOn(focusManifestLoader, "loadRepoFocusManifest").mockResolvedValue(manifest);
    await expect(resolveVisualCaptureConfig({} as Env, "acme/widgets")).resolves.toEqual({ ...EMPTY_VISUAL_CONFIG, actionsFallback: true });
    loadSpy.mockRestore();
  });
});
