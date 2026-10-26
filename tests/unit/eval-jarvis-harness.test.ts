import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTask } from "../../packages/cli/src/eval/baseline.ts";
import { runJarvis, type RunLoopOptions } from "../../packages/cli/src/eval/jarvis.ts";
import { runSession, type SessionSpec } from "../../packages/cli/src/harness/claude/session.ts";
import { sessionCalls, writeFakeClaudeShim } from "../integration/e2e-helpers.ts";
import { createEvalFixture, FIXED, harnessLoop, markerGate, type EvalFixture } from "./eval-jarvis-fixture.ts";

const fixtures: EvalFixture[] = [];
afterEach(() => fixtures.splice(0).forEach((f) => f.cleanup()));

/**
 * The default wiring: with no harness injected, the arm builds the production Claude harness. Its one
 * session runs the fake claude (a scenario that writes the fix), through the real settings writer, args
 * builder and clean environment, so the safety envelope is checked by the fake on every launch.
 */
describe("eval jarvis: the production harness on the fake claude", () => {
  it("runs each session with the live preflight first, the task's allowlist, and the runner-owned folder denied", async () => {
    const fx = createEvalFixture();
    fixtures.push(fx);
    const scenarioPath = join(fx.root, "scenario", "scenario.json");
    mkdirSync(join(fx.root, "scenario"));
    writeFileSync(scenarioPath, JSON.stringify({ sessions: [{ name: "T1-fix", task: "T1", steps: [{ write: "src/citizen.mjs", content: FIXED }, { result: { subtype: "success", text: "Fixed." } }] }] }));
    const shim = join(fx.root, "bin", "claude");
    writeFakeClaudeShim(shim, scenarioPath);
    const specs: SessionSpec[] = [];
    const order: string[] = [];
    const preflight = async () => { order.push("preflight"); return { ok: true }; };
    const calls: RunLoopOptions[] = [];
    const r = await runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), {
      preflight, evalsRepo: fx.evalsRepo, runLoop: harnessLoop(calls), review: async () => "pass", gate: markerGate().gate,
      jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home, runId: "jarvis-h1",
      harnessSeams: {
        binaryRealpath: () => "/usr/bin/true",
        session: async (spec) => { order.push("session"); specs.push(spec); const settings = JSON.parse(readFileSync(spec.args[spec.args.indexOf("--settings") + 1]!, "utf8")); specs.push({ ...spec, settings } as SessionSpec); return runSession({ ...spec, bin: shim }); },
      },
    });
    expect(r).toMatchObject({ outcome: "complete", claimedDone: true, grade: { pass: true } });

    // The live preflight ran before the run, and again before the session (decision 59).
    expect(order).toEqual(["preflight", "preflight", "session"]);
    const spec = specs[0]!;
    const settings = (specs[1] as SessionSpec & { settings: { sandbox: { failIfUnavailable: boolean; allowUnsandboxedCommands: boolean; network: { allowedDomains: string[] }; filesystem: { denyRead: string[] } }; permissions: { deny: string[]; blockReadsOutsideWorkingDirectories: boolean } } }).settings;
    expect(spec.cwd.startsWith(`${calls[0]!.worktreeRoot}/`)).toBe(true);
    expect(spec.args).toContain("--restricted");
    expect(spec.args).toContain("--strict-mcp-config");
    expect(spec.args).toContain("--no-session-persistence");
    // Decision 114: the eval arm runs the Jarvis plugin, as `jarvis run` does (its tripwire and SessionStart hooks),
    // from a runner-owned copy, so the arm measures what production runs.
    const pluginDir = spec.args[spec.args.indexOf("--plugin-dir") + 1];
    expect(spec.args).toContain("--plugin-dir");
    expect(pluginDir?.startsWith(`${fx.jarvisHome}/`)).toBe(true);
    expect(settings.sandbox).toMatchObject({ failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: ["registry.npmjs.org", "proxy.golang.org"] } });
    expect(settings.sandbox.filesystem.denyRead).toContain(fx.jarvisHome);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([`Read(/${fx.jarvisHome}/**)`, "WebSearch", "WebFetch"]));
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    // The hidden checks sit in that denied folder; the evals repo is outside every working directory.
    expect(existsSync(join(calls[0]!.projectDir, "checks", "unit.check.json"))).toBe(true);
    expect(calls[0]!.projectDir.startsWith(`${fx.jarvisHome}/`)).toBe(true);
    expect(spec.cwd.startsWith(fx.evalsRepo)).toBe(false);
    // The fake found the full safety envelope on its one launch, and acted out the scripted session.
    expect(sessionCalls({ scenarioPath }).map((c) => [c.session, c.envelope])).toEqual([["T1-fix", []]]);
  });

  it("starts no session when the harness's own preflight fails", async () => {
    const fx = createEvalFixture();
    fixtures.push(fx);
    let n = 0;
    let sessions = 0;
    const r = await runJarvis(loadTask(fx.evalsRepo, "05-citizenship"), {
      preflight: async () => ({ ok: n++ === 0 }), evalsRepo: fx.evalsRepo, runLoop: harnessLoop(), review: async () => "pass", gate: markerGate().gate,
      jarvisHome: fx.jarvisHome, workRoot: fx.workRoot, home: fx.home,
      harnessSeams: { binaryRealpath: () => "/usr/bin/true", session: async () => { sessions++; throw new Error("must not run"); } },
    });
    expect(sessions).toBe(0);
    expect(r).toMatchObject({ outcome: "crashed", claimedDone: false });
    expect(r.error).toMatch(/session refused/);
  });
});
