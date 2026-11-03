import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const source = readFileSync(new URL("./helpers/native-git-probe.mjs", import.meta.url), "utf8");
const root = "/controlled-native-probe";
const callerArgs = ["space value", "", "$HOME", "`literal`", "--dash"];
const keys = ["CPATH", "LIBRARY_PATH", "MANPATH", "SDKROOT"];
type Call = { file: string; args: string[]; options?: { cwd?: string; env?: Record<string, string> } };

// Execute the actual probe's construction with no host process or filesystem access.
async function invocations(selected: string[], input = source) {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  const spawnSync = (file: string, args: string[], options?: Call["options"]) => {
    calls.push({ file, args, ...(options === undefined ? {} : { options }) });
    return { stdout: "controlled observation", stderr: "", status: 0, signal: null };
  };
  const execFile = () => {};
  let output = "", cwd = root;
  const processDouble = {
    argv: ["node", "probe", "spawnSync", root, "comparisons", JSON.stringify(selected)],
    execPath: "/controlled/node", cwd: () => cwd, chdir: (dir: string) => { cwd = dir; },
    stdout: { write: (value: string) => { output += value; } },
  };
  await runInNewContext(`(async () => {\n${input.replace(/^import .*;\n/gm, "")}\n})()`, {
    cp: { spawnSync, execFileSync: () => {}, spawn: () => {}, execFile },
    spawnSync, execFileSync: () => {}, spawn: () => {}, execFile, promisify, join,
    mkdirSync: () => {}, writeFileSync: (path: string, value: string) => files.set(path, value),
    process: processDouble, useRealGit: () => {},
  });
  return { calls, files, result: JSON.parse(output) };
}
function assertCaller(call: Call, key: string) {
  expect(call).toEqual({ file: join(root, "absolute", "git"), args: callerArgs, options: {
    cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", [key]: "/callers/own" },
  } });
}

it.each(keys)("constructs %s observations using the controlled executable, never a tool launcher", async key => {
  const { calls, files, result } = await invocations([key]);
  expect(calls).toHaveLength(2);
  for (const call of calls) assertCaller(call, key);
  expect(files.get(join(root, "absolute", "git"))).toContain("#!/controlled/node\n");
  expect(result.executions).toEqual([{ name: key, native: true }, { name: key, native: false }]);
  expect(Object.keys(result.cases)).toEqual([key]);
  expect(result.controls).toEqual({});
});

it("detects incorrect caller forwarding without executing the changed command", async () => {
  const broken = source.replace("[key]: '/callers/own'", "[key]: '/wrong'");
  expect(broken).not.toBe(source);
  const { calls } = await invocations(["SDKROOT"], broken);
  expect(calls).toHaveLength(2);
  expect(() => assertCaller(calls[0]!, "SDKROOT")).toThrow();
});

it("retains native missing-PATH, no-options and explicit system lookup construction", async () => {
  const { calls } = await invocations(["missing PATH", "no options", "absolute system git"]);
  expect(calls).toEqual([
    ...Array.from({ length: 2 }, () => ({ file: "git", args: ["--version"], options: { cwd: root, env: { HOME: root } } })),
    ...Array.from({ length: 2 }, () => ({ file: "git", args: ["--version"] })),
    ...Array.from({ length: 2 }, () => ({ file: "/usr/bin/git", args: ["--version"], options: {
      cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    } })),
  ]);
});
