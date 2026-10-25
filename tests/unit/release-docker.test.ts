import { describe, expect, it } from "vitest";
import { dockerCopyExecutor } from "../../packages/cli/src/release/docker.ts";
import type { CopyCommandSpec } from "../../packages/cli/src/release/types.ts";
import type { SessionSpec } from "../../packages/cli/src/proc/session.ts";

const image = `jarvis-data@sha256:${"a".repeat(64)}`;
const spec = (): CopyCommandSpec => ({ command: 'migrate "$JARVIS_DATA_COPY"', cwd: "/trusted/rehearsal/one", timeoutMs: 500,
  env: { JARVIS_DATA_COPY: "/trusted/rehearsal/one/data-copy", JARVIS_BACKUP: "/trusted/rehearsal/one/backup", JARVIS_RESTORE: "/trusted/rehearsal/one/restored-copy", DATABASE_URL: "must-not-be-forwarded" },
  isolation: { readOnlySource: "/trusted/rehearsal/one/data-copy", writableRoot: "/trusted/rehearsal/one", network: "none", credentials: "none", database: "postgres" } });
const outcome = { code: 0, timedOut: false, overflowed: false, durationMs: 1, stdout: "ok", stderr: "" };
describe("isolated data command executor", () => {
  it("runs declared commands in a pinned offline container, maps copies, and removes the container", async () => {
    const calls: SessionSpec[] = [];
    const execute = dockerCopyExecutor({ bin: "/trusted/bin/docker", image, home: "/trusted/control", workRoot: "/trusted/rehearsal", user: "501:20",
      run: async s => { calls.push(s); return outcome; } });
    expect(await execute(spec())).toEqual(outcome);
    expect(calls).toHaveLength(2);
    const args = calls[0]!.args;
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--pull", "never", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", image]));
    expect(args).toContain("JARVIS_DATA_COPY=/work/data-copy");
    expect(args).toContain("JARVIS_LOCAL_DATA=/work/postgres");
    expect(args).toContain("JARVIS_SOCKET=/work/socket");
    expect(args).toContain("type=bind,source=/trusted/rehearsal/one,target=/work");
    expect(args.join(" ")).not.toContain("DATABASE_URL");
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", spec().command]);
    expect(calls[0]!.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/trusted/control" });
    expect(calls[1]!.args.slice(0, 2)).toEqual(["rm", "--force"]);
    expect(calls[1]!.args[2]).toBe(args[args.indexOf("--name") + 1]);
  });
  it("removes a container even when the command process throws", async () => {
    const calls: SessionSpec[] = [];
    const execute = dockerCopyExecutor({ bin: "/trusted/bin/docker", image, home: "/trusted/control", workRoot: "/trusted/rehearsal", user: "501:20",
      run: async s => { calls.push(s); if (calls.length === 1) throw new Error("killed"); return outcome; } });
    await expect(execute(spec())).rejects.toThrow("killed");
    expect(calls).toHaveLength(2);
  });
  it("rejects an unpinned image or relative binary", () => {
    const config = { bin: "/trusted/bin/docker", image, home: "/trusted/control", workRoot: "/trusted/rehearsal", user: "501:20" };
    expect(() => dockerCopyExecutor({ ...config, image: "postgres:latest" })).toThrow();
    expect(() => dockerCopyExecutor({ ...config, bin: "docker" })).toThrow();
  });
  it("refuses mounts and copy paths outside its runner-assigned root", async () => {
    const execute = dockerCopyExecutor({ bin: "/trusted/bin/docker", image, home: "/trusted/control", workRoot: "/trusted/rehearsal", user: "501:20",
      run: async () => { throw new Error("must not spawn"); } });
    await expect(execute({ ...spec(), cwd: "/secrets", isolation: { ...spec().isolation, writableRoot: "/secrets" } })).rejects.toThrow(/root/);
    await expect(execute({ ...spec(), env: { ...spec().env, JARVIS_DATA_COPY: "/secrets/token" } })).rejects.toThrow(/copy/);
  });
  it("uses a fresh local Postgres cluster and socket for restore verification", async () => {
    const calls: SessionSpec[] = [];
    const execute = dockerCopyExecutor({ bin: "/trusted/bin/docker", image, home: "/trusted/control", workRoot: "/trusted/rehearsal", user: "501:20",
      run: async s => { calls.push(s); return outcome; } });
    await execute({ ...spec(), env: { ...spec().env, JARVIS_DATA_COPY: spec().env.JARVIS_RESTORE! } });
    expect(calls[0]!.args).toContain("JARVIS_LOCAL_DATA=/work/postgres-restored");
    expect(calls[0]!.args).toContain("JARVIS_SOCKET=/work/socket-restored");
  });
});
