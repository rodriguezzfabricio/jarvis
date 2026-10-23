import { readFileSync, rmSync, writeFileSync, chmodSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { EvidenceCaptureError, runSession } from "../../packages/cli/src/harness/claude/session.ts";
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
