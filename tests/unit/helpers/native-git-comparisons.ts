import { rmSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { shortTmp } from "../../helpers.ts";
import { comparisonBatches, runNativeGitProbe, type Captured } from "./native-git-test.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function stdout(captured: Captured): string {
  expect(captured.error).toBeUndefined();
  if (typeof captured.value !== "string") expect(captured.value).toEqual(expect.objectContaining({ status: 0, signal: null }));
  return typeof captured.value === "string" ? captured.value : captured.value!.stdout;
}
export function assertNativeEnvironment(captured: Captured, root: string, key: string): void {
  const observation = JSON.parse(stdout(captured));
  // macOS can add this runtime field even with an explicit env. The pair still compares it exactly.
  const runtime = observation.env?.__CF_USER_TEXT_ENCODING;
  if (runtime !== undefined) expect(runtime).toMatch(/^0x[\da-f]+:0x[\da-f]+:0x[\da-f]+$/i);
  expect(observation).toEqual({
    label: "caller-git", args: ["space value", "", "$HOME", "`literal`", "--dash"], cwd: root,
    env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", [key]: "/callers/own",
      ...(runtime === undefined ? {} : { __CF_USER_TEXT_ENCODING: runtime }),
    },
  });
}
function failure(api: string, captured: Captured, detail: string, code: number) {
  if (api === "spawn" || api === "spawnSync") {
    expect(captured.error).toBeUndefined();
    expect(captured.value).toEqual(expect.objectContaining({ stdout: "", status: code, signal: null, stderr: expect.stringContaining(detail) }));
  } else {
    expect(captured.value).toBeUndefined();
    expect(captured.error).toEqual(expect.objectContaining({ message: expect.stringContaining(detail) }));
    // Node's sync exception has status rather than code; execFile callback errors carry code.
    if (api !== "execFileSync") expect(captured.error).toEqual(expect.objectContaining({ code }));
    if (api !== "execFile") expect(captured.error).toEqual(expect.objectContaining({ stderr: expect.stringContaining(detail) }));
  }
}
export function nativeGitComparisons(api: string) {
  for (const selected of comparisonBatches) it(`keeps native ${api} execution: ${selected.join(", ")}`, () => {
    const root = shortTmp("jgn-"); roots.push(root);
    const result = runNativeGitProbe(api, root, "comparisons", selected);
    for (const [name, value] of Object.entries(result.cases)) expect.soft(value.configured, name).toEqual(value.native);
    const args = ["space value", "", "$HOME", "`literal`", "--dash"];
    // Keep an independent Node reporter: shells can change PWD, SHLVL and _ before reporting env.
    for (const side of ["native", "configured"] as const) {
      if (result.cases.absolute) expect(JSON.parse(stdout(result.cases.absolute[side]))).toEqual({
        label: "caller-git", args, cwd: root,
        env: expect.objectContaining({ PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
      });
      for (const name of ["before earlier executable", "missing PATH", "no options", "shell", "absolute system git"]) {
        if (selected.includes(name)) expect(stdout(result.cases[name]![side]), name).toMatch(/^git version .+\n$/);
      }
      for (const key of ["CPATH", "LIBRARY_PATH", "MANPATH", "SDKROOT"]) {
        if (!selected.includes(key)) continue;
        assertNativeEnvironment(result.cases[key]![side], root, key);
      }
      if (selected.includes("failed git")) failure(api, result.cases["failed git"]![side], "unknown option: --not-a-real-option", 129);
      for (const [name, label] of [["first PATH executable", "caller-git"], ["relative PATH", "caller-git"], ["empty PATH entry", "cwd-git"], ["new earlier executable", "new-earlier-git"]] as const) {
        if (!selected.includes(name)) continue;
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
}
