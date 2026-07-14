import { describe, expect, it, vi } from "vitest";
import { resolveDockerCli } from "../src/main/docker-cli.js";

const ok = (stdout: string) => Promise.resolve({ stdout, stderr: "", exitCode: 0 });

function executableOnly(...paths: string[]) {
  const available = new Set(paths);
  return vi.fn(async (candidate: string) => available.has(candidate));
}

describe("Docker CLI discovery", () => {
  it("prefers the Docker binary from the existing Terminal PATH", async () => {
    const executable = executableOnly("/custom/bin/docker", "/usr/local/bin/docker");
    await expect(resolveDockerCli({ env: { PATH: "/custom/bin:/usr/bin" }, executable })).resolves.toBe("/custom/bin/docker");
    expect(executable.mock.calls.map(([candidate]) => candidate)).toEqual(["/custom/bin/docker"]);
  });

  it("finds /usr/local/bin/docker when a Finder PATH omits it", async () => {
    await expect(resolveDockerCli({
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      executable: executableOnly("/usr/local/bin/docker"),
    })).resolves.toBe("/usr/local/bin/docker");
  });

  it("falls back to the Homebrew Apple Silicon binary", async () => {
    await expect(resolveDockerCli({
      env: { PATH: "/usr/bin:/bin" }, executable: executableOnly("/opt/homebrew/bin/docker"),
    })).resolves.toBe("/opt/homebrew/bin/docker");
  });

  it("falls back to the Docker Desktop application binary", async () => {
    const desktop = "/Applications/Docker.app/Contents/Resources/bin/docker";
    await expect(resolveDockerCli({ env: { PATH: "/usr/bin:/bin" }, executable: executableOnly(desktop) })).resolves.toBe(desktop);
  });

  it("uses /usr/bin/which after PATH and fixed candidates", async () => {
    const command = vi.fn(async (binary: string) => {
      expect(binary).toBe("/usr/bin/which");
      return await ok("/another/docker");
    });
    await expect(resolveDockerCli({
      env: { PATH: "/usr/bin" }, executable: executableOnly("/another/docker"), command,
    })).resolves.toBe("/another/docker");
    expect(command).toHaveBeenCalledWith("/usr/bin/which", ["docker"], expect.objectContaining({ timeoutMs: 5_000 }));
  });

  it("uses a login zsh lookup last", async () => {
    const command = vi.fn()
      .mockRejectedValueOnce(new Error("which failed"))
      .mockResolvedValueOnce(await ok("/login-shell/docker"));
    await expect(resolveDockerCli({
      env: { PATH: "/usr/bin" }, executable: executableOnly("/login-shell/docker"), command,
    })).resolves.toBe("/login-shell/docker");
    expect(command.mock.calls[1]?.slice(0, 2)).toEqual(["/bin/zsh", ["-lc", "command -v docker"]]);
  });

  it("returns undefined only after every lookup fails", async () => {
    const command = vi.fn(async () => { throw new Error("not found"); });
    await expect(resolveDockerCli({ env: { PATH: "/usr/bin" }, executable: executableOnly(), command })).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(2);
  });
});
