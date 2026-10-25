import { spawn } from "node:child_process";
import type { SessionSpec } from "../proc/session.ts";
export interface DesktopProcess {
  pid: number;
  alive(): boolean;
  waitForExit(timeoutMs: number): Promise<{ code: number | null; signal: string | null }>;
  stop(): Promise<void>;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export interface DesktopProcessDeps { kill?: (pid: number, signal: NodeJS.Signals | 0) => boolean }

/** Own a detached process group; the app cannot write observations through inherited pipes. */
export async function launchDesktop(spec: SessionSpec, deps: DesktopProcessDeps = {}): Promise<DesktopProcess> {
  const child = spawn(spec.bin, [...spec.args], { cwd: spec.cwd, env: spec.env, detached: true, stdio: "ignore" });
  let exit: { code: number | null; signal: string | null } | undefined;
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once("exit", (code, signal) => { exit = { code, signal }; resolve(exit); });
    child.once("error", () => { exit = { code: null, signal: "spawn-error" }; resolve(exit); });
  });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const groupAlive = () => {
    try { kill(-child.pid!, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  const signal = (sig: NodeJS.Signals) => {
    try { kill(-child.pid!, sig); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      if (!exit) throw new Error("desktop process group missing while its child is alive");
    }
  };
  return {
    pid: child.pid!, alive: () => exit === undefined,
    waitForExit: async timeoutMs => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([exited, new Promise<{ code: null; signal: string }>(resolve => { timer = setTimeout(() => resolve({ code: null, signal: "timeout" }), timeoutMs); })]); }
      finally { if (timer) clearTimeout(timer); }
    },
    stop: async () => {
      signal("SIGTERM");
      const deadline = Date.now() + (spec.killGraceMs ?? 1000);
      while (groupAlive() && Date.now() < deadline) await sleep(25);
      if (groupAlive()) signal("SIGKILL");
      const killedBy = Date.now() + 2000;
      while (groupAlive() && Date.now() < killedBy) await sleep(25);
      if (groupAlive()) throw new Error("desktop process group survived cleanup");
      await exited;
    },
  };
}
