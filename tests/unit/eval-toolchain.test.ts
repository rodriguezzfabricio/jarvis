import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTask, runBaseline } from "../../packages/cli/src/eval/baseline.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { runJarvis } from "../../packages/cli/src/eval/jarvis.ts";
import { evalGoFixture, evalToolchainDir } from "../../packages/cli/src/eval/toolchain.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { fakeClaudeBin } from "../helpers.ts";
import { addHidden, addTask, BUG_PROMPT, createEvalFixture, FIXED, harnessLoop, markerGate, type EvalFixture } from "./eval-jarvis-fixture.ts";
import { FIXTURE_GO, makeGoFixture, toolchainModule } from "./helpers/go-fixture.ts";

const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));
const GO_KEYS = ["GOTOOLCHAIN", "GOMODCACHE", "GOPROXY", "GOSUMDB", "GOFLAGS", "CGO_ENABLED"] as const;
type Settings = { sandbox: { filesystem: { allowRead: string[]; allowWrite: string[]; denyWrite: string[] } } };

/** Task 05-go: the eval fixture's project plus a go.mod, with the gate's Go fixture unless `fixture` is false. */
function goTask(o: { fixture?: boolean } = {}) {
  const fx = createEvalFixture();
  fixtures.push(fx);
  writeFileSync(join(fx.sourceRepo, "go.mod"), "module example.com/jobs\n\ngo 1.26.10\n");
  safeGit(fx.sourceRepo, ["add", "-A"], { home: fx.home });
  safeGit(fx.sourceRepo, ["commit", "-q", "-m", "go module"], { home: fx.home });
  const rev = safeGit(fx.sourceRepo, ["rev-parse", "HEAD"], { home: fx.home }).toString().trim();
  addTask(fx, "05-go", BUG_PROMPT, { rev, revert: [fx.fixRev] });
  const grading = addHidden(fx, "05-go", "checks", { unit: [] });
  const gate = addHidden(fx, "05-go", "gate", { unit: [] });
  if (o.fixture !== false) makeGoFixture(join(gate, "fixtures", "gomodcache"));
  return { fx, task: loadTask(fx.evalsRepo, "05-go"), grading, gate, fixture: join(gate, "fixtures", "gomodcache") };
}

function baseline(fx: EvalFixture, runId: string, goFixture: string, logs: string[] = []) {
  const task = loadTask(fx.evalsRepo, "05-go");
  return runBaseline(task, {
    preflight: async () => ({ ok: true }), claudeBin: fakeClaudeBin(fx.root), jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, runId,
    parentEnv: { HOME: fx.home, USER: "t" }, extraEnv: { FAKE_CLAUDE_MODE: "go-env" }, hiddenDirs: [join(fx.evalsRepo, "hidden", "05-go", "checks"), join(fx.evalsRepo, "hidden", "05-go", "gate")],
    goFixture, log: (m) => logs.push(m),
  });
}

/** The Jarvis arm with a session seam that records what each session got and writes the fix. */
async function jarvis(fx: EvalFixture, runId: string, logs: string[] = []) {
  const seen: { spec: SessionSpec; settings: Settings }[] = [];
  const session = async (spec: SessionSpec): Promise<SessionOutcome> => {
    seen.push({ spec, settings: JSON.parse(readFileSync(spec.args[spec.args.indexOf("--settings") + 1]!, "utf8")) });
    writeFileSync(join(spec.cwd, "src", "citizen.mjs"), FIXED);
    writeFileSync(spec.stdoutPath!, `${JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Fixed." })}\n`);
    writeFileSync(spec.stderrPath!, "");
    return { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" };
  };
  const r = await runJarvis(loadTask(fx.evalsRepo, "05-go"), {
    preflight: async () => ({ ok: true }), evalsRepo: fx.evalsRepo, runLoop: harnessLoop(), review: async () => "pass", gate: markerGate().gate,
    jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home, runId, log: (m) => logs.push(m),
    harnessSeams: { binaryRealpath: () => "/usr/bin/true", session },
  });
  return { r, seen };
}

const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("eval sessions get the gate's Go, offline and read-only, in both arms (decision 123)", () => {
  it("baseline: the session runs the pinned go with the fixture's module cache, and the run records it", async () => {
    const { fx, fixture } = goTask();
    const r = await baseline(fx, "b1", fixture);
    const real = realpathSync(fixture);
    expect(r.toolchain).toEqual({ status: "ready", version: FIXTURE_GO, modCache: real });
    expect(json(join(r.resultsDir, "summary.json")).toolchain).toEqual(r.toolchain);
    expect(json(join(r.resultsDir, "manifest.json")).toolchain).toEqual(r.toolchain);
    const seen = json(join(r.workspace, "app.txt"));
    expect(seen).toMatchObject({ GOTOOLCHAIN: "local", GOMODCACHE: real, GOPROXY: "off", GOSUMDB: "off", GOFLAGS: "-buildvcs=false -mod=readonly", CGO_ENABLED: "0" });
    expect(seen.goVersion).toContain(`go version ${FIXTURE_GO}`);
    expect(seen.PATH.split(":")[0]).toMatch(new RegExp(`/toolchains/05-go/b1/${toolchainModule().replace(/[.@]/g, "\\$&")}/bin$`));
    expect(seen.GOCACHE.startsWith(realpathSync(join(fx.workRoot, "cache-runs", "05-go")))).toBe(true);
    const settings = json(join(r.resultsDir, "settings.json")) as Settings;
    for (const d of [real, realpathSync(join(fx.workRoot, "toolchains", "05-go"))]) {
      expect(settings.sandbox.filesystem.allowRead.some((a) => a === d || a.startsWith(`${d}/`))).toBe(true);
      expect(settings.sandbox.filesystem.denyWrite.some((a) => a === d || a.startsWith(`${d}/`))).toBe(true);
    }
    // The unpacked toolchain goes with the run's cache.
    expect(existsSync(evalToolchainDir(fx.workRoot, "05-go", "b1"))).toBe(false);
    expect(existsSync(fixture)).toBe(true);
  });

  it("baseline: without a fixture the session still starts with the host's go, and the run says so", async () => {
    const { fx, fixture } = goTask({ fixture: false });
    const logs: string[] = [];
    const run = baseline(fx, "b2", fixture, logs);
    await expect(run).resolves.toMatchObject({ started: true });
    const r = await run;
    expect(r.toolchain).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/no Go fixture at/) });
    expect(json(join(r.resultsDir, "summary.json")).toolchain).toEqual(r.toolchain);
    expect(logs.join("\n")).toMatch(/05-go b2: go toolchain unavailable: no Go fixture at/);
    const seen = json(join(r.workspace, "app.txt"));
    expect(seen.GOTOOLCHAIN).toBeNull();
    expect(seen.GOMODCACHE.startsWith(realpathSync(join(fx.workRoot, "cache-runs", "05-go")))).toBe(true);
  });

  it("jarvis arm: every session gets the same Go as the baseline's, and the run records and removes it", async () => {
    const { fx, fixture } = goTask();
    const b = await baseline(fx, "b3", fixture);
    const { r, seen } = await jarvis(fx, "j3");
    expect(r.outcome).toBe("complete");
    expect(r.toolchain).toEqual(b.toolchain);
    expect(json(join(r.resultsDir, "summary.json")).toolchain).toEqual(r.toolchain);
    expect(json(join(r.resultsDir, "manifest.json")).toolchain).toEqual(r.toolchain);
    expect(seen.length).toBeGreaterThan(0);
    const base = json(join(b.workspace, "app.txt"));
    for (const { spec, settings } of seen) {
      // Fairness: the same Go variables, the same toolchain module first on PATH, the same read-only fixture.
      for (const k of GO_KEYS) expect(spec.env[k]).toBe(base[k]);
      expect(spec.env.PATH!.split(":")[0]!.endsWith(`/${toolchainModule()}/bin`)).toBe(true);
      expect(base.PATH.split(":")[0].endsWith(`/${toolchainModule()}/bin`)).toBe(true);
      expect(settings.sandbox.filesystem.allowRead).toContain(realpathSync(fixture));
      expect(settings.sandbox.filesystem.denyWrite).toContain(realpathSync(fixture));
    }
    expect(existsSync(evalToolchainDir(fx.workRoot, "05-go", "j3"))).toBe(false);
  });

  it("jarvis arm: without a fixture the sessions still run on the host's go, and the run says so", async () => {
    const { fx } = goTask({ fixture: false });
    const logs: string[] = [];
    const run = jarvis(fx, "j4", logs);
    await expect(run).resolves.toMatchObject({ r: { outcome: "complete" } });
    const { r, seen } = await run;
    expect(r.toolchain).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/no Go fixture at/) });
    expect(logs.join("\n")).toMatch(/05-go j4: go toolchain unavailable/);
    for (const { spec } of seen) expect(spec.env.GOTOOLCHAIN).toBeUndefined();
  });

  it("refuses a fixture where any run's sessions write, before a session starts, in both arms", async () => {
    const { fx, fixture } = goTask();
    // A copy of the fixture under the eval workspaces' folder, which baseline sessions write.
    const planted = join(fx.workRoot, "evals", "05-go", "planted", "gomodcache");
    makeGoFixture(planted);
    const marker = join(fx.root, "session-started");
    const task = loadTask(fx.evalsRepo, "05-go");
    await expect(runBaseline(task, {
      preflight: async () => ({ ok: true }), claudeBin: fakeClaudeBin(fx.root), jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, runId: "b5",
      parentEnv: { HOME: fx.home, USER: "t" }, extraEnv: { FAKE_CLAUDE_MODE: "go-env", FAKE_CLAUDE_MARKER: marker }, goFixture: planted,
    })).rejects.toThrow(/toolchain folder must not overlap/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(evalToolchainDir(fx.workRoot, "05-go", "b5"))).toBe(false);
    // The Jarvis arm reads its evals repo's gate fixture: an evals repo inside the work root is refused the same way.
    const evalsCopy = join(fx.workRoot, "evals", "05-go", "evals-copy");
    cpSync(fx.evalsRepo, evalsCopy, { recursive: true });
    let sessions = 0;
    await expect(runJarvis(loadTask(evalsCopy, "05-go"), {
      preflight: async () => ({ ok: true }), evalsRepo: evalsCopy, runLoop: harnessLoop(), review: async () => "pass", gate: markerGate().gate,
      jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home, runId: "j5",
      harnessSeams: { binaryRealpath: () => "/usr/bin/true", session: async () => { sessions++; throw new Error("must not run"); } },
    })).rejects.toThrow(/toolchain folder must not overlap/);
    expect(sessions).toBe(0);
    expect(existsSync(evalToolchainDir(fx.workRoot, "05-go", "j5"))).toBe(false);
    expect(existsSync(fixture)).toBe(true);
  });

  it("names the gate's module cache, never the grading checks", () => {
    const { fx, gate, grading } = goTask();
    expect(evalGoFixture(fx.evalsRepo, "05-go")).toBe(join(gate, "fixtures", "gomodcache"));
    // A gate whose fixtures lead into the grading folder is refused before anything runs.
    mkdirSync(join(grading, "fixtures", "gomodcache"), { recursive: true });
    const other = join(fx.evalsRepo, "hidden", "05-linked");
    mkdirSync(join(other, "gate"), { recursive: true });
    symlinkSync(join(grading, "fixtures"), join(other, "gate", "fixtures"));
    symlinkSync(grading, join(other, "checks"));
    expect(() => evalGoFixture(fx.evalsRepo, "05-linked")).toThrow(/refused.*grading/);
  });
});
