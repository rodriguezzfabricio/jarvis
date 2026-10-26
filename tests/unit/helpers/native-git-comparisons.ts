import { rmSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { shortTmp } from "../../helpers.ts";
import { comparisonBatches, runNativeGitProbe, type Captured } from "./native-git-test.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function stdout(captured: Captured): string {
  expect(captured.error).toBeUndefined();
  return typeof captured.value === "string" ? captured.value : captured.value!.stdout;
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
        if (key === "SDKROOT" && process.platform === "darwin") {
          failure(api, result.cases[key]![side], "Failed to determine realpath of '/callers/own'", 72);
          continue;
        }
        const output = stdout(result.cases[key]![side]);
        expect(output, key).toContain(`HOME=${root}\n`);
        // Git prepends its exec directory; the native shim can also extend caller variables.
        expect(output, key).toMatch(/(?:^|\n)PATH=(?:[^\n]*:)?\/usr\/bin:\/bin\n/);
        const variable = output.split("\n").find(line => line.startsWith(`${key}=`));
        expect(variable, key).toMatch(new RegExp(`^${key}=.+$`));
        if (key !== "SDKROOT") expect(variable!.slice(key.length + 1).split(":"), key).toContain("/callers/own");
        expect(output, key).toContain("GIT_CONFIG_GLOBAL=/dev/null\n");
        expect(output, key).toContain("GIT_CONFIG_NOSYSTEM=1\n");
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
