import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { handleConnection, runDeploy } from "../../scripts/redeploy-companion";

const TOKEN = "companion-test-token";

function fakeChildProcess(): { child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }; emitClose: (code: number | null) => void; emitError: (error: Error) => void } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return {
    child,
    emitClose: (code) => child.emit("close", code),
    emitError: (error) => child.emit("error", error),
  };
}

describe("runDeploy (#7723)", () => {
  it("spawns bash scripts/deploy-selfhost-image.sh with no args when no image is given, forwards stdout/stderr lines, and resolves ok on exit 0", async () => {
    const { child, emitClose } = fakeChildProcess();
    const spawnSpy = vi.fn().mockReturnValue(child);
    const logs: string[] = [];

    const resultPromise = runDeploy(undefined, (line) => logs.push(line), spawnSpy as never);
    expect(spawnSpy).toHaveBeenCalledExactlyOnceWith("bash", ["scripts/deploy-selfhost-image.sh"], expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }));
    child.stdout.emit("data", Buffer.from("selfhost image deploy: pulling ghcr.io/jsonbored/loopover-selfhost:latest\n"));
    child.stderr.emit("data", Buffer.from("some warning\n"));
    emitClose(0);

    const result = await resultPromise;
    expect(result).toEqual({ ok: true, exitCode: 0 });
    expect(logs).toEqual(["selfhost image deploy: pulling ghcr.io/jsonbored/loopover-selfhost:latest", "some warning"]);
  });

  it("passes the image as a single argv element when given -- never shell-interpolated", async () => {
    const { child, emitClose } = fakeChildProcess();
    const spawnSpy = vi.fn().mockReturnValue(child);

    const resultPromise = runDeploy("ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0", () => undefined, spawnSpy as never);
    expect(spawnSpy).toHaveBeenCalledExactlyOnceWith(
      "bash",
      ["scripts/deploy-selfhost-image.sh", "ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0"],
      expect.anything(),
    );
    emitClose(0);
    await resultPromise;
  });

  it("resolves ok:false with the real exit code on a non-zero exit", async () => {
    const { child, emitClose } = fakeChildProcess();
    const resultPromise = runDeploy(undefined, () => undefined, (() => child) as never);
    emitClose(1);
    expect(await resultPromise).toEqual({ ok: false, exitCode: 1 });
  });

  it("resolves ok:false with the spawn error's message when the process itself fails to start", async () => {
    const { child, emitError } = fakeChildProcess();
    const resultPromise = runDeploy(undefined, () => undefined, (() => child) as never);
    emitError(new Error("bash: not found"));
    expect(await resultPromise).toEqual({ ok: false, exitCode: null, error: "bash: not found" });
  });

  it("drops blank lines from stdout/stderr chunks -- only non-empty lines reach onLog", async () => {
    const { child, emitClose } = fakeChildProcess();
    const logs: string[] = [];
    const resultPromise = runDeploy(undefined, (line) => logs.push(line), (() => child) as never);
    child.stdout.emit("data", Buffer.from("real line\n\n   \nanother real line\n"));
    emitClose(0);
    await resultPromise;
    expect(logs).toEqual(["real line", "another real line"]);
  });
});

describe("handleConnection (#7723)", () => {
  const fakeDeploy = (result: Awaited<ReturnType<typeof runDeploy>>) =>
    vi.fn().mockImplementation(async (_image: string | undefined, onLog: (line: string) => void) => {
      onLog("deploying...");
      return result;
    });

  it("rejects a malformed (non-JSON) request line as unauthorized without ever touching busy state or deploy", async () => {
    const setBusy = vi.fn();
    const written: string[] = [];
    const deploy = vi.fn();

    await handleConnection(TOKEN, "not json", () => false, setBusy, (line) => written.push(line), deploy);

    expect(written).toEqual([JSON.stringify({ ok: false, error: "unauthorized" })]);
    expect(setBusy).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
  });

  it("rejects a missing token as unauthorized", async () => {
    const written: string[] = [];
    await handleConnection(TOKEN, JSON.stringify({}), () => false, vi.fn(), (line) => written.push(line), vi.fn());
    expect(written).toEqual([JSON.stringify({ ok: false, error: "unauthorized" })]);
  });

  it("rejects a wrong token as unauthorized (not a partial/prefix match)", async () => {
    const written: string[] = [];
    await handleConnection(
      TOKEN,
      JSON.stringify({ token: `${TOKEN}-wrong` }),
      () => false,
      vi.fn(),
      (line) => written.push(line),
      vi.fn(),
    );
    expect(written).toEqual([JSON.stringify({ ok: false, error: "unauthorized" })]);
  });

  it("rejects a request while a redeploy is already in progress, without calling deploy again", async () => {
    const written: string[] = [];
    const deploy = vi.fn();
    await handleConnection(TOKEN, JSON.stringify({ token: TOKEN }), () => true, vi.fn(), (line) => written.push(line), deploy);
    expect(written).toEqual([JSON.stringify({ ok: false, error: "redeploy_already_in_progress" })]);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("rejects an unsafe image override (whitespace/quote/backslash/compose-interpolation chars) before ever calling deploy", async () => {
    const written: string[] = [];
    const deploy = vi.fn();
    await handleConnection(
      TOKEN,
      JSON.stringify({ token: TOKEN, image: "not a valid $(image)" }),
      () => false,
      vi.fn(),
      (line) => written.push(line),
      deploy,
    );
    expect(written).toEqual([JSON.stringify({ ok: false, error: "invalid_image_override" })]);
    expect(deploy).not.toHaveBeenCalled();
  });

  it.each(["has`a`backtick", "has;a;semicolon", "has|a|pipe", "has&an&ampersand", "has<a>anglebracket"])(
    "rejects shell metacharacters in an image override: %s",
    async (image) => {
      const written: string[] = [];
      const deploy = vi.fn();
      await handleConnection(TOKEN, JSON.stringify({ token: TOKEN, image }), () => false, vi.fn(), (line) => written.push(line), deploy);
      expect(written).toEqual([JSON.stringify({ ok: false, error: "invalid_image_override" })]);
      expect(deploy).not.toHaveBeenCalled();
    },
  );

  it("accepts a legitimate image reference with no false-positive rejection", async () => {
    const written: string[] = [];
    const deploy = vi.fn().mockImplementation(async () => ({ ok: true, exitCode: 0 }));
    await handleConnection(
      TOKEN,
      JSON.stringify({ token: TOKEN, image: "ghcr.io/jsonbored/loopover-selfhost@sha256:abcdef0123456789" }),
      () => false,
      vi.fn(),
      (line) => written.push(line),
      deploy,
    );
    expect(deploy).toHaveBeenCalledExactlyOnceWith("ghcr.io/jsonbored/loopover-selfhost@sha256:abcdef0123456789", expect.any(Function));
  });

  it("runs a valid authenticated request end to end: sets busy, streams logs, writes the terminal result, clears busy", async () => {
    const written: string[] = [];
    const busyStates: boolean[] = [];
    let busy = false;
    const deploy = fakeDeploy({ ok: true, exitCode: 0 });

    await handleConnection(
      TOKEN,
      JSON.stringify({ token: TOKEN, image: "ghcr.io/jsonbored/loopover-selfhost:latest" }),
      () => busy,
      (value) => {
        busy = value;
        busyStates.push(value);
      },
      (line) => written.push(line),
      deploy,
    );

    expect(deploy).toHaveBeenCalledExactlyOnceWith("ghcr.io/jsonbored/loopover-selfhost:latest", expect.any(Function));
    expect(written).toEqual([JSON.stringify({ log: "deploying..." }), JSON.stringify({ ok: true, exitCode: 0 })]);
    expect(busyStates).toEqual([true, false]); // set busy before deploying, cleared after -- in that order
  });

  it("clears busy even when the underlying deploy call throws -- never leaves the companion permanently locked", async () => {
    let busy = false;
    const deploy = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      handleConnection(
        TOKEN,
        JSON.stringify({ token: TOKEN }),
        () => busy,
        (value) => {
          busy = value;
        },
        () => undefined,
        deploy,
      ),
    ).rejects.toThrow("boom");
    expect(busy).toBe(false);
  });

  it("includes the error field in the terminal response when the deploy result carries one", async () => {
    const written: string[] = [];
    const deploy = fakeDeploy({ ok: false, exitCode: null, error: "bash: not found" });

    await handleConnection(TOKEN, JSON.stringify({ token: TOKEN }), () => false, vi.fn(), (line) => written.push(line), deploy);

    expect(written[1]).toBe(JSON.stringify({ ok: false, exitCode: null, error: "bash: not found" }));
  });
});
