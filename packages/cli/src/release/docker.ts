import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { runSession, type SessionOutcome, type SessionSpec } from "../proc/session.ts";
import type { CopyCommandSpec } from "./types.ts";

export interface DockerCopyOptions {
  bin: string;
  /** Preinstalled image containing the project's data tools, pinned by digest. Never pulled here. */
  image: string;
  home: string;
  workRoot: string;
  /** Non-root UID:GID supported by that image and able to write the runner-owned copy directory. */
  user: string;
  run?: (spec: SessionSpec) => Promise<SessionOutcome>;
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return isAbsolute(path) && rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** No host shell, production network, daemon socket or runner credentials reach project commands. */
export function dockerCopyExecutor(options: DockerCopyOptions): (spec: CopyCommandSpec) => Promise<SessionOutcome> {
  if (![options.bin, options.home, options.workRoot].every(isAbsolute) || !/@sha256:[a-f0-9]{64}$/.test(options.image)
    || !/^[1-9][0-9]*:[0-9]+$/.test(options.user)) throw new Error("absolute paths, pinned image and non-root user required");
  const run = options.run ?? runSession;
  return async spec => {
    if (!within(options.workRoot, spec.cwd) || spec.cwd !== spec.isolation.writableRoot || /[,\n\r\0]/.test(spec.cwd)) throw new Error("copy root refused");
    const map = (name: string): string => {
      const path = spec.env[name];
      if (!path || !within(spec.cwd, path)) throw new Error("copy path refused");
      return `/work/${relative(spec.cwd, path)}`;
    };
    const container = `jarvis-rehearsal-${randomUUID()}`;
    const env = { PATH: "/usr/bin:/bin", HOME: options.home };
    const restoring = spec.env.JARVIS_DATA_COPY === spec.env.JARVIS_RESTORE;
    const args = ["run", "--rm", "--name", container, "--pull", "never", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "512m", "--cpus", "1",
      "--user", options.user, "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--workdir", "/work",
      "--mount", `type=bind,source=${spec.cwd},target=/work`];
    for (const [key, value] of Object.entries({ HOME: "/work", TMPDIR: "/tmp", JARVIS_DATA_COPY: map("JARVIS_DATA_COPY"),
      JARVIS_BACKUP: map("JARVIS_BACKUP"), JARVIS_RESTORE: map("JARVIS_RESTORE"),
      JARVIS_LOCAL_DATA: restoring ? "/work/postgres-restored" : "/work/postgres",
      JARVIS_SOCKET: restoring ? "/work/socket-restored" : "/work/socket" })) args.push("--env", `${key}=${value}`);
    args.push(options.image, "/bin/sh", "-c", spec.command);
    try {
      return await run({ bin: options.bin, args, cwd: options.home, env, timeoutMs: spec.timeoutMs, killGraceMs: 1_000, maxOutputBytes: 1024 * 1024 });
    } finally {
      // Killing the docker CLI does not kill its container: remove that exact name even after timeout.
      await run({ bin: options.bin, args: ["rm", "--force", container], cwd: options.home, env, timeoutMs: 10_000, killGraceMs: 1_000, maxOutputBytes: 64 * 1024 });
    }
  };
}
