import { execFileSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EvidenceCaptureError, SessionStartError, runSession } from "../../packages/cli/src/harness/claude/session.ts";
import { shortTmp } from "../helpers.ts";

const dir = shortTmp("jtss-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// A child that prints 2,000 numbered lines and exits at once.
const bin = join(dir, "emit");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" -e 'for (let i = 1; i <= 2000; i++) console.log("line " + i)'\n`);
chmodSync(bin, 0o755);
const base = { bin, args: [], cwd: dir, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 20_000 };

describe("session output capture (Codex review 2, medium)", () => {
  it("returns only after a slow output file has every byte", async () => {
    const out = join(dir, "slow.txt");
    // A sink that takes a while per chunk: without the flush wait, the file is incomplete on return.
    const openSink = (p: string) => {
      const file = createWriteStream(p);
      return new Writable({
        write(chunk, _enc, cb) {
          setTimeout(() => file.write(chunk, cb), 15);
        },
        final(cb) {
          file.end(cb);
        },
      });
    };
    await runSession({ ...base, stdoutPath: out, openSink });
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines.at(-1)).toBe("line 2000");
  });

  it("fails explicitly, without crashing, when the output file can't be opened", async () => {
    await expect(runSession({ ...base, stdoutPath: join(dir, "no-such-dir", "out.txt") })).rejects.toBeInstanceOf(EvidenceCaptureError);
  });

  // Codex review 3, medium: a child that ignores SIGTERM is still stopped, within the grace period.
  it("stops a SIGTERM-resistant child promptly after a capture failure", async () => {
    const stubborn = join(dir, "stubborn");
    writeFileSync(stubborn, `#!/bin/sh\ntrap '' TERM\necho started\nsleep 60\n`);
    chmodSync(stubborn, 0o755);
    const t0 = Date.now();
    await expect(runSession({ ...base, bin: stubborn, timeoutMs: 120_000, killGraceMs: 300, stdoutPath: join(dir, "nope", "out.txt") })).rejects.toBeInstanceOf(EvidenceCaptureError);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("cleans up background processes the session left running (its whole process group)", async () => {
    const marker = join(dir, "grandchild-survived");
    const leaver = join(dir, "leaver");
    writeFileSync(leaver, `#!/bin/sh\n(sleep 2; touch ${marker}) > /dev/null 2>&1 &\necho done\n`);
    chmodSync(leaver, 0o755);
    await runSession({ ...base, bin: leaver });
    await new Promise((res) => setTimeout(res, 3000));
    expect(existsSync(marker)).toBe(false);
  });

  // Codex review 4, medium: a cooperative leader that leaves a SIGTERM-resistant descendant behind.
  for (const capture of ["normal completion", "capture failure"] as const) {
    it(`kills a SIGTERM-resistant descendant after the leader exits (${capture})`, async () => {
      const pidFile = join(dir, `desc-${capture.replace(" ", "-")}.pid`);
      const leader = join(dir, `leader-${capture.replace(" ", "-")}`);
      writeFileSync(leader, `#!/bin/sh\nsh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' > /dev/null 2>&1 &\nsleep 0.3\necho leader-done\n`);
      chmodSync(leader, 0o755);
      // The capture fails on the leader's first output, which comes after the descendant is running.
      const failingSink = () =>
        new Writable({
          write(_c, _e, cb) {
            cb(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
          },
        });
      const spec = { ...base, bin: leader, killGraceMs: 300, ...(capture === "capture failure" ? { stdoutPath: join(dir, "x.txt"), openSink: failingSink } : {}) };
      const t0 = Date.now();
      const run = runSession(spec);
      if (capture === "capture failure") await expect(run).rejects.toBeInstanceOf(EvidenceCaptureError);
      else await run;
      expect(Date.now() - t0).toBeLessThan(8_000);
      const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      expect(() => process.kill(pid, 0)).toThrow(); // gone
    });
  }

  // Backlog #10 (Codex review 5, medium): a descendant that keeps the inherited output pipes open.
  for (const resistant of [false, true]) {
    it(`returns promptly when a ${resistant ? "SIGTERM-resistant " : ""}descendant holds the output pipes`, async () => {
      const pidFile = join(dir, `pipe-holder-${resistant}.pid`);
      const leader = join(dir, `pipe-leader-${resistant}`);
      const trap = resistant ? `trap "" TERM; ` : "";
      writeFileSync(leader, `#!/bin/sh\nsh -c '${trap}echo $$ > ${pidFile}; while :; do sleep 1; done' &\nsleep 0.3\necho leader-done\nexit 0\n`);
      chmodSync(leader, 0o755);
      const t0 = Date.now();
      // The session timeout is well inside the test's own, so a regression fails an assertion, not the test runner.
      const out = await runSession({ ...base, bin: leader, timeoutMs: 8_000, killGraceMs: 300 });
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(out.timedOut).toBe(false);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("leader-done");
      const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      expect(() => process.kill(pid, 0)).toThrow();
    }, 20_000);
  }

  // A process that leaves the session's group (setsid) can't be cleaned up by group, and may hold the
  // output files' pipes forever: the session must still return, with what was written.
  it("returns when a process outside its group holds the output pipes, with the output on disk", async () => {
    const pidFile = join(dir, "setsid.pid");
    const leader = join(dir, "setsid-leader");
    const daemon = `import os,time\nos.setsid()\nopen(${JSON.stringify(pidFile)},"w").write(str(os.getpid()))\ntime.sleep(60)\n`;
    writeFileSync(join(dir, "daemon.py"), daemon);
    writeFileSync(leader, `#!/bin/sh\n/usr/bin/python3 ${join(dir, "daemon.py")} &\nsleep 0.5\necho leader-done\nexit 0\n`);
    chmodSync(leader, 0o755);
    const out = join(dir, "setsid-out.txt");
    const t0 = Date.now();
    try {
      // Raced against a deadline, so a hang fails an assertion rather than the test runner's timeout.
      const r = await Promise.race([
        runSession({ ...base, bin: leader, timeoutMs: 8_000, killGraceMs: 300, stdoutPath: out, stderrPath: join(dir, "setsid-err.txt") }),
        new Promise<"hung">((res) => setTimeout(() => res("hung"), 12_000)),
      ]);
      expect(r).not.toBe("hung");
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(r !== "hung" && r.timedOut).toBe(false);
      expect(readFileSync(out, "utf8")).toContain("leader-done");
    } finally {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number.parseInt(readFileSync(pidFile, "utf8"), 10), "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);

  // Codex review 3, medium: a session that never started is an error, not an empty run.
  it("rejects when the binary can't be started, and keeps the diagnostic", async () => {
    const errPath = join(dir, "spawn-err.txt");
    await expect(runSession({ ...base, bin: join(dir, "no-such-claude"), stdoutPath: join(dir, "so.txt"), stderrPath: errPath })).rejects.toBeInstanceOf(SessionStartError);
    expect(readFileSync(errPath, "utf8")).toMatch(/could not start .*no-such-claude/);
  });

  it("fails explicitly when writing fails mid-session (e.g. a full disk)", async () => {
    const openSink = () =>
      new Writable({
        write(_c, _e, cb) {
          cb(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
        },
      });
    await expect(runSession({ ...base, stdoutPath: join(dir, "x.txt"), openSink })).rejects.toThrow(/ENOSPC/);
  });
});

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
