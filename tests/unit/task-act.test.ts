import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../../packages/cli/src/broker/broker.ts";
import { outboxAdapters } from "../../packages/cli/src/broker/outbox.ts";
import { startBrokerServer } from "../../packages/cli/src/broker/server.ts";
import type { buildTaskSettings } from "../../packages/cli/src/harness/claude/settings.ts";
import { createClaudeHarness, type ClaudeHarnessOptions } from "../../packages/cli/src/harness/claude/task.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import type { SessionOutcome, SessionSpec } from "../../packages/cli/src/proc/session.ts";
import type { TaskInput } from "../../packages/cli/src/runner/harness.ts";
import { DEFAULT_ROUTING } from "../../packages/cli/src/runner/routing.ts";
import { runSandboxed } from "../../packages/cli/src/sandbox/srt.ts";

// Codex round 18, lane D, medium: task settings didn't reopen the installed CLI, so `jarvis act` couldn't
// load inside a task session. The install is now readable, never writable, and nothing else is reopened.
const install = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
type Settings = ReturnType<typeof buildTaskSettings>;

function setup(extra: Partial<ClaudeHarnessOptions> = {}, session?: (spec: SessionSpec, settings: Settings) => Promise<void>) {
  const root = mkdtempSync(join(realpathSync("/tmp"), "jarvis-act-")); roots.push(root);
  const worktreeRoot = join(root, "worktrees"), workspace = join(worktreeRoot, "work"), jarvisHome = join(root, "runner"), cacheRoot = join(root, "caches"), home = join(root, "home");
  for (const d of [workspace, jarvisHome, cacheRoot, home]) mkdirSync(d, { recursive: true });
  const runHeaderPath = join(jarvisHome, "header.md"); writeFileSync(runHeaderPath, "header\n");
  const input: TaskInput = { workspace, prompt: "p", runHeaderPath, role: "build", tier: 1, maxTurns: 4, timeoutMs: 60_000, logPath: join(jarvisHome, "task.jsonl") };
  const seen: { spec?: SessionSpec; settings?: Settings } = {};
  const options: ClaudeHarnessOptions = {
    jarvisHome, cacheRoot, worktreeRoot, home, routing: structuredClone(DEFAULT_ROUTING), binaryRealpath: (p) => p, parentEnv: { HOME: home, USER: "t" },
    allowedDomains: [], brokerSocket: join(jarvisHome, "b.sock"), preflight: vi.fn(async () => ({ ok: true })),
    session: async (spec): Promise<SessionOutcome> => {
      seen.spec = spec;
      seen.settings = JSON.parse(readFileSync(spec.args[spec.args.indexOf("--settings") + 1]!, "utf8"));
      await session?.(spec, seen.settings!);
      writeFileSync(input.logPath, `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`);
      return { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "", stderr: "" } as SessionOutcome;
    },
    ...extra,
  };
  return { root, input, options, seen };
}

describe("jarvis act inside a task session", () => {
  it("reopens the installed CLI for reading only, and nothing else", async () => {
    const s = setup({ installDir: install });
    expect((await createClaudeHarness(s.options).runTask(s.input)).status).toBe("finished");
    const fs = s.seen.settings!.sandbox.filesystem;
    expect(fs.allowRead).toContain(install);
    expect(fs.allowWrite).not.toContain(install);
    expect(fs.denyWrite).toContain(install);
    expect(s.seen.settings!.permissions.deny).toContain(`Edit(/${install}/**)`);
    expect(s.seen.settings!.permissions.allow).toContain(`Read(/${install}/**)`);
  });

  it("refuses an install that isn't one, or overlaps the worktrees, caches or runner folder", async () => {
    const base = setup();
    const notInstall = join(base.root, "empty"); mkdirSync(notInstall);
    const link = join(base.root, "install-link"); symlinkSync(install, link);
    for (const dir of [notInstall, link, base.options.worktreeRoot, base.input.workspace, base.options.cacheRoot, base.options.jarvisHome, base.root, "relative/install"]) {
      const s = setup({ installDir: dir });
      const r = await createClaudeHarness(s.options).runTask(s.input);
      expect(r.status, dir).toBe("refused");
      expect(s.seen.spec, dir).toBeUndefined();
    }
  });

  // The pinned sandbox runtime with the task settings' own filesystem lists; Claude Code's
  // blockReadsOutsideWorkingDirectories is stood in for by denying the user's home, where this install lives.
  for (const [label, extra, want] of [["with the install reopened", { installDir: install }, "pending"], ["without it", {}, "blocked"]] as const) {
    it(`runs the installed jarvis act through the bound broker ${label}`, { timeout: 120_000 }, async () => {
      let actOut = "";
      const s = setup(extra, async (spec, settings) => {
        const fs = settings.sandbox.filesystem;
        const outFile = join(spec.cwd, "act.out");
        const r = await runSandboxed({
          policy: { denyRead: [...fs.denyRead, realpathSync(homedir())], allowRead: [...fs.allowRead, spec.cwd], allowWrite: [...fs.allowWrite, spec.cwd], allowUnixSockets: settings.sandbox.network.allowUnixSockets },
          command: `node ${install}/packages/cli/src/cli.ts act email.send --socket "$JARVIS_BROKER_SOCKET" --json '{"to":"jane@example.com","subject":"Hi","body":"Hello"}' > ${outFile} 2>&1; echo "ACT:$?" >> ${outFile}`,
          cwd: spec.cwd, env: { ...spec.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }, timeoutMs: 60_000,
        });
        expect(r.timedOut).toBe(false);
        actOut = readFileSync(outFile, "utf8");
      });
      const ledger = Ledger.open(join(s.options.jarvisHome, "projects", "p"));
      const broker = new Broker({ ledger, project: "p", adapters: outboxAdapters(join(s.options.jarvisHome, "outbox")), secrets: { get: () => undefined } });
      const server = await startBrokerServer(broker, join(s.options.jarvisHome, "b.sock"));
      try {
        s.options.brokerSocket = server.socketPath;
        expect((await createClaudeHarness(s.options).runTask(s.input)).status).toBe("finished");
        const pending = ledger.entries().some((e) => e.kind === "approval_request");
        if (want === "pending") {
          expect(actOut).toMatch(/ACT:2\b/);
          expect(pending).toBe(true);
        } else {
          expect(actOut).not.toMatch(/ACT:2\b/);
          expect(actOut).toMatch(/Operation not permitted|EPERM|Cannot find module/);
          expect(pending).toBe(false);
        }
      } finally { await server.close(); }
    });
  }
});
