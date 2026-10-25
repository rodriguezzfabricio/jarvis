// Session tests, part 2 of 2 (lifecycle hooks). The tests are split over two files so they run in parallel;
// the shared fixture is tests/unit/helpers/session-fixture.ts.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SessionStartError, runSession } from "../../packages/cli/src/harness/claude/session.ts";
import { base, dir } from "./helpers/session-fixture.ts";

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The runner records a session's process group before anything in it runs (runner/loop.ts), and
// marks it exited only once every process in it is gone.
describe("session lifecycle hooks: onSpawn and onGroupExit (stage 3 runner loop)", () => {
  const groupGone = (id: number) => {
    try { process.kill(-id, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  // A Node child that writes a marker as soon as it runs, then leaves a SIGTERM-resistant descendant.
  const writer = (name: string) => {
    const marker = join(dir, `${name}.ran`);
    const pidFile = join(dir, `${name}.desc`);
    const script = join(dir, `${name}.mjs`);
    writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`);
    const leader = join(dir, name);
    writeFileSync(leader, `#!/bin/sh\n"${process.execPath}" ${script}\nsh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' > /dev/null 2>&1 &\nsleep 0.3\necho leader-done\n`);
    chmodSync(leader, 0o755);
    return { leader, marker, pidFile };
  };
  const busyWait = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* hold the event loop, as a slow ledger write would */ } };

  it("calls onSpawn with the group ID before anything in the group runs, then runs the session", async () => {
    const { leader, marker } = writer("accept");
    const seen: { id: number; ranBefore: boolean }[] = [];
    const out = await runSession({ ...base, bin: leader, killGraceMs: 300, onSpawn: (id) => {
      busyWait(1_500); // long enough for an unstopped child to have written its marker
      seen.push({ id, ranBefore: existsSync(marker) });
      return true;
    } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBeGreaterThan(1);
    expect(seen[0]!.ranBefore).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("leader-done");
  }, 20_000);

  it("calls onGroupExit once, with the same ID, only after the whole group (descendants too) is gone", async () => {
    const { leader, pidFile } = writer("exit");
    let spawned = 0;
    const exits: { id: number; groupGone: boolean; descendantGone: boolean }[] = [];
    await runSession({ ...base, bin: leader, killGraceMs: 300,
      onSpawn: (id) => { spawned = id; return true; },
      onGroupExit: (id) => {
        const desc = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        let descendantGone = false;
        try { process.kill(desc, 0); } catch { descendantGone = true; }
        exits.push({ id, groupGone: groupGone(id), descendantGone });
      } });
    expect(exits).toEqual([{ id: spawned, groupGone: true, descendantGone: true }]);
  }, 20_000);

  it("shuts the group down and runs nothing when onSpawn returns false", async () => {
    const { leader, marker } = writer("refuse");
    let spawned = 0;
    const exits: number[] = [];
    const t0 = Date.now();
    const out = await runSession({ ...base, bin: leader, onSpawn: (id) => { spawned = id; return false; }, onGroupExit: (id) => exits.push(id) });
    expect(Date.now() - t0).toBeLessThan(5_000); // no SIGTERM grace for a group that never ran
    expect(out.code).toBeNull();
    expect(out.stdout).not.toContain("leader-done");
    await new Promise((res) => setTimeout(res, 1_000));
    expect(existsSync(marker)).toBe(false);
    expect(groupGone(spawned)).toBe(true);
    expect(exits).toEqual([spawned]);
  }, 20_000);

  it("shuts the group down, runs nothing, and rethrows once the group is gone when onSpawn throws", async () => {
    const { leader, marker } = writer("throw");
    let spawned = 0;
    const exits: number[] = [];
    await expect(runSession({ ...base, bin: leader, onSpawn: (id) => { spawned = id; throw new Error("ledger write failed"); }, onGroupExit: (id) => exits.push(id) }))
      .rejects.toThrow("ledger write failed");
    await new Promise((res) => setTimeout(res, 1_000));
    expect(existsSync(marker)).toBe(false);
    expect(groupGone(spawned)).toBe(true);
    expect(exits).toEqual([spawned]);
  }, 20_000);

  // Codex review 19 (A, B, D, medium): a parent-side SIGSTOP after spawn races the payload. The payload
  // must never exec before onSpawn approves, so a shell script's very first command can't run either.
  for (const refusal of ["returns false", "throws"] as const) {
    it(`a payload whose first action writes a marker leaves none when onSpawn ${refusal}`, async () => {
      const marker = join(dir, `first-action-${refusal.replace(" ", "-")}.ran`);
      const payload = join(dir, `first-action-${refusal.replace(" ", "-")}`);
      writeFileSync(payload, `#!/bin/sh\n: > ${marker}\nsleep 5\n`);
      chmodSync(payload, 0o755);
      const onSpawn = () => { busyWait(500); if (refusal === "throws") throw new Error("refused"); return false; };
      const run = runSession({ ...base, bin: payload, onSpawn });
      if (refusal === "throws") await expect(run).rejects.toThrow("refused"); else await run;
      await new Promise((res) => setTimeout(res, 500));
      expect(existsSync(marker)).toBe(false);
    }, 20_000);
  }

  it("has not executed the payload yet when onSpawn runs: the group's leader is still the hold", async () => {
    const payload = join(dir, "not-yet-execed");
    writeFileSync(payload, "#!/bin/sh\nexit 0\n");
    chmodSync(payload, 0o755);
    let command = "";
    await runSession({ ...base, bin: payload, onSpawn: (id) => {
      command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(id)], { encoding: "utf8" }).trim();
      return true;
    } });
    expect(command.startsWith(payload)).toBe(false); // the payload is only an argument of the hold so far
    expect(command).toMatch(/^\/bin\/sh -c read _ <&3 /);
  });

  it("passes argv through unchanged and adds nothing to the payload's environment", async () => {
    const script = "console.log(JSON.stringify({ argv: process.argv.slice(1), env: process.env }))";
    const args = ["-e", script, "a b", "$HOME", "'q'", "", "-u", "X=1", "--"];
    const out = await runSession({ ...base, bin: process.execPath, args, env: { ONLY: "this", PATH: "/usr/bin:/bin" }, onSpawn: () => true });
    const seen = JSON.parse(out.stdout) as { argv: string[]; env: Record<string, string> };
    expect(seen.argv).toEqual(["a b", "$HOME", "'q'", "", "-u", "X=1", "--"]);
    delete seen.env.__CF_USER_TEXT_ENCODING; // macOS adds this to every process it starts
    expect(seen.env).toEqual({ ONLY: "this", PATH: "/usr/bin:/bin" });
  });

  it("keeps the session's process group identity: the payload is the group leader onSpawn saw", async () => {
    let seen = 0;
    const out = await runSession({ ...base, bin: "/bin/sh", args: ["-c", "echo $$; /bin/ps -o pgid= -p $$"], onSpawn: (id) => { seen = id; return true; } });
    const [pid, pgid] = out.stdout.trim().split("\n").map((s) => Number(s.trim()));
    expect(pid).toBe(seen); expect(pgid).toBe(seen);
  });

  it("still rejects a held session whose binary can't be started", async () => {
    const onSpawn = vi.fn(() => true);
    await expect(runSession({ ...base, bin: join(dir, "no-such-held-claude"), onSpawn })).rejects.toBeInstanceOf(SessionStartError);
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("never calls onGroupExit while something in the group is still alive", async () => {
    const { leader } = writer("alive");
    const exits: number[] = [];
    // The group is reported alive past cleanup's deadline (a stand-in for an unkillable process).
    const realKill = process.kill.bind(process);
    let id = 0;
    const kill = (pid: number, sig?: NodeJS.Signals | number) => {
      if (pid === -id && sig === 0) return true;
      return realKill(pid, sig);
    };
    process.kill = kill as typeof process.kill;
    try {
      await runSession({ ...base, bin: leader, killGraceMs: 100, onSpawn: (g) => { id = g; return true; }, onGroupExit: (g) => exits.push(g) });
    } finally { process.kill = realKill; }
    expect(id).toBeGreaterThan(1);
    expect(exits).toEqual([]);
  }, 30_000);
});
