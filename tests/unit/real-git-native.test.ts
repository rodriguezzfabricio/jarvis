import { rmSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";
import { nativeGitApis, runNativeGitProbe, type Captured } from "./helpers/native-git-test.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function stdout(captured: Captured): string {
  expect(captured.error).toBeUndefined();
  return typeof captured.value === "string" ? captured.value : captured.value!.stdout;
}
it.each(nativeGitApis)("keeps native %s execution, including cwd/PATH changes and caller environment", api => {
  const root = shortTmp("jgn-"); roots.push(root);
  const result = runNativeGitProbe(api, root);
  expect(Object.keys(result.cases)).toEqual(["absolute", "first PATH executable", "relative PATH", "empty PATH entry", "before earlier executable", "new earlier executable", "missing PATH", "no options", "shell", "absolute system git", "CPATH", "LIBRARY_PATH", "MANPATH", "SDKROOT", "failed git"]);
  for (const [name, value] of Object.entries(result.cases)) expect.soft(value.configured, name).toEqual(value.native);
  expect(result.identities).toEqual({ execFileSync: true, spawnSync: true, spawn: true, execFile: true, promisified: true });
  const args = ["space value", "", "$HOME", "`literal`", "--dash"];
  // Keep an independent Node reporter: shells can change PWD, SHLVL and _ before reporting env.
  for (const side of ["native", "configured"] as const) {
    expect(JSON.parse(stdout(result.cases.absolute![side]))).toEqual({
      label: "caller-git", args, cwd: root,
      env: expect.objectContaining({ PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
    });
    for (const [name, label] of [["first PATH executable", "caller-git"], ["relative PATH", "caller-git"], ["empty PATH entry", "cwd-git"], ["new earlier executable", "new-earlier-git"]] as const) {
      const fields = stdout(result.cases[name]![side]).split("\0");
      expect(fields.slice(0, 8), name).toEqual([label, String(args.length), ...args, root]);
      expect(fields).toHaveLength(9);
      expect(fields[8], name).toContain("HOME=");
      expect(fields[8], name).toContain(root);
      expect(fields[8], name).toContain("PATH=");
      expect(fields[8], name).toContain("GIT_CONFIG_GLOBAL=");
      expect(fields[8], name).toContain("GIT_CONFIG_NOSYSTEM=");
    }
  }
});
