// Session tests, part 1 of 2 (output capture). The tests are split over two files so they run in parallel;
// the shared fixture is tests/unit/helpers/session-fixture.ts.

import { chmodSync, createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { EvidenceCaptureError, SessionStartError, runSession } from "../../packages/cli/src/harness/claude/session.ts";
import { base, dir } from "./helpers/session-fixture.ts";

afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
