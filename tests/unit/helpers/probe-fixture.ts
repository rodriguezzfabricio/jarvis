// Shared fixture for the live canary probe tests (tests/unit/probe-*.test.ts), run against a fake claude.
// Each test file gets its own folders (this module is evaluated once per test file) and removes them
// in its own afterAll.
import { runCanaryProbe, type ProbeResult } from "../../../packages/cli/src/harness/claude/probe.ts";
import { fakeClaudeBin, shortTmp } from "../../helpers.ts";

export const dir = shortTmp("jtc-");
export const home = shortTmp("jth-");
export const bin = fakeClaudeBin(dir);

export function probe(mode: string, extra: Record<string, string> = {}): Promise<ProbeResult> {
  return runCanaryProbe({ claudeBin: bin, tmpRoot: dir, home, parentEnv: { HOME: home, USER: "t" }, extraEnv: { FAKE_CLAUDE_MODE: mode, ...extra } });
}
export const failed = (r: ProbeResult) => r.checks.filter((c) => !c.ok).map((c) => c.name);
