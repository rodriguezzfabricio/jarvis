import { chmodSync, createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
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
