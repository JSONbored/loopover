import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe(".env.example metric-name references (#5936)", () => {
  it("references only the real loopover_ metric prefix, never the stale gittensory_ one, in queue tuning guidance", () => {
    const env = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    // Prometheus metric names in this codebase are snake_case (src/selfhost/metrics.ts); a `gittensory_<word>`
    // shape anywhere in this file is stale doc drift left over from the gittensory -> loopover rebrand -- the
    // rebranded metric family only ever registers under the `loopover_` prefix.
    expect(env).not.toMatch(/gittensory_[a-z_]+/);
    expect(env).toContain("loopover_queue_live_pending");
    expect(env).toContain("loopover_queue_oldest_live_pending_age_seconds");
  });
});
