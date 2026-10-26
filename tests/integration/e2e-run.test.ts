import { createRequire } from "node:module";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareProductionRun } from "../../packages/cli/src/commands/run-compose.ts";
import { register } from "../../packages/cli/src/commands/run.ts";
import type { Message, Notifier } from "../../packages/cli/src/notify/notifier.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { createE2EProject, expectRunSound, expectTaskBlocked, expectTaskDone, fileAt, lastGreen, seedTasks, sessionCalls, type E2EProject } from "./e2e-helpers.ts";

// `jarvis run` end to end on the fake claude, through the production composition (decision 84): the command
// hosts the project's broker, a task session's bare `jarvis act` reaches it through the session's own PATH
// and socket, blocked tasks and the finished run reach the notifier, and nothing the run hosted outlives it.
// The fake runs the session's commands unsandboxed; the sandbox side of `jarvis act` is task-act.test.ts.
const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const projects: E2EProject[] = [];
afterEach(() => projects.splice(0).forEach((p) => p.cleanup()));

const ACT = `jarvis act email.send --json '{"to":"jane@example.com","subject":"Launch","body":"The multiply module is live."}'`;
const SCENARIO = {
  description: "T1 asks the broker to send an email (pending approval), then builds multiply; T2 builds clamp.",
  sessions: [
    {
      name: "T1-act-good", task: "T1",
      steps: [
        { exec: ACT, saveAs: "act.out" },
        { write: "src/multiply.mjs", lines: ["/** Returns the product of two numbers. */", "export function multiply(a, b) {", "  return a * b;", "}"] },
        { notes: "Added multiply. The launch email waits for approval." },
      ],
    },
    {
      name: "T2-good", task: "T2",
      steps: [
        { write: "src/clamp.mjs", lines: ["/** Returns x limited to the range [lo, hi]. */", "export function clamp(x, lo, hi) {", "  return Math.min(hi, Math.max(lo, x));", "}"] },
        { notes: "Added clamp." },
      ],
    },
  ],
};

describe("e2e: jarvis run on the production composition", { timeout: 600_000 }, () => {
  it("hosts the broker for a session's jarvis act, notifies a blocked task and the finish, and tears the broker down", async () => {
    const p = createE2EProject({ scenario: SCENARIO }); projects.push(p);
    seedTasks(p);
    // A task whose required check isn't installed is blocked before any session (runner/loop.ts).
    p.ledger.append({ kind: "task_created", actor: "runner", task_id: "T3", data: { title: "lint", story: "S1", criteria: [], goal: "Lint the code.", exitCondition: "lint passes", dependencies: [], priority: 0, requiredChecks: ["lint"], requiredReviews: ["code"] } });
    writeFileSync(join(p.jarvisHome, "notify.json"), JSON.stringify({ baseUrl: "https://example.invalid", topic: "fake-out", replyTopic: "fake-in" }), { mode: 0o600 });
    const sent: Message[] = [];
    const notifier: Notifier = { send: async (m) => { sent.push(m); }, poll: async () => [] };
    const output: string[] = []; const warnings: string[] = [];
    const program = new Command().exitOverride();
    register(program, {
      jarvisHome: p.jarvisHome, cwd: p.repoPath, env: { JARVIS_PROJECT: p.projectId }, output: (t) => output.push(t), keepAwake: () => {},
      probe: async () => ({ ok: true }),
      prepareRun: (context) => prepareProductionRun(context, {
        home: p.home, preflight: async () => true, reprobe: async () => true, createReview: () => async () => "pass",
        createNotifier: () => notifier, warn: (w) => warnings.push(w),
        harness: { binaryRealpath: () => p.claudeBin, session: (spec) => runSession({ ...spec, bin: p.claudeBin }), parentEnv: { HOME: p.home, USER: "e2e", LANG: "en_US.UTF-8" } },
      }),
    });
    await program.parseAsync(["run"], { from: "user" });

    expect(output).toEqual([expect.stringMatching(/^Run blocked: 2 done, 1 blocked$/)]);
    expectTaskDone(p, "T1");
    expectTaskDone(p, "T2");
    expectTaskBlocked(p, "T3");
    expectRunSound(p);
    expect(sessionCalls(p).map((c) => c.session).sort()).toEqual(["T1-act-good", "T2-good"]);

    // The session's own `jarvis act` reached the run's broker: pending, and the exact request is in the ledger.
    const act = fileAt(p, lastGreen(p)!, "act.out") ?? "";
    expect(act).toMatch(/"status": "pending"/);
    expect(act).toMatch(/EXIT:2\b/);
    const requests = p.ledger.entries().filter((e) => e.kind === "approval_request");
    expect(requests.map((e) => (e.data as { payload: unknown }).payload)).toEqual([{ to: "jane@example.com", subject: "Launch", body: "The multiply module is live." }]);
    expect(requests[0]!.actor).toBe("broker");
    expect(existsSync(join(p.projectDir, "outbox")) ? readdirSync(join(p.projectDir, "outbox")) : []).toEqual([]); // nothing executed without approval

    // Fabricio hears about the blocked task and the finished run; nothing failed to deliver.
    // The pending send also reaches the phone as an approval request (decision 117), naming the request and the action.
    expect(sent.map((m) => m.kind)).toEqual(["blocked", "approval", "finished"]);
    expect(sent[0]!.text).toMatch(/T3.*blocked.*required check unavailable: lint/);
    const req = requests[0]!.data as { approvalId: string; payloadHash: string };
    expect(sent[1]!.text).toContain(`request ${req.approvalId}, payload ${req.payloadHash.slice(0, 12)}`);
    expect(sent[1]!.text).toMatch(/approve email\.send\?.*jane@example\.com/);
    expect(sent[2]!.text).toMatch(/run blocked.*2\/3 done.*1 blocked/s);
    expect(warnings).toEqual([]);

    // The broker was the run's: no socket name is left behind.
    expect(readdirSync(join(p.jarvisHome, "run")).filter((n) => n.endsWith(".sock"))).toEqual([]);
  });
});
