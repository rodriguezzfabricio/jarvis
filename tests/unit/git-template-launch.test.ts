import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import * as template from "./helpers/git-template.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, accessSync: vi.fn() };
});
afterEach(() => { vi.resetAllMocks(); });
const xcode = "/Applications/Xcode.app/Contents/Developer/usr/bin/git";
const clt = "/Library/Developer/CommandLineTools/usr/bin/git";

it("selects installed Xcode Git without invoking discovery or the macOS launcher", () => {
  expect(template.fixtureGitCommand("darwin")).toBe(xcode);
  expect(accessSync).toHaveBeenCalledExactlyOnceWith(xcode, constants.X_OK);
  expect(execFileSync).not.toHaveBeenCalled();
});
it("uses the direct CLT executable when Xcode Git is unavailable", () => {
  vi.mocked(accessSync).mockImplementationOnce(() => { throw new Error("not executable"); });
  expect(template.fixtureGitCommand("darwin")).toBe(clt);
  expect(vi.mocked(accessSync).mock.calls).toEqual([[xcode, constants.X_OK], [clt, constants.X_OK]]);
  expect(execFileSync).not.toHaveBeenCalled();
});
it("reports the missing prerequisite instead of falling back to the macOS launcher", () => {
  vi.mocked(accessSync).mockImplementation(() => { throw new Error("not installed"); });
  expect(() => template.fixtureGitCommand("darwin")).toThrow(/direct installed Git.*Xcode.*CommandLineTools/);
  expect(execFileSync).not.toHaveBeenCalled();
  expect(vi.mocked(accessSync).mock.calls.map(([path]) => path)).toEqual([xcode, clt]);
});
it.each(["linux", "freebsd", "win32"] as const)("preserves native bare Git selection on %s", platform => {
  expect(template.fixtureGitCommand(platform)).toBe("git");
  expect(accessSync).not.toHaveBeenCalled();
  expect(execFileSync).not.toHaveBeenCalled();
});
it.each([false, true])("builds the same template with exact arguments, cwd, clean environment and identity=%s", identity => {
  const root = "/fixture-home";
  template.buildRepoTemplate(root, identity);
  const command = process.platform === "darwin" ? xcode : "git";
  const options = { cwd: root, env: {
    PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  } };
  expect(vi.mocked(execFileSync).mock.calls).toEqual([
    [command, ["init", "-q", "-b", "main"], options],
    ...(identity ? [
      [command, ["config", "user.email", "t@t"], options],
      [command, ["config", "user.name", "t"], options],
    ] : []),
  ]);
});
it("keeps Git execution failures visible and stops before configuring identity", () => {
  const error = new Error("fixture Git failed");
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw error; });
  expect(() => template.buildRepoTemplate("/fixture-home", true)).toThrow(error);
  expect(execFileSync).toHaveBeenCalledTimes(1);
});
