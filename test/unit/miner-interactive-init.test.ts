import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { createInterfaceMock } = vi.hoisted(() => ({
  createInterfaceMock: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: createInterfaceMock,
}));

let createInteractiveInitPrompt: typeof import("../../packages/gittensory-miner/lib/laptop-init.js").createInteractiveInitPrompt;
let resolveLaptopInitEnvFilePath: typeof import("../../packages/gittensory-miner/lib/laptop-init.js").resolveLaptopInitEnvFilePath;
let runInit: typeof import("../../packages/gittensory-miner/lib/laptop-init.js").runInit;

beforeAll(async () => {
  const module =
    await import("../../packages/gittensory-miner/lib/laptop-init.js");
  ({ createInteractiveInitPrompt, resolveLaptopInitEnvFilePath, runInit } =
    module);
});

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode = vi.fn((mode: boolean) => {
    this.isRaw = mode;
  });
  resume = vi.fn();
  pause = vi.fn();
}

function makeFakeStdout() {
  const write = vi.fn((chunk: string | Uint8Array) => {
    void chunk;
    return true;
  });
  return {
    isTTY: true,
    write,
  };
}

const roots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-interactive-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  createInterfaceMock.mockReset();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner interactive init raw TTY path (#5176)", () => {
  it("rejects non-TTY input before wiring the prompt", () => {
    expect(() =>
      createInteractiveInitPrompt({
        stdin: { isTTY: false } as never,
        stdout: makeFakeStdout() as never,
      }),
    ).toThrow("interactive init requires a TTY");
  });

  it("askSecret handles backspace, ctrl-c cleanup, and raw-mode restoration", async () => {
    const stdin = new FakeStdin();
    const stdout = makeFakeStdout();
    const prompt = createInteractiveInitPrompt({ stdin, stdout } as never);

    const success = prompt.askSecret("Enter GITHUB_TOKEN");
    stdin.emit("data", Buffer.from("abc"));
    stdin.emit("data", Buffer.from("\u007f"));
    stdin.emit("data", Buffer.from("d"));
    stdin.emit("data", Buffer.from("\n"));

    await expect(success).resolves.toBe("abd");
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.resume).toHaveBeenCalledTimes(1);
    expect(stdin.pause).toHaveBeenCalledTimes(1);
    expect(stdout.write).toHaveBeenCalledWith("Enter GITHUB_TOKEN: ");

    const interrupted = prompt.askSecret("Enter GITHUB_TOKEN");
    stdin.emit("data", Buffer.from("\u0003"));

    await expect(interrupted).rejects.toThrow("interactive init interrupted");
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("askQuestion falls back to the default value when the operator submits blank input", async () => {
    createInterfaceMock.mockImplementation(() => {
      const question = vi.fn(async () => "   ");
      const close = vi.fn();
      return { question, close };
    });

    const prompt = createInteractiveInitPrompt({
      stdin: new FakeStdin(),
      stdout: makeFakeStdout(),
    } as never);

    await expect(
      prompt.askQuestion("Choose a provider", "codex-cli"),
    ).resolves.toBe("codex-cli");
  });

  it("runInit interactive flow writes a private .env atomically and reruns doctor", async () => {
    const root = tempRoot();
    const stateDir = join(root, "state");
    const env = {
      GITTENSORY_MINER_CONFIG_DIR: stateDir,
      MINER_CODING_AGENT_PROVIDER: "mystery, codex-cli",
      MINER_CODING_AGENT_CODEX_MODEL: "old-model",
      MINER_CODING_AGENT_TIMEOUT_MS: "77777",
    };
    mkdirSync(stateDir, { recursive: true });
    const envFilePath = resolveLaptopInitEnvFilePath(env);
    writeFileSync(envFilePath, "legacy=1\n", { mode: 0o644 });
    chmodSync(envFilePath, 0o644);

    const stdin = new FakeStdin();
    const stdout = makeFakeStdout();
    const answers = ["9", "2", "codex-5", "180000"];
    createInterfaceMock.mockImplementation(() => {
      const question = vi.fn(async () => answers.shift() ?? "");
      const close = vi.fn();
      return { question, close };
    });
    const doctor = vi.fn(
      async (
        _args: string[],
        doctorEnv: Record<string, string | undefined>,
        cwd: string,
      ) => {
        expect(cwd).toBe(root);
        expect(doctorEnv).toMatchObject({
          GITHUB_TOKEN: "gitto",
          MINER_CODING_AGENT_PROVIDER: "codex-cli",
          MINER_CODING_AGENT_CODEX_MODEL: "codex-5",
          MINER_CODING_AGENT_TIMEOUT_MS: "180000",
        });
        return 0;
      },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const run = runInit(["--interactive"], env, {
      stdin: stdin as never,
      stdout: stdout as never,
      runDoctor: doctor,
      cwd: root,
    });
    stdin.emit("data", Buffer.from("gitt"));
    stdin.emit("data", Buffer.from("t"));
    stdin.emit("data", Buffer.from("\u0008"));
    stdin.emit("data", Buffer.from("o"));
    stdin.emit("data", Buffer.from("\n"));

    expect(await run).toBe(0);
    expect(doctor).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `initialized ${stateDir}`,
      `sqlite: ${join(stateDir, "laptop-state.sqlite3")}`,
      `env: ${envFilePath}`,
    ]);
    expect(readFileSync(envFilePath, "utf8")).toBe(
      [
        "# Generated by `gittensory-miner init --interactive`.",
        "# Keep this file private; it contains the operator's token and miner config.",
        'GITHUB_TOKEN="gitto"',
        'MINER_CODING_AGENT_PROVIDER="codex-cli"',
        'MINER_CODING_AGENT_CODEX_MODEL="codex-5"',
        'MINER_CODING_AGENT_TIMEOUT_MS="180000"',
        "",
      ].join("\n"),
    );
    expect(statSync(envFilePath).mode & 0o777).toBe(0o600);
    expect(
      (stdout.write.mock.calls as Array<[unknown]>).some(([chunk]) =>
        String(chunk).includes("Choose a coding-agent provider"),
      ),
    ).toBe(true);
    expect(
      (stdout.write.mock.calls as Array<[unknown]>).some(([chunk]) =>
        String(chunk).includes("Please choose a number from 1 to 4."),
      ),
    ).toBe(true);
    expect(
      (stdout.write.mock.calls as Array<[unknown]>).some(([chunk]) =>
        String(chunk).includes("Enter GITHUB_TOKEN: "),
      ),
    ).toBe(true);
    expect(
      (stdout.write.mock.calls as Array<[unknown]>).some(([chunk]) =>
        String(chunk).includes("\n"),
      ),
    ).toBe(true);
  });
});
