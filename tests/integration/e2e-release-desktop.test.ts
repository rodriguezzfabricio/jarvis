import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { register as releaseCommand } from "../../packages/cli/src/commands/release.ts";
import { prepareProductionRun } from "../../packages/cli/src/commands/run-compose.ts";
import { register } from "../../packages/cli/src/commands/run.ts";
import { artifactDigest } from "../../packages/cli/src/release/manifest.ts";
import { releaseStatus } from "../../packages/cli/src/release/states.ts";
import { renderReport, notifierSummary } from "../../packages/cli/src/runner/report.ts";
import { rebuildState } from "../../packages/cli/src/runner/state.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import type { Message } from "../../packages/cli/src/notify/notifier.ts";
import { createE2EProject, expectTaskDone, lastGreen, seedTasks, sessionCalls, type E2EProject } from "./e2e-helpers.ts";

// The production composition end to end, as tests/integration/e2e-release.test.ts runs it: the real hosted broker and
// the real gate sandbox; the fake desktop build is a shell script that leaves a minimal .app tree (no Rust, no Tauri).

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const projects: E2EProject[] = [];
afterEach(() => projects.splice(0).forEach(p => p.cleanup()));
const sessions = [
  { name: "T1", task: "T1", steps: [{ write: "src/multiply.mjs", content: "export function multiply(a,b) { return a*b; }\n" }] },
  { name: "T2", task: "T2", steps: [{ write: "src/clamp.mjs", content: "export function clamp(x,lo,hi) { return Math.min(hi,Math.max(lo,x)); }\n" }] },
];
const build = "mkdir -p target/Matches.app/Contents/MacOS && printf '<plist>fake</plist>' > target/Matches.app/Contents/Info.plist && printf 'fake executable' > target/Matches.app/Contents/MacOS/Matches && chmod 755 target/Matches.app/Contents/MacOS/Matches";

async function run(failReleaseCheck = false) {
  const p = createE2EProject({ scenario: { sessions }, projectId: "matches" }); projects.push(p); seedTasks(p);
  writeFileSync(join(p.jarvisHome, "notify.json"), JSON.stringify({ baseUrl: "https://example.invalid", topic: "fake-out", replyTopic: "fake-in" }), { mode: 0o600 });
  const configure = new Command().exitOverride(); releaseCommand(configure, { jarvisHome: p.jarvisHome, cwd: p.repoPath, env: { JARVIS_PROJECT: p.projectId }, output: () => {} });
  await configure.parseAsync(["release", "configure", "--kind", "desktop", "--app-name", "Matches", "--bundle", "Matches.app", "--output", "target", "--build", build], { from: "user" });
  const sent: Message[] = []; const deploy = vi.fn(async () => { throw new Error("desktop release must not deploy"); });
  const program = new Command().exitOverride();
  register(program, { jarvisHome: p.jarvisHome, cwd: p.repoPath, env: { JARVIS_PROJECT: p.projectId }, output: () => {}, keepAwake: () => {}, probe: async () => ({ ok: true }),
    prepareRun: async context => { const prepared = await prepareProductionRun(context, {
      home: p.home, preflight: async () => true, reprobe: async () => true, createReview: () => async () => "pass", createNotifier: () => ({ send: async m => { sent.push(m); }, poll: async () => [] }), warn: () => {},
      harness: { binaryRealpath: () => p.claudeBin, session: spec => runSession({ ...spec, bin: p.claudeBin }), parentEnv: { HOME: p.home, USER: "e2e", LANG: "en_US.UTF-8" } },
      release: { run: deploy, ...(failReleaseCheck ? { gate: async g => {
        const { runGate } = await import("../../packages/cli/src/checks/gate.ts");
        return runGate({ ...g, check: { ...g.check, cases: [{ id: "negative", command: "exit 9" }], verify: "exit 9" } });
      } } : {}) },
    }); prepared.loop.readProcessStartTime = pid => `fake-process-${pid}`; return prepared; },
  });
  await program.parseAsync(["run"], { from: "user" });
  return { p, sent, deploy };
}

it("jarvis run retains the fake .app after cleanup and reports built, not distributed; bundle tampering lapses it", { timeout: 600_000 }, async () => {
  const { p, sent, deploy } = await run(); expectTaskDone(p, "T1"); expectTaskDone(p, "T2");
  expect(sessionCalls(p).map(c => c.session)).toEqual(["T1", "T2"]);
  const entries = p.ledger.entries(); expect(releaseStatus(entries).current?.state).toBe("built");
  const artifact = entries.find(e => (e.data as { type?: string }).type === "release.desktop-artifact")!.data as { bundlePath: string; artifactHash: string; revision: string };
  expect(artifact.revision).toBe(lastGreen(p)); expect(artifact.bundlePath.startsWith(join(p.projectDir, "artifacts") + "/")).toBe(true);
  expect(existsSync(artifact.bundlePath)).toBe(true); expect(artifactDigest(artifact.bundlePath)).toBe(artifact.artifactHash);
  const releaseGates = entries.filter(e => e.kind === "gate_result" && e.task_id === null);
  expect(releaseGates.map(e => (e.data as { check: string }).check).sort()).toEqual(["ac1", "ac2", "ac3", "desktop-build", "unit"]);
  expect(releaseGates.every(e => (e.data as { revision: string }).revision === artifact.revision && (e.data as { status: string }).status === "pass")).toBe(true);
  for (const text of [readFileSync(join(p.repoPath, ".jarvis/REPORT.md"), "utf8"), sent.find(m => m.kind === "finished")!.text]) {
    expect(text).toContain("built, not distributed"); expect(text).toContain(artifact.bundlePath); expect(text).toContain(artifact.artifactHash); expect(text).toMatch(/native smoke: not run.*input isolation/i);
  }
  expect(deploy).not.toHaveBeenCalled(); expect(entries.some(e => e.kind === "broker_request")).toBe(false);
  writeFileSync(join(artifact.bundlePath, "Contents/MacOS/Matches"), "tampered");
  const later = p.ledger.entries(); const state = rebuildState(later, { now: Date.now() });
  expect(releaseStatus(later).current).toBeUndefined(); expect(renderReport(state, later)).toMatch(/State: not-reached[\s\S]*Lapsed: built.*artifact/); expect(notifierSummary(state, later)).toContain("not-reached");
});

it("a failed release check keeps the fake desktop run from built and never invokes a deploy adapter", { timeout: 600_000 }, async () => {
  const { p, sent, deploy } = await run(true); expectTaskDone(p, "T1"); expectTaskDone(p, "T2");
  expect(releaseStatus(p.ledger.entries()).current).toBeUndefined(); expect(sent.find(m => m.kind === "finished")!.text).toContain("not-reached"); expect(deploy).not.toHaveBeenCalled();
});
