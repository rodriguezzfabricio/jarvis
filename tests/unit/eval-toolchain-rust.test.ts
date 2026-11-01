import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXCLUDE, loadTask, runBaseline } from "../../packages/cli/src/eval/baseline.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { runJarvis } from "../../packages/cli/src/eval/jarvis.ts";
import { evalRustFixture } from "../../packages/cli/src/eval/toolchain.ts";
import { systemToolchainPolicy } from "../../packages/cli/src/harness/claude/toolchain.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { rustHost } from "../../packages/cli/src/toolchain/rust.ts";
import { fakeClaudeBin } from "../helpers.ts";
import { addHidden, addTask, BUG_PROMPT, createEvalFixture, FIXED, harnessLoop, markerGate, type EvalFixture } from "./eval-jarvis-fixture.ts";
import { FIXTURE_RUST, FIXTURE_TARGET, makeCommandLineTools, makeRustFixture, pinRustFixture, useCommandLineTools } from "./helpers/rust-fixture.ts";

const fixtures: EvalFixture[] = [];
afterEach(() => { fixtures.splice(0).forEach((f) => f.cleanup()); vi.restoreAllMocks(); });
type Settings = { sandbox: { filesystem: { allowRead: string[]; allowWrite: string[]; denyWrite: string[] } } };
const RUST_KEYS = ["CARGO_HOME", "CARGO_NET_OFFLINE", "SDKROOT", "DEVELOPER_DIR"] as const;
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** Task 12-rust: the eval fixture's project, with the gate's Rust fixture unless `fixture` is false. */
function rustTask(o: { fixture?: boolean } = {}) {
  const fx = createEvalFixture();
  fixtures.push(fx);
  addTask(fx, "12-rust", BUG_PROMPT, { revert: [fx.fixRev] });
  const grading = addHidden(fx, "12-rust", "checks", { unit: [] });
  const gate = addHidden(fx, "12-rust", "gate", { unit: [] });
  const fixture = join(gate, "fixtures", "rust");
  if (o.fixture !== false) { makeRustFixture(fixture); pinRustFixture(fixture); }
  const clt = realpathSync(makeCommandLineTools(join(fx.root, "clt")));
  useCommandLineTools(clt);
  vi.spyOn(systemToolchainPolicy, "roots").mockReturnValue([clt]);
  vi.spyOn(systemToolchainPolicy, "owned").mockReturnValue(true);
  return { fx, grading, gate, fixture, clt };
}

function baseline(fx: EvalFixture, runId: string, rustFixture: string, marker?: string) {
  return runBaseline(loadTask(fx.evalsRepo, "12-rust"), {
    preflight: async () => ({ ok: true }), claudeBin: fakeClaudeBin(fx.root), jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, runId,
    parentEnv: { HOME: fx.home, USER: "t" }, extraEnv: { FAKE_CLAUDE_MODE: "rust-env", ...(marker ? { FAKE_CLAUDE_MARKER: marker } : {}) },
    hiddenDirs: [join(fx.evalsRepo, "hidden", "12-rust", "checks"), join(fx.evalsRepo, "hidden", "12-rust", "gate")], rustFixture,
  });
}

async function jarvis(fx: EvalFixture, runId: string, session?: (spec: SessionSpec) => Promise<SessionOutcome>) {
  const seen: { spec: SessionSpec; settings: Settings }[] = [];
  const record = async (spec: SessionSpec): Promise<SessionOutcome> => {
    seen.push({ spec, settings: JSON.parse(readFileSync(spec.args[spec.args.indexOf("--settings") + 1]!, "utf8")) });
    writeFileSync(join(spec.cwd, "src", "citizen.mjs"), FIXED);
    writeFileSync(spec.stdoutPath!, `${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Fixed." })}\n`);
    writeFileSync(spec.stderrPath!, "");
    return { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
  };
  const r = await runJarvis(loadTask(fx.evalsRepo, "12-rust"), {
    preflight: async () => ({ ok: true }), evalsRepo: fx.evalsRepo, runLoop: harnessLoop(), review: async () => "pass", gate: markerGate().gate,
    jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home, runId,
    harnessSeams: { binaryRealpath: () => "/usr/bin/true", session: session ?? record },
  });
  return { r, seen };
}

describe("eval sessions get the gate's Rust, offline and read-only, in both arms (decision 164)", () => {
  it("baseline: the session runs the fixture's cargo, offline, with the SDK named, and the run records it", async () => {
    const { fx, fixture, clt } = rustTask();
    const r = await baseline(fx, "b1", evalRustFixture(fx.evalsRepo, "12-rust"));
    const real = realpathSync(fixture);
    expect(r.rustToolchain).toEqual({ status: "ready", rust: FIXTURE_RUST, target: FIXTURE_TARGET, tauriCli: "2.12.3", fixture: real });
    expect(json(join(r.resultsDir, "summary.json")).rustToolchain).toEqual(r.rustToolchain);
    expect(json(join(r.resultsDir, "manifest.json")).rustToolchain).toEqual(r.rustToolchain);
    const seen = json(join(r.workspace, "app.txt"));
    expect(seen).toMatchObject({ CARGO_HOME: join(real, "cargo-home"), CARGO_NET_OFFLINE: "true", SDKROOT: join(clt, "SDKs", "MacOSX26.5.sdk"), DEVELOPER_DIR: clt });
    expect(seen.cargo).toBe(join(real, "toolchain", "bin", "cargo"));
    expect(seen.PATH.split(":").slice(0, 2)).toEqual([join(real, "toolchain", "bin"), join(clt, "usr", "bin")]);
    const settings = json(join(r.resultsDir, "settings.json")) as Settings;
    expect(settings.sandbox.filesystem.allowRead).toContain(real);
    expect(settings.sandbox.filesystem.denyWrite).toContain(real);
    // A build's target/ folder is never part of the candidate the runner commits.
    expect(EXCLUDE).toContain("target/");
    const committed = safeGit(r.workspace, ["ls-tree", "-r", "--name-only", r.finalCommit], { home: fx.home }).toString();
    expect(committed).toContain("app.txt");
    expect(committed).not.toContain("target/");
  });

  it("jarvis arm: every session gets the same Rust as the baseline's", async () => {
    const { fx, fixture } = rustTask();
    const b = await baseline(fx, "b2", evalRustFixture(fx.evalsRepo, "12-rust"));
    const { r, seen } = await jarvis(fx, "j2");
    expect(r.outcome).toBe("complete");
    expect(r.rustToolchain).toEqual(b.rustToolchain);
    expect(json(join(r.resultsDir, "summary.json")).rustToolchain).toEqual(r.rustToolchain);
    expect(json(join(r.resultsDir, "manifest.json")).rustToolchain).toEqual(r.rustToolchain);
    expect(seen.length).toBeGreaterThan(0);
    const base = json(join(b.workspace, "app.txt"));
    for (const { spec, settings } of seen) {
      for (const k of RUST_KEYS) expect(spec.env[k]).toBe(base[k]);
      expect(spec.env.PATH!.split(":").slice(0, 2)).toEqual(base.PATH.split(":").slice(0, 2));
      expect(settings.sandbox.filesystem.allowRead).toContain(realpathSync(fixture));
      expect(settings.sandbox.filesystem.denyWrite).toContain(realpathSync(fixture));
    }
  });

  it("a task without a Rust fixture keeps today's sessions in both arms", async () => {
    const { fx, fixture } = rustTask({ fixture: false });
    const b = await baseline(fx, "b3", fixture);
    expect(b.rustToolchain).toEqual({ status: "not-needed" });
    expect(json(join(b.workspace, "app.txt")).CARGO_HOME).toBeNull();
    const { r, seen } = await jarvis(fx, "j3");
    expect(r.rustToolchain).toEqual({ status: "not-needed" });
    for (const { spec } of seen) expect(spec.env.CARGO_HOME).toBeUndefined();
  });

  it("fails closed: a fixture that is not the pinned one stops both arms before any session, and says why in summary.json", async () => {
    const { fx } = rustTask();
    vi.spyOn(rustHost, "pinnedFixtureSha256").mockReturnValue("0".repeat(64));
    const marker = join(fx.root, "session-started");
    await expect(baseline(fx, "b4", evalRustFixture(fx.evalsRepo, "12-rust"), marker)).rejects.toThrow(/refused: the Rust fixture is not the pinned one/);
    expect(existsSync(marker)).toBe(false);
    // A missing summary fails an assertion, not a read, so a mutation that drops it is caught (decision 146).
    expect(existsSync(join(fx.jarvisHome, "evals", "12-rust", "b4", "summary.json"))).toBe(true);
    expect(json(join(fx.jarvisHome, "evals", "12-rust", "b4", "summary.json"))).toMatchObject({ started: false, toolchain: { status: "refused", reason: expect.stringMatching(/Rust fixture is not the pinned one/) } });
    let sessions = 0;
    await expect(jarvis(fx, "j4", async () => { sessions++; throw new Error("must not run"); })).rejects.toThrow(/refused: the Rust fixture is not the pinned one/);
    expect(sessions).toBe(0);
    // A missing summary fails an assertion, not a read, so a mutation that drops it is caught (decision 146).
    expect(existsSync(join(fx.jarvisHome, "evals", "12-rust", "j4", "summary.json"))).toBe(true);
    expect(json(join(fx.jarvisHome, "evals", "12-rust", "j4", "summary.json"))).toMatchObject({ arm: "jarvis", started: false, toolchain: { status: "refused", reason: expect.stringMatching(/Rust fixture is not the pinned one/) } });
  });

  it("refuses a fixture where any run's sessions write, before a session starts", async () => {
    const { fx } = rustTask();
    const planted = join(fx.workRoot, "evals", "12-rust", "planted", "rust");
    makeRustFixture(planted);
    pinRustFixture(planted);
    const marker = join(fx.root, "session-started");
    await expect(baseline(fx, "b5", planted, marker)).rejects.toThrow(/toolchain folder must not overlap/);
    expect(existsSync(marker)).toBe(false);
  });

  it("names the gate's Rust fixture, never the grading checks", () => {
    const { fx, gate, grading } = rustTask();
    expect(evalRustFixture(fx.evalsRepo, "12-rust")).toBe(join(gate, "fixtures", "rust"));
    mkdirSync(join(grading, "fixtures", "rust"), { recursive: true });
    const other = join(fx.evalsRepo, "hidden", "12-linked");
    mkdirSync(join(other, "gate"), { recursive: true });
    symlinkSync(join(grading, "fixtures"), join(other, "gate", "fixtures"));
    symlinkSync(grading, join(other, "checks"));
    expect(() => evalRustFixture(fx.evalsRepo, "12-linked")).toThrow(/refused.*grading/);
  });
});
