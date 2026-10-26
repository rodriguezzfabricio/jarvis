import { describe, expect, it, vi } from "vitest";
import { evaluateImpeccable, runImpeccable, impeccableDefinitions } from "../../packages/cli/src/lanes/impeccable.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";

const outcome = (stdout = "[]", code = 0): SessionOutcome => ({ stdout, code, stderr: "", timedOut: false, overflowed: false, durationMs: 1 });
const finding = { antipattern: "overused-font", severity: "warning", message: "Choose deliberate type", file: "App.tsx", line: 1 };
const pin = { bin: "/tools/impeccable", version: "0.1.16", sha256: "e".repeat(64) };

describe("Impeccable protocol", () => {
  it("passes clean and advisory-only scans, fails primary findings", () => {
    expect(evaluateImpeccable(outcome()).status).toBe("pass");
    expect(evaluateImpeccable(outcome(JSON.stringify([{ ...finding, severity: "advisory" }]))).status).toBe("pass");
    expect(evaluateImpeccable(outcome(JSON.stringify([finding]), 2)).status).toBe("fail");
    expect(evaluateImpeccable(outcome(JSON.stringify([{antipattern:"generic-copy"}]),2)).status).toBe("fail");
  });
  it.each([outcome("garbage"), outcome("{}"), outcome("[{}]"), outcome("[]", 2), outcome("[]", 1), outcome("[]", null as unknown as number), outcome(JSON.stringify([finding])), { ...outcome(), timedOut: true }, { ...outcome(), overflowed: true }, outcome(JSON.stringify([{...finding, severity: "unknown"}]))])("fails closed on bad output or process failure %#", raw => {
    expect(evaluateImpeccable(raw).status).toBe("error");
  });
  it("caps findings and raw output", () => {
    expect(evaluateImpeccable(outcome(JSON.stringify(Array(1001).fill(finding)), 2)).status).toBe("error");
    expect(evaluateImpeccable(outcome(" ".repeat(1024 * 1024) + "[]")).status).toBe("error");
  });
});

describe("pinned sandbox scanner", () => {
  function setup(version = "0.1.16+engine\n") {
    const spawn = vi.fn(async (s: SessionSpec) => s.args[0] === "--version" ? outcome(version) : outcome());
    return { repo: "/checkout", pin, spawn, isFile: () => true, hashFile: (_path: string) => pin.sha256 };
  }
  it("refuses an engine file whose hash differs from the pin before running anything (decision 124)", async () => {
    const options = { ...setup(), hashFile: () => "f".repeat(64) };
    const result = await runImpeccable(options, { kind: "source", files: ["a.tsx"] });
    expect(result).toMatchObject({ status: "error", error: expect.stringContaining("sha256") });
    expect(options.spawn).not.toHaveBeenCalled();
    // A pin without a hash is refused even when the file's hash "matches" it.
    const unpinned = { ...setup(), hashFile: () => "" };
    expect((await runImpeccable({ ...unpinned, pin: { ...pin, sha256: "" } }, { kind: "source", files: ["a.tsx"] })).status).toBe("error");
    expect(unpinned.spawn).not.toHaveBeenCalled();
  });
  it("hashes the pinned engine file itself by default", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "impeccable-pin-"));
    try {
      const bin = join(dir, "impeccable"); writeFileSync(bin, "engine bytes");
      const sha256 = createHash("sha256").update("engine bytes").digest("hex");
      const { hashFile: _seam, ...options } = setup();
      expect((await runImpeccable({ ...options, isFile: undefined as never, pin: { ...pin, bin, sha256 } }, { kind: "source", files: ["a.tsx"] })).status).toBe("pass");
      writeFileSync(bin, "swapped engine");
      const swapped = setup(); const { hashFile: _unused, ...rest } = swapped;
      expect((await runImpeccable({ ...rest, isFile: undefined as never, pin: { ...pin, bin, sha256 } }, { kind: "source", files: ["a.tsx"] })).status).toBe("error");
      expect(swapped.spawn).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("checks the absolute engine pin before scanning only named changed files without inline ignores", async () => {
    const options = setup();
    expect((await runImpeccable(options, { kind: "source", files: ["src/App.tsx", "src/style.css"] })).status).toBe("pass");
    expect(options.spawn.mock.calls.map(([s]) => s.bin)).toEqual([pin.bin, pin.bin]);
    expect(options.spawn.mock.calls[1]![0].args).toEqual(["detect", "--json", "--no-config", "--no-inline-ignores", "/checkout/src/App.tsx", "/checkout/src/style.css"]);
    expect(options.spawn.mock.calls[0]![0].env).toEqual({ PATH: "/usr/bin:/bin", DO_NOT_TRACK: "1", IMPECCABLE_NO_TELEMETRY: "1" });
  });
  it("URL scans require the runner CDP endpoint and leave overlays visible", async () => {
    const options = setup();
    expect((await runImpeccable(options, { kind: "url", port: 9222, url: "http://127.0.0.1:3000/" })).status).toBe("pass");
    expect(options.spawn.mock.calls[1]![0].args).toEqual(["detect", "--json", "--no-config", "--no-inline-ignores", "--no-overlay-hiding", "--no-consent-hiding", "--cdp", "9222", "--target", "http://127.0.0.1:3000/"]);
  });
  it.each(["0.1.17", "garbage 0.1.16", "0.1.16\nother"]) ("refuses wrong version %s", async version => {
    const options = setup(version);
    expect((await runImpeccable(options, { kind: "source", files: ["a.tsx"] })).status).toBe("error");
    expect(options.spawn).toHaveBeenCalledTimes(1);
  });
  it.each([[], ["../secret"], ["--ignore"], ["/outside"], ["a/../b"], ["a\\b"]].map(files => ({files})))("rejects unsafe source scope $files", async ({files}) => {
    const options = setup();
    expect((await runImpeccable(options, { kind: "source", files })).status).toBe("error");
    expect(options.spawn).not.toHaveBeenCalled();
  });
  it("refuses absent binary, PATH pin, external URL, missing sandbox and crash", async () => {
    expect((await runImpeccable({ ...setup(), isFile: () => false }, {kind: "source", files: ["a.tsx"]})).status).toBe("error");
    expect((await runImpeccable({ ...setup(), pin: {...pin, bin: "impeccable"} }, {kind: "source", files: ["a.tsx"]})).status).toBe("error");
    expect((await runImpeccable(setup(), {kind: "url", port: 9222, url: "https://example.com"})).status).toBe("error");
    expect((await runImpeccable({...setup(), spawn: undefined as never}, {kind: "source", files: ["a.tsx"]})).status).toBe("error");
    expect((await runImpeccable({...setup(), spawn: async () => { throw new Error("crash"); }}, {kind: "source", files: ["a.tsx"]})).status).toBe("error");
  });
  it("defines both protected checks with a separate verifier", () => {
    const definitions = impeccableDefinitions({ nodeBin: "/node", driver: "impeccable-driver.ts", verifier: "impeccable-verify.ts", config: "impeccable.json" });
    expect(Object.keys(definitions)).toEqual(["impeccable-source", "impeccable-url"]);
    for (const def of Object.values(definitions)) {
      expect(def.cases[0]!.command).toContain("$JARVIS_FIXTURES");
      expect(def.verify).toContain("$JARVIS_CHECKS");
      expect(def.verify).toContain("impeccable-verify.ts");
    }
    expect(definitions["impeccable-url"].allowLocalBinding).toBe(true);
  });
});
