import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { compareRouteScreenshots, compareVisualCaptureSets } from "../../src/visual-agent/visual-diff";

function createSolidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      png.data[idx] = rgba[0];
      png.data[idx + 1] = rgba[1];
      png.data[idx + 2] = rgba[2];
      png.data[idx + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}

function createCheckerPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      const light = (x + y) % 2 === 0;
      png.data[idx] = light ? 240 : 20;
      png.data[idx + 1] = light ? 240 : 20;
      png.data[idx + 2] = light ? 240 : 20;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("visual diff quantification", () => {
  it("marks identical routes unchanged without a diff image", () => {
    const png = createSolidPng(32, 24, [10, 20, 30, 255]);
    const result = compareRouteScreenshots({ route: "/app", before: png, after: png });
    expect(result).toMatchObject({ status: "unchanged", changedPixelPercent: 0, diffImagePng: null });
  });

  it("flags real visual changes with a diff image and changed-pixel percentage", () => {
    const before = createSolidPng(40, 30, [255, 255, 255, 255]);
    const after = createSolidPng(40, 30, [0, 0, 0, 255]);
    const result = compareRouteScreenshots({ route: "/app", before, after });
    expect(result.status).toBe("changed");
    expect(result.changedPixelPercent).toBe(100);
    expect(result.diffImagePng).toBeInstanceOf(Buffer);
    expect(result.diffImagePng?.length).toBeGreaterThan(0);
  });

  it("suppresses sub-threshold noise as unchanged", () => {
    const before = createSolidPng(100, 100, [250, 250, 250, 255]);
    const afterPng = new PNG({ width: 100, height: 100 });
    afterPng.data.set(PNG.sync.read(before).data);
    afterPng.data[400] = 240;
    const after = PNG.sync.write(afterPng);
    const noisy = compareRouteScreenshots({
      route: "/app",
      before,
      after,
      options: { changeThresholdPercent: 1 },
    });
    expect(noisy.status).toBe("unchanged");
    expect((noisy.changedPixelPercent ?? 0)).toBeLessThan(1);
  });

  it("classifies new and removed routes", () => {
    const beforeOnly = createSolidPng(20, 20, [100, 100, 100, 255]);
    const afterOnly = createSolidPng(20, 20, [200, 200, 200, 255]);
    expect(compareRouteScreenshots({ route: "/removed", before: beforeOnly, after: null })).toMatchObject({
      status: "removed",
      changedPixelPercent: null,
    });
    expect(compareRouteScreenshots({ route: "/new", before: null, after: afterOnly })).toMatchObject({
      status: "new",
      changedPixelPercent: null,
    });
  });

  it("summarizes mixed route sets with overall changed-pixel average", () => {
    const unchanged = createSolidPng(20, 20, [10, 10, 10, 255]);
    const beforeChanged = createSolidPng(20, 20, [255, 0, 0, 255]);
    const afterChanged = createSolidPng(20, 20, [0, 255, 0, 255]);
    const summary = compareVisualCaptureSets({
      before: {
        "/unchanged": unchanged,
        "/changed": beforeChanged,
        "/removed-only": createSolidPng(10, 10, [1, 2, 3, 255]),
      },
      after: {
        "/unchanged": unchanged,
        "/changed": afterChanged,
        "/new-only": createCheckerPng(10, 10),
      },
    });

    expect(summary.changedCount).toBe(1);
    expect(summary.unchangedCount).toBe(1);
    expect(summary.newCount).toBe(1);
    expect(summary.removedCount).toBe(1);
    expect(summary.routes.find((entry) => entry.route === "/changed")).toMatchObject({ status: "changed" });
    expect(summary.routes.find((entry) => entry.route === "/unchanged")).toMatchObject({ status: "unchanged" });
    expect(summary.summary).toMatch(/1 route\(s\) changed/i);
    expect(summary.overallChangedPixelPercent).toBeGreaterThan(0);
  });

  it("treats dimension mismatches as changed", () => {
    const before = createSolidPng(30, 20, [255, 255, 255, 255]);
    const after = createSolidPng(40, 20, [255, 255, 255, 255]);
    const result = compareRouteScreenshots({ route: "/app", before, after });
    expect(result).toMatchObject({ status: "changed", changedPixelPercent: 100, diffImagePng: null });
  });

  it("can omit diff images when requested", () => {
    const before = createSolidPng(10, 10, [255, 0, 0, 255]);
    const after = createSolidPng(10, 10, [0, 255, 0, 255]);
    const result = compareRouteScreenshots({
      route: "/app",
      before,
      after,
      options: { includeDiffImage: false },
    });
    expect(result.status).toBe("changed");
    expect(result.diffImagePng).toBeNull();
  });
});
