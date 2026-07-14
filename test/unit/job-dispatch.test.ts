import { describe, expect, it, vi } from "vitest";
import { processJob } from "../../src/queue/processors";
import { createTestEnv } from "../helpers/d1";
import type { JobMessage } from "../../src/types";

describe("processJob (#5836)", () => {
  it("logs an unknown_job_type_ignored warning and returns without throwing for an unrecognized message.type", async () => {
    const env = createTestEnv();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      processJob(env, { type: "totally-unknown-job-type" } as unknown as JobMessage),
    ).resolves.toBeUndefined();

    expect(warnings.mock.calls.some((call) => String(call[0]).includes("unknown_job_type_ignored") && String(call[0]).includes("totally-unknown-job-type"))).toBe(true);
    warnings.mockRestore();
  });
});
