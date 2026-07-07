import { describe, expect, it } from "vitest";
import {
  PROMPT_PACKET_REDACTED_PATH,
  PROMPT_PACKET_REDACTED_TERM,
  PROMPT_PACKET_TEXT_FIELDS,
  buildPromptPacket,
  type PromptPacketInput,
} from "../../packages/gittensory-engine/src/prompt-packet";
import { PUBLIC_LOCAL_PATH_INLINE, PUBLIC_UNSAFE_TERMS } from "../../src/signals/redaction";

function cleanPacketInput(over: Partial<PromptPacketInput> = {}): PromptPacketInput {
  return {
    taskBrief: "Add retry logic to the cache reconnect path.",
    feasibilityNotes: "Linked issue is open and unassigned.",
    retrievalContext: "See src/cache/reconnect.ts for the existing handler.",
    constraints: "Match house style; run npm run test:ci before push.",
    ...over,
  };
}

function splitTopLevelAlternation(source: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of source) {
    if (char === "(") depth += 1;
    if (depth > 0) current += char;
    else if (char === "|") {
      branches.push(current);
      current = "";
    } else {
      current += char;
    }
    if (char === ")") depth -= 1;
  }
  if (current.length > 0) branches.push(current);
  return branches;
}

/** Enumerate every unsafe-term family branch from the canonical alternation source (do not hand-copy). */
function enumerateUnsafeTermFamilies(source: string): Array<{ id: string; sample: string }> {
  const branches = splitTopLevelAlternation(source);
  const families: Array<{ id: string; sample: string }> = [];

  for (const branch of branches) {
    const pluralizable = branch.match(/^\(\?:([^)]+)\)\\w\*$/) ?? branch.match(/^\(([^)]+)\)\\w\*$/);
    if (pluralizable) {
      for (const term of splitTopLevelAlternation(pluralizable[1]!)) {
        families.push({ id: term, sample: term });
      }
      continue;
    }
    if (branch === "raw[-_\\s]?trust") {
      families.push({ id: "raw-trust", sample: "raw-trust" });
      continue;
    }
    if (branch === "trust[-_\\s]?score") {
      families.push({ id: "trust-score", sample: "trust_score" });
      continue;
    }
    if (branch === "private[-_\\s]?reviewability") {
      families.push({ id: "private-reviewability", sample: "private-reviewability" });
      continue;
    }
    families.push({ id: branch, sample: branch });
  }

  return families;
}

/** Enumerate every local-path root prefix from the canonical alternation source (do not hand-copy). */
function enumerateLocalPathSamples(source: string): Array<{ id: string; sample: string }> {
  return splitTopLevelAlternation(source).map((prefix) => {
    if (prefix.startsWith("[A-Za-z]:[\\\\/]Users[\\\\/]")) {
      return { id: "windows-users", sample: "C:\\Users\\alice\\repo\\main.ts" };
    }
    if (prefix.startsWith("[A-Za-z]:[\\\\/]Program Files[\\\\/]")) {
      return { id: "windows-program-files", sample: "C:\\Program Files\\App\\config.json" };
    }
    const id = prefix.replace(/\/$/, "").replace(/^\//, "");
    return { id, sample: `${prefix}alice/project` };
  });
}

const UNSAFE_TERM_FAMILIES = enumerateUnsafeTermFamilies(PUBLIC_UNSAFE_TERMS);
const LOCAL_PATH_SAMPLES = enumerateLocalPathSamples(PUBLIC_LOCAL_PATH_INLINE);

describe("buildPromptPacket redaction (#2321 adversarial allowlist)", () => {
  it("enumerates every unsafe-term family from PUBLIC_UNSAFE_TERMS", () => {
    expect(UNSAFE_TERM_FAMILIES.map((entry) => entry.id).sort()).toEqual(
      ["coldkey", "farming", "hotkey", "mnemonic", "payout", "private-reviewability", "ranking", "raw-trust", "reviewability", "reward", "score", "trust-score", "wallet"].sort(),
    );
  });

  it("enumerates every local-path root from PUBLIC_LOCAL_PATH_INLINE", () => {
    expect(LOCAL_PATH_SAMPLES.map((entry) => entry.id).sort()).toEqual(
      ["Users", "home", "opt", "private", "root", "tmp", "var", "windows-program-files", "windows-users"].sort(),
    );
  });

  it.each(UNSAFE_TERM_FAMILIES.flatMap(({ id, sample }) =>
    PROMPT_PACKET_TEXT_FIELDS.map((field) => ({ id, field, sample })),
  ))("strips unsafe term family '$id' injected into $field", ({ field, sample }) => {
    const input = cleanPacketInput({ [field]: `prefix ${sample} suffix` });
    const packet = buildPromptPacket(input);

    expect(packet[field]).toContain(PROMPT_PACKET_REDACTED_TERM);
    expect(packet[field]).not.toMatch(new RegExp(String.raw`\b${sample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`, "i"));
  });

  it.each(LOCAL_PATH_SAMPLES.flatMap(({ id, sample }) =>
    PROMPT_PACKET_TEXT_FIELDS.map((field) => ({ id, field, sample })),
  ))("strips local-path prefix '$id' injected into $field", ({ field, sample }) => {
    const input = cleanPacketInput({ [field]: `clone failed at ${sample} during setup` });
    const packet = buildPromptPacket(input);

    expect(packet[field]).toContain(PROMPT_PACKET_REDACTED_PATH);
    expect(packet[field]).not.toContain(sample);
  });

  it("applies both unsafe-term and local-path filters in the same field (double jeopardy)", () => {
    const packet = buildPromptPacket(
      cleanPacketInput({ taskBrief: "wallet backup stored at /home/alice/secrets before retry" }),
    );

    expect(packet.taskBrief).toContain(PROMPT_PACKET_REDACTED_TERM);
    expect(packet.taskBrief).toContain(PROMPT_PACKET_REDACTED_PATH);
    expect(packet.taskBrief).not.toMatch(/\bwallet\b/i);
    expect(packet.taskBrief).not.toMatch(/\/home\//);
  });

  it("leaves fields with zero unsafe content byte-identical", () => {
    const input = cleanPacketInput();
    const packet = buildPromptPacket(input);

    for (const field of PROMPT_PACKET_TEXT_FIELDS) {
      expect(packet[field]).toBe(input[field]);
    }
  });

  it("strips a field that contains only an unsafe term instead of forwarding it verbatim", () => {
    const packet = buildPromptPacket(cleanPacketInput({ constraints: "wallet" }));

    expect(packet.constraints).toBe(PROMPT_PACKET_REDACTED_TERM);
  });
});
