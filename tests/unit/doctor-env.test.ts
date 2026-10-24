import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { pinnedClaudeBin, pinnedCodexBin } from "../../packages/cli/src/config/pins.ts";
import { runDoctor } from "../../packages/cli/src/doctor/doctor.ts";
import { shortTmp } from "../helpers.ts";

/** Doctor's version checks run the pinned binaries with the allowlisted child environment (decision 58). */
const fake = fileURLToPath(new URL("../fixtures/fake-claude-plugin.mjs", import.meta.url));
const home = shortTmp("jde-");
afterAll(() => rmSync(home, { recursive: true, force: true }));

function stub(path: string, extra = ""): void {
  mkdirSync(dirname(path), { recursive: true });
  // env -u drops what /bin/sh itself adds, so the fake logs what doctor gave it.
  writeFileSync(path, `#!/bin/sh\nexec /usr/bin/env -u PWD -u OLDPWD -u SHLVL '${process.execPath}' '${fake}' ${extra} "$@"\n`);
  chmodSync(path, 0o755);
}

describe("doctor's version checks", () => {
  it("never pass the shell's environment to the pinned binaries", async () => {
    stub(pinnedClaudeBin(home));
    stub(pinnedCodexBin(home), "--as-codex");
    const env = { HOME: home, USER: "tester", PATH: "/untrusted", JARVIS_LEAK_CANARY: "leaked", CLAUDE_CONFIG_DIR: "/untrusted/config", NODE_OPTIONS: "--invalid" };
    const checks = await runDoctor({ home, env, platform: "linux", freeBytes: () => 100 * 1024 ** 3, live: false });
    const level = (name: string) => checks.find((c) => c.name === name)?.level;
    expect(level("claude_pinned")).toBe("pass");
    expect(level("codex_pinned")).toBe("pass");
    const calls = readFileSync(join(home, ".fake-claude", "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { bin: string; envKeys: string[] });
    expect(calls.map((c) => c.bin)).toEqual(["claude", "codex"]);
    for (const c of calls) expect(c.envKeys.filter((k) => k !== "__CF_USER_TEXT_ENCODING"), c.bin).toEqual(["HOME", "PATH", "USER"]);
  });
});
