import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODING_AGENT_DRIVER_NAMES } from "@loopover/engine";
import {
  createWizardIo,
  promptCompanionVars,
  promptProviderSelection,
  renderWizardEnvFile,
  resolveWizardEnvFilePath,
  runInteractiveInit,
} from "../../packages/loopover-miner/lib/init-wizard.js";
import { runCliResult } from "./support/miner-cli-harness";

const roots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-init-wizard-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFakeIo(options: { maskedAnswers?: string[]; textAnswers?: string[] } = {}) {
  const lines: string[] = [];
  const maskedQueue = [...(options.maskedAnswers ?? [])];
  const textQueue = [...(options.textAnswers ?? [])];
  return {
    lines,
    async promptMasked(question: string) {
      lines.push(`MASKED?${question}`);
      return maskedQueue.shift() ?? "";
    },
    async promptText(question: string) {
      lines.push(`TEXT?${question}`);
      return textQueue.shift() ?? "";
    },
    writeLine(text: string) {
      lines.push(text);
    },
  };
}

function createFakeTty() {
  let output = "";
  const outStream = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  });
  Object.assign(outStream, { isTTY: true, columns: 80 });
  const inStream = new Readable({ read() {} });
  Object.assign(inStream, { isTTY: true });
  return { inStream, outStream, getOutput: () => output };
}

async function typeLine(inStream: Readable, text: string) {
  for (const ch of text) inStream.emit("data", Buffer.from(ch));
  inStream.emit("data", Buffer.from("\n"));
}

describe("gittensory-miner init --interactive wizard (#5176)", () => {
  it("renderWizardEnvFile renders sourceable KEY=value lines in insertion order, or empty for no entries", () => {
    expect(renderWizardEnvFile([])).toBe("");
    expect(renderWizardEnvFile([["GITHUB_TOKEN", "ghp_x"]])).toBe("GITHUB_TOKEN=ghp_x\n");
    expect(
      renderWizardEnvFile([
        ["GITHUB_TOKEN", "ghp_x"],
        ["MINER_CODING_AGENT_PROVIDER", "claude-cli"],
      ]),
    ).toBe("GITHUB_TOKEN=ghp_x\nMINER_CODING_AGENT_PROVIDER=claude-cli\n");
  });

  it("resolveWizardEnvFilePath writes to the same state dir init already uses", () => {
    expect(resolveWizardEnvFilePath({ LOOPOVER_MINER_CONFIG_DIR: "/custom/state" })).toBe(
      "/custom/state/.env",
    );
  });

  describe("promptProviderSelection", () => {
    it("returns null (skip) on empty input, without validation errors", async () => {
      const io = createFakeIo({ textAnswers: [""] });
      expect(await promptProviderSelection(io)).toBeNull();
      expect(io.lines.some((line) => line.includes("Enter a number"))).toBe(false);
    });

    it("re-prompts on an invalid/out-of-range answer, then accepts a valid one", async () => {
      const io = createFakeIo({ textAnswers: ["abc", "99", "2"] });
      expect(await promptProviderSelection(io)).toBe(CODING_AGENT_DRIVER_NAMES[1]);
      const reprompts = io.lines.filter((line) => line.includes("Enter a number from 1"));
      expect(reprompts).toHaveLength(2);
    });

    it("menu choices are sourced directly from CODING_AGENT_DRIVER_NAMES, never a hand-duplicated list", async () => {
      const io = createFakeIo({ textAnswers: [String(CODING_AGENT_DRIVER_NAMES.length)] });
      expect(await promptProviderSelection(io)).toBe(
        CODING_AGENT_DRIVER_NAMES[CODING_AGENT_DRIVER_NAMES.length - 1],
      );
      for (const name of CODING_AGENT_DRIVER_NAMES) {
        expect(io.lines.some((line) => line.includes(name))).toBe(true);
      }
    });
  });

  describe("promptCompanionVars", () => {
    it("prompts for claude-cli's model + timeout, skipping any left empty", async () => {
      const io = createFakeIo({ textAnswers: ["claude-model-x", ""] });
      const result = await promptCompanionVars(io, "claude-cli");
      expect(result).toEqual([["MINER_CODING_AGENT_CLAUDE_MODEL", "claude-model-x"]]);
    });

    it("prompts for nothing for a provider with no companion vars (noop)", async () => {
      const io = createFakeIo();
      expect(await promptCompanionVars(io, "noop")).toEqual([]);
      expect(io.lines).toHaveLength(0);
    });

    it("prompts for nothing for a provider name not in the config-env map (defensive default)", async () => {
      const io = createFakeIo();
      expect(await promptCompanionVars(io, "not-a-real-provider")).toEqual([]);
      expect(io.lines).toHaveLength(0);
    });
  });

  describe("runInteractiveInit", () => {
    it("writes a starter .env (mode 0600), initializes laptop state, and passes a clean doctor run when the provider is skipped", async () => {
      const stateDir = join(tempRoot(), "state");
      const cwd = tempRoot(); // no .loopover-miner.yml here => config-content check passes
      const env = { LOOPOVER_MINER_CONFIG_DIR: stateDir };
      const io = createFakeIo({ maskedAnswers: ["ghp_test_token_123"], textAnswers: [""] });

      const exitCode = await runInteractiveInit(env, cwd, io);

      const envFilePath = join(stateDir, ".env");
      expect(existsSync(envFilePath)).toBe(true);
      expect(readFileSync(envFilePath, "utf8")).toBe("GITHUB_TOKEN=ghp_test_token_123\n");
      expect(statSync(envFilePath).mode & 0o777).toBe(0o600);
      expect(existsSync(join(stateDir, "laptop-state.sqlite3"))).toBe(true);

      // REGRESSION (#5176): the raw token must never appear in anything written to the terminal, including
      // the final doctor summary this function prints.
      expect(io.lines.some((line) => line.includes("ghp_test_token_123"))).toBe(false);

      // No provider was configured, so doctor's coding-agent-credential check is a clean skip and every other
      // check passes deterministically in this environment (same healthy-setup shape as miner-status.test.ts).
      expect(exitCode).toBe(0);
    });

    it("re-prompts when the token is left empty before accepting a valid one", async () => {
      const stateDir = join(tempRoot(), "state");
      const cwd = tempRoot();
      const env = { LOOPOVER_MINER_CONFIG_DIR: stateDir };
      const io = createFakeIo({ maskedAnswers: ["", "ghp_after_retry"], textAnswers: [""] });

      await runInteractiveInit(env, cwd, io);

      expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("GITHUB_TOKEN=ghp_after_retry\n");
      expect(io.lines.some((line) => line.includes("A value is required"))).toBe(true);
    });

    it("writes the selected provider and its filled-in companion var, skipping the one left empty", async () => {
      const stateDir = join(tempRoot(), "state");
      const cwd = tempRoot();
      const env = { LOOPOVER_MINER_CONFIG_DIR: stateDir };
      const claudeIndex = CODING_AGENT_DRIVER_NAMES.indexOf("claude-cli");
      const io = createFakeIo({
        maskedAnswers: ["ghp_provider_case"],
        textAnswers: [String(claudeIndex + 1), "opus-x", ""],
      });

      await runInteractiveInit(env, cwd, io);

      expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe(
        "GITHUB_TOKEN=ghp_provider_case\nMINER_CODING_AGENT_PROVIDER=claude-cli\nMINER_CODING_AGENT_CLAUDE_MODEL=opus-x\n",
      );
    });

    it("reports the sqlite file as already existing on a second run against the same state dir", async () => {
      const stateDir = join(tempRoot(), "state");
      const cwd = tempRoot();
      const env = { LOOPOVER_MINER_CONFIG_DIR: stateDir };

      await runInteractiveInit(env, cwd, createFakeIo({ maskedAnswers: ["ghp_first"], textAnswers: [""] }));
      const secondIo = createFakeIo({ maskedAnswers: ["ghp_second"], textAnswers: [""] });
      await runInteractiveInit(env, cwd, secondIo);

      expect(secondIo.lines.some((line) => line.includes("(already existed)"))).toBe(true);
    });
  });

  describe("runInteractiveInit with device-flow authorization configured (#5682)", () => {
    const deviceEnv = (stateDir: string) => ({ LOOPOVER_MINER_CONFIG_DIR: stateDir, LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID: "client-abc" });
    const jsonResponse = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });
    const noSleep = async () => undefined;

    it("REGRESSION (#5682): defaulting the auth-method choice (empty input) authorizes via device flow and writes its access token as GITHUB_TOKEN", async () => {
      const stateDir = join(tempRoot(), "state");
      const cwd = tempRoot();
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ device_code: "dc1", user_code: "WXYZ-1234", verification_uri: "https://github.com/login/device", interval: 1 }))
        .mockResolvedValueOnce(jsonResponse({ access_token: "gho_device_flow_token" }));
      // textAnswers order: auth-method choice (empty -> default device flow), then provider selection (skip).
      const io = createFakeIo({ textAnswers: ["", ""] });

      const exitCode = await runInteractiveInit(deviceEnv(stateDir), cwd, io, { fetchImpl, sleepFn: noSleep });

      expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("GITHUB_TOKEN=gho_device_flow_token\n");
      expect(io.lines.some((line) => line.includes("WXYZ-1234"))).toBe(true);
      expect(io.lines.some((line) => line.includes("Authorized."))).toBe(true);
      // The raw token itself is never printed, only the (distinct) short user_code shown during authorization.
      expect(io.lines.some((line) => line.includes("gho_device_flow_token"))).toBe(false);
      expect(exitCode).toBe(0);
    });

    it("choosing option 2 skips device flow entirely and uses the original masked-token prompt", async () => {
      const stateDir = join(tempRoot(), "state");
      const cwd = tempRoot();
      const fetchImpl = vi.fn();
      const io = createFakeIo({ textAnswers: ["2", ""], maskedAnswers: ["ghp_pasted_despite_device_flow"] });

      await runInteractiveInit(deviceEnv(stateDir), cwd, io, { fetchImpl, sleepFn: noSleep });

      expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("GITHUB_TOKEN=ghp_pasted_despite_device_flow\n");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("re-prompts the auth-method choice on an invalid answer before accepting a valid one", async () => {
      const stateDir = join(tempRoot(), "state");
      const cwd = tempRoot();
      const io = createFakeIo({ textAnswers: ["bogus", "2", ""], maskedAnswers: ["ghp_after_reprompt"] });

      await runInteractiveInit(deviceEnv(stateDir), cwd, io, { fetchImpl: vi.fn(), sleepFn: noSleep });

      expect(io.lines.some((line) => line.includes("Enter 1 or 2."))).toBe(true);
      expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("GITHUB_TOKEN=ghp_after_reprompt\n");
    });

    it("REGRESSION: a device-flow failure falls back to the masked-token prompt rather than failing the whole wizard", async () => {
      const stateDir = join(tempRoot(), "state");
      const cwd = tempRoot();
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
      const io = createFakeIo({ textAnswers: ["1", ""], maskedAnswers: ["ghp_fallback_after_failure"] });

      const exitCode = await runInteractiveInit(deviceEnv(stateDir), cwd, io, { fetchImpl, sleepFn: noSleep });

      expect(io.lines.some((line) => line.includes("Device-flow authorization failed (device_code_request_failed)"))).toBe(true);
      expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("GITHUB_TOKEN=ghp_fallback_after_failure\n");
      expect(exitCode).toBe(0);
    });

    it("REGRESSION: a non-DeviceFlowError thrown mid-flow (e.g. a raw network failure) also falls back cleanly, reported as device_flow_failed", async () => {
      const stateDir = join(tempRoot(), "state");
      const cwd = tempRoot();
      const fetchImpl = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND github.com"));
      const io = createFakeIo({ textAnswers: ["1", ""], maskedAnswers: ["ghp_fallback_after_network_error"] });

      await runInteractiveInit(deviceEnv(stateDir), cwd, io, { fetchImpl, sleepFn: noSleep });

      expect(io.lines.some((line) => line.includes("Device-flow authorization failed (device_flow_failed)"))).toBe(true);
      expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("GITHUB_TOKEN=ghp_fallback_after_network_error\n");
    });
  });

  describe("createWizardIo (real terminal adapter, driven over fake streams)", () => {
    it("promptText resolves the typed line", async () => {
      const { inStream, outStream } = createFakeTty();
      const io = createWizardIo(inStream, outStream);
      const answerPromise = io.promptText("Provider: ");
      await typeLine(inStream, "claude-cli");
      expect(await answerPromise).toBe("claude-cli");
      io.close();
    });

    it("REGRESSION: promptMasked never writes the raw secret to the output stream", async () => {
      const { inStream, outStream, getOutput } = createFakeTty();
      const io = createWizardIo(inStream, outStream);
      const answerPromise = io.promptMasked("GitHub token (input hidden): ");
      await typeLine(inStream, "ghp_supersecret123");
      const answer = await answerPromise;
      io.close();

      expect(answer).toBe("ghp_supersecret123");
      expect(getOutput()).not.toContain("ghp_supersecret123");
      expect(getOutput()).toContain("*");
    });

    it("stops masking once the masked prompt resolves, so a later plain prompt echoes normally", async () => {
      const { inStream, outStream, getOutput } = createFakeTty();
      const io = createWizardIo(inStream, outStream);

      const maskedPromise = io.promptMasked("Secret: ");
      await typeLine(inStream, "hunter2");
      await maskedPromise;

      const textPromise = io.promptText("Provider: ");
      await typeLine(inStream, "noop");
      expect(await textPromise).toBe("noop");
      expect(getOutput()).toContain("noop");
      io.close();
    });

    it("writeLine writes the text followed by a newline", () => {
      const { inStream, outStream, getOutput } = createFakeTty();
      const io = createWizardIo(inStream, outStream);
      io.writeLine("hello");
      expect(getOutput()).toBe("hello\n");
      io.close();
    });
  });

  it("e2e: `gittensory-miner init --interactive` dispatches to the wizard, not the non-interactive path", () => {
    // No stdin input is piped, so the wizard blocks on its first prompt and the process is torn down once
    // Node detects the unsettled top-level await -- this only asserts the CLI routes `--interactive` to the
    // wizard (distinct prompt text, distinct code path) without hanging; the full multi-turn prompt flow is
    // exercised precisely and deterministically by the direct runInteractiveInit tests above.
    const stateDir = tempRoot();
    const result = runCliResult(["init", "--interactive"], { LOOPOVER_MINER_CONFIG_DIR: stateDir });
    expect(result.output).toContain("GitHub token (input hidden)");
    expect(result.output).not.toContain("initialized " + stateDir);
  });
});
