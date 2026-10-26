import { expect, it } from "vitest";
import * as comparisons from "./helpers/native-git-comparisons.ts";
import type { Captured } from "./helpers/native-git-test.ts";

const root = "/controlled-native-probe";
const key = "SDKROOT";
const report = {
  label: "caller-git", args: ["space value", "", "$HOME", "`literal`", "--dash"], cwd: root,
  env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", SDKROOT: "/callers/own" },
};
const output = JSON.stringify(report) + "\n";
const assertEnvironment = (captured: Captured) => comparisons.assertNativeEnvironment(captured, root, key);

it("accepts an exact successful controlled observation", () => {
  assertEnvironment({ value: output });
  assertEnvironment({ value: { stdout: output, status: 0, signal: null, stderr: "" } });
});
it.each([
  { error: { message: "Failed to determine realpath of '/callers/own'", code: 72 } },
  { value: { stdout: output, status: 72, signal: null, stderr: "toolchain failure" } },
  { value: { stdout: output, status: null, signal: "SIGTERM", stderr: "" } },
  { value: JSON.stringify({ ...report, env: { ...report.env, SDKROOT: "/wrong" } }) },
  { value: JSON.stringify({ ...report, env: { ...report.env, PATH: "/changed" } }) },
  { value: JSON.stringify({ ...report, env: { ...report.env, DEVELOPER_DIR: "/injected" } }) },
  { value: JSON.stringify({ ...report, args: ["extra"] }) },
  { value: JSON.stringify({ ...report, cwd: "/wrong" }) },
  { value: JSON.stringify({ ...report, label: "WRONG-EXECUTABLE" }) },
])("rejects failure or altered observation %# rather than matching two errors", captured => {
  expect(() => assertEnvironment(captured)).toThrowError(expect.objectContaining({ name: "AssertionError" }));
});
it("allows the macOS runtime encoding field while retaining the complete caller environment", () => {
  assertEnvironment({ value: JSON.stringify({ ...report, env: { ...report.env, __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0" } }) });
});
it("rejects a malformed runtime encoding field", () => {
  expect(() => assertEnvironment({ value: JSON.stringify({ ...report, env: { ...report.env, __CF_USER_TEXT_ENCODING: "/wrong" } }) }))
    .toThrowError(expect.objectContaining({ name: "AssertionError" }));
});
