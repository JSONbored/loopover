import { describe, expect, it } from "vitest";

// @ts-expect-error Plain MV3 JavaScript module.
import * as overlaySafety from "../../apps/gittensory-extension/overlay-safety.js";

const {
  EXTENSION_SOURCE_UPLOAD_ENABLED,
  OVERLAY_FORBIDDEN_TERMS,
  escapeOverlayHtml,
  isOverlayDisplaySafe,
  redactForOverlayDisplay,
  renderOverlayPanels,
} = overlaySafety;

describe("extension overlay safety", () => {
  it("keeps source upload disabled by default", () => {
    expect(EXTENSION_SOURCE_UPLOAD_ENABLED).toBe(false);
  });

  it("redacts forbidden maintainer-only terms from overlay rows", () => {
    for (const term of OVERLAY_FORBIDDEN_TERMS) {
      expect(isOverlayDisplaySafe(term)).toBe(false);
      expect(redactForOverlayDisplay(`prefix ${term} suffix`)).toBe("[redacted]");
    }
    expect(isOverlayDisplaySafe("Reviewability score 72")).toBe(true);
    expect(redactForOverlayDisplay("action: review")).toBe("action: review");
  });

  it("escapes HTML and renders redacted panel markup", () => {
    const html = renderOverlayPanels([
      {
        label: "Boundary<script>",
        badge: "wallet",
        rows: [{ k: "public", v: 'no"><img src=x onerror=alert(1)>' }],
      },
    ]);
    expect(html).toContain("[redacted]");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/<img[^>]+onerror/i);
    expect(escapeOverlayHtml(`a&b<c>"'`)).toBe("a&amp;b&lt;c&gt;&quot;&#39;");
  });
});
