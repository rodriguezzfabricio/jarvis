import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error authoritative plain .mjs classifier has no types
import { classify, testIds } from "../../scripts/mutation-classify.mjs";
import { runNativeGitProbe } from "./helpers/native-git-test.ts";

vi.mock("node:child_process", async importOriginal => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return { ...cp, spawnSync: vi.fn() };
});
afterEach(() => { vi.resetAllMocks(); });

const root = "/native-probe-fixture";
const selected = ["absolute"];
function payload(configured = "native observation") {
  return {
    identities: { execFileSync: true, spawnSync: true, spawn: true, execFile: true, promisified: true },
    cases: { absolute: { native: { value: "native observation" }, configured: { value: configured } } },
    controls: {},
    executions: [{ name: "absolute", native: true }, { name: "absolute", native: false }],
  };
}
function child(extra: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  const stdout = JSON.stringify(payload());
  return { pid: 123, status: 0, signal: null, stdout, stderr: "worker diagnostic", output: [null, stdout, "worker diagnostic"], ...extra };
}
function observe(run: () => unknown): Error {
  try { run(); } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("fixture did not reach its intended failure");
}
function probeError(result: SpawnSyncReturns<string>): Error {
  vi.mocked(spawnSync).mockReturnValueOnce(result);
  return observe(() => runNativeGitProbe("spawnSync", root, "comparisons", selected));
}
function comparisonError(): Error {
  vi.mocked(spawnSync).mockReturnValueOnce(child({ stdout: JSON.stringify(payload("changed observation")) }));
  return observe(() => {
    const result = runNativeGitProbe("spawnSync", root, "comparisons", selected);
    expect(result.cases.absolute!.configured, "absolute").toEqual(result.cases.absolute!.native);
  });
}
function classification(errors: Error[]) {
  // Feed actual thrown stacks to the real classifier, with stable ids and a completed suite record.
  const report = {
    success: false,
    testResults: [{ name: "/fixture/tests/unit/native-probe.test.ts", message: "", assertionResults: errors.map((error, i) => ({
      title: `observation ${i}`, fullName: `native probe observation ${i}`, status: "failed",
      failureMessages: [error.stack ?? `${error.name}: ${error.message}`],
    })) }],
  };
  return classify({ status: 1, signal: null }, report, testIds(report), { reason: "failed", unhandled: 0, messages: [] });
}

const spawnError = Object.assign(new Error("spawn fixture ENOENT"), { code: "ENOENT" });
const timeout = Object.assign(new Error("spawn fixture ETIMEDOUT"), { code: "ETIMEDOUT" });
const failures = [
  { name: "spawn error", result: child({ error: spawnError, status: null }), cause: spawnError },
  { name: "spawn timeout", result: child({ error: timeout, status: null, signal: "SIGTERM" }), cause: timeout },
  { name: "signal", result: child({ status: null, signal: "SIGKILL" }) },
  // Even a contradictory status 0 must not allow a signal to pass unnoticed.
  { name: "signal with zero status", result: child({ signal: "SIGTERM" }) },
  { name: "nonzero exit", result: child({ status: 7 }) },
  { name: "missing exit status", result: child({ status: null }) },
  { name: "malformed JSON", result: child({ stdout: "{broken-worker-json" }) },
  { name: "null output", result: child({ stdout: "null" }) },
  { name: "missing output fields", result: child({ stdout: "{}" }) },
  { name: "wrong output field types", result: child({ stdout: JSON.stringify({ ...payload(), executions: "not an array" }) }) },
];

describe("native probe infrastructure evidence", () => {
  for (const fixture of failures) {
    it(`classifies ${fixture.name} as infrastructure, including beside a comparison assertion`, () => {
      const error = probeError(fixture.result);
      const alone = classification([error]);
      const mixed = classification([error, comparisonError()]);
      console.info(JSON.stringify({ fixture: fixture.name, thrown: error.name, alone, mixed }));
      expect(alone.kind).toBe("error");
      expect(mixed.kind).toBe("error");
      expect(error.name).not.toBe("AssertionError");
    });
    it(`preserves ${fixture.name} process context and diagnostics`, () => {
      const error = probeError(fixture.result);
      expect(error.message).toContain("spawnSync");
      expect(error.message).toContain("comparisons");
      expect(error.message).toContain("absolute");
      expect(error.message).toContain(root);
      expect(error.message).toContain(`status=${fixture.result.status}`);
      expect(error.message).toContain(`signal=${fixture.result.signal}`);
      expect(error.message).toContain(fixture.result.stdout);
      expect(error.message).toContain(fixture.result.stderr);
      if ("cause" in fixture) {
        expect(error.cause).toBe(fixture.cause);
        expect(error.message).toContain(fixture.cause.code);
      }
    });
  }
  it("accepts a complete successful worker result", () => {
    vi.mocked(spawnSync).mockReturnValueOnce(child());
    expect(runNativeGitProbe("spawnSync", root, "comparisons", selected)).toEqual(payload());
    expect(spawnSync).toHaveBeenCalledWith(process.execPath, expect.any(Array), {
      cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10_000,
    });
  });
  it("keeps a genuine native/configured comparison assertion caught", () => {
    const error = comparisonError();
    const verdict = classification([error]);
    console.info(JSON.stringify({ fixture: "comparison control", thrown: error.name, verdict }));
    expect(error.name).toBe("AssertionError");
    expect(error.message).toContain("changed observation");
    expect(verdict.kind).toBe("caught");
  });
  it("keeps worker identity assertions behavioral", () => {
    const changed = payload();
    changed.identities.spawnSync = false;
    const error = probeError(child({ stdout: JSON.stringify(changed) }));
    expect(error.name).toBe("AssertionError");
    expect(classification([error]).kind).toBe("caught");
  });
});
