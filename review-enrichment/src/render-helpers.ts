// Shared helpers for analyzer-owned renderers. These keep prompt output public-safe and deterministic while allowing
// analyzer modules to own their own brief sections.

const CODE_SPAN_UNSAFE = /[`\u0000-\u001f\u007f]/g;

const CODE_SPAN_REPLACEMENTS: Record<string, string> = {
  "`": "\u02cb",
  "\n": "\u2424",
  "\r": "\u240d",
  "\t": "\u2409",
};

export const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

export interface AnalyzerRenderHelpers {
  safeCodeSpan(value: string): string;
  promptText(value: string): string;
  formatBytes(value: number): string;
  bytesLabel(value: number | null): string;
}

export function safeCodeSpan(value: string): string {
  return `\`${value.replace(
    CODE_SPAN_UNSAFE,
    (char) => CODE_SPAN_REPLACEMENTS[char] ?? "\ufffd",
  )}\``;
}

export function promptText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/([*_{}[\]()#+.!|-])/g, "\\$1");
}

export function formatBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

export function bytesLabel(value: number | null): string {
  if (value === null) return "unknown";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} KB`;
  return `${value} B`;
}

export const RENDER_HELPERS: AnalyzerRenderHelpers = {
  safeCodeSpan,
  promptText,
  formatBytes,
  bytesLabel,
};
