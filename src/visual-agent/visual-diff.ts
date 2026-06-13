import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export type VisualRouteStatus = "changed" | "unchanged" | "new" | "removed";

export type VisualDiffOptions = {
  /** Pixelmatch anti-alias tolerance (0–1). Default 0.1. */
  threshold?: number;
  /** Routes below this changed-pixel % are treated as unchanged noise. Default 0.05. */
  changeThresholdPercent?: number;
  /** Include diff PNG bytes for changed routes. Default true. */
  includeDiffImage?: boolean;
};

export type VisualRouteComparison = {
  route: string;
  status: VisualRouteStatus;
  changedPixelPercent: number | null;
  width: number | null;
  height: number | null;
  diffImagePng: Buffer | null;
};

export type VisualDiffSummary = {
  generatedAt: string;
  routes: VisualRouteComparison[];
  changedCount: number;
  unchangedCount: number;
  newCount: number;
  removedCount: number;
  overallChangedPixelPercent: number;
  summary: string;
};

const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_CHANGE_THRESHOLD_PERCENT = 0.05;

function decodePng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

function changedPercent(diffPixels: number, width: number, height: number): number {
  const total = width * height;
  if (total <= 0) return 0;
  return roundPercent((diffPixels / total) * 100);
}

function roundPercent(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function resolveOptions(options: VisualDiffOptions | undefined) {
  return {
    threshold: options?.threshold ?? DEFAULT_THRESHOLD,
    changeThresholdPercent: options?.changeThresholdPercent ?? DEFAULT_CHANGE_THRESHOLD_PERCENT,
    includeDiffImage: options?.includeDiffImage ?? true,
  };
}

function comparePair(route: string, before: Buffer, after: Buffer, options: VisualDiffOptions | undefined): VisualRouteComparison {
  const resolved = resolveOptions(options);
  const beforeImage = decodePng(before);
  const afterImage = decodePng(after);
  if (beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height) {
    return {
      route,
      status: "changed",
      changedPixelPercent: 100,
      width: Math.max(beforeImage.width, afterImage.width),
      height: Math.max(beforeImage.height, afterImage.height),
      diffImagePng: null,
    };
  }

  const { width, height } = beforeImage;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(beforeImage.data, afterImage.data, diff.data, width, height, {
    threshold: resolved.threshold,
    includeAA: true,
  });
  const changedPixelPercent = changedPercent(diffPixels, width, height);
  const status = changedPixelPercent >= resolved.changeThresholdPercent ? "changed" : "unchanged";
  return {
    route,
    status,
    changedPixelPercent,
    width,
    height,
    diffImagePng: status === "changed" && resolved.includeDiffImage ? PNG.sync.write(diff) : null,
  };
}

export function compareRouteScreenshots(args: {
  route: string;
  before?: Buffer | null | undefined;
  after?: Buffer | null | undefined;
  options?: VisualDiffOptions;
}): VisualRouteComparison {
  const { route, before, after, options } = args;
  if (!before && !after) {
    return { route, status: "unchanged", changedPixelPercent: 0, width: null, height: null, diffImagePng: null };
  }
  if (!before && after) {
    const afterImage = decodePng(after);
    return {
      route,
      status: "new",
      changedPixelPercent: null,
      width: afterImage.width,
      height: afterImage.height,
      diffImagePng: null,
    };
  }
  if (before && !after) {
    const beforeImage = decodePng(before);
    return {
      route,
      status: "removed",
      changedPixelPercent: null,
      width: beforeImage.width,
      height: beforeImage.height,
      diffImagePng: null,
    };
  }
  return comparePair(route, before!, after!, options);
}

export function compareVisualCaptureSets(args: {
  before: Record<string, Buffer>;
  after: Record<string, Buffer>;
  options?: VisualDiffOptions;
}): VisualDiffSummary {
  const routes = [...new Set([...Object.keys(args.before), ...Object.keys(args.after)])].sort((left, right) => left.localeCompare(right));
  const comparisons = routes.map((route) => {
    const input: {
      route: string;
      before?: Buffer;
      after?: Buffer;
      options?: VisualDiffOptions;
    } = { route };
    if (args.before[route]) input.before = args.before[route];
    if (args.after[route]) input.after = args.after[route];
    if (args.options) input.options = args.options;
    return compareRouteScreenshots(input);
  });

  const changed = comparisons.filter((entry) => entry.status === "changed");
  const unchanged = comparisons.filter((entry) => entry.status === "unchanged");
  const added = comparisons.filter((entry) => entry.status === "new");
  const removed = comparisons.filter((entry) => entry.status === "removed");
  const measurable = comparisons.filter((entry) => entry.changedPixelPercent !== null);
  const overallChangedPixelPercent =
    measurable.length > 0
      ? roundPercent(measurable.reduce((sum, entry) => sum + (entry.changedPixelPercent ?? 0), 0) / measurable.length)
      : 0;

  const summary =
    changed.length > 0
      ? `${changed.length} route(s) changed (${overallChangedPixelPercent}% avg changed pixels); ${unchanged.length} unchanged, ${added.length} new, ${removed.length} removed.`
      : `${unchanged.length} route(s) unchanged; ${added.length} new, ${removed.length} removed.`;

  return {
    generatedAt: new Date().toISOString(),
    routes: comparisons,
    changedCount: changed.length,
    unchangedCount: unchanged.length,
    newCount: added.length,
    removedCount: removed.length,
    overallChangedPixelPercent,
    summary,
  };
}
