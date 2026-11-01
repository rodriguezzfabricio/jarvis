import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { runSession, type SessionSpec, type SessionOutcome } from "../proc/session.ts";

const command = z.string().trim().min(1).max(16_384);
export const ServedAppSchema = z.object({
  build: command, serve: command,
  readyPath: z.string().max(2048).refine(path => path.startsWith("/") && !path.startsWith("//") && !/[\\\x00-\x20]/.test(path)),
  timeoutMs: z.number().int().positive().max(1_800_000),
}).strict();
export type ServedAppPlan = z.infer<typeof ServedAppSchema>;
interface AppProcess { alive(): boolean; stop(): Promise<void> }
export interface ServedAppDeps {
  build?: (spec: SessionSpec) => Promise<SessionOutcome>;
  port?: () => Promise<number>;
  start?: (command: string, repo: string, env: Record<string,string>) => Promise<AppProcess>;
  ready?: (url: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

/** Called only inside the case sandbox. The runner supplies no address of a pre-existing service. */
export async function casePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(error => error ? reject(error) : typeof address === "object" && address ? resolve(address.port) : reject(new Error("no case port")));
    });
  });
}

async function startApp(command: string, repo: string, env: Record<string,string>): Promise<AppProcess> {
  // Inherit the gate's process group: its timeout kills descendants too. No app output enters the observation.
  const child = spawn("/bin/sh", ["-c", `exec ${command}`], {cwd:repo,env,stdio:"ignore"});
  let alive = true;
  const closed = new Promise<void>(resolve => { child.once("close", () => { alive = false; resolve(); }); });
  await new Promise<void>((resolve,reject) => {child.once("spawn",resolve);child.once("error",reject);});
  return {alive:()=>alive,stop:async()=>{child.kill("SIGKILL");await closed;}};
}
async function ready(url: string): Promise<boolean> {
  try { const response = await fetch(url, {redirect:"error",signal:AbortSignal.timeout(1000)}); await response.body?.cancel(); return response.ok; }
  catch { return false; }
}

/** Build, serve and capture in one protected case. Never call this from the unsandboxed runner. */
export async function withServedApp<T>(input: ServedAppPlan, repo: string, capture: (origin:string)=>Promise<T>, deps: ServedAppDeps = {}): Promise<T> {
  const plan = ServedAppSchema.parse(input);
  const env: Record<string,string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "JARVIS_FIXTURES"]) if(process.env[key]) env[key]=process.env[key]!;
  const built = await (deps.build ?? runSession)({bin:"/bin/sh",args:["-c",plan.build],cwd:repo,env,timeoutMs:plan.timeoutMs,maxOutputBytes:1024*1024});
  if (built.code !== 0 || built.timedOut || built.overflowed) throw new Error("design app build failed");
  const port = await (deps.port ?? casePort)(), origin = `http://127.0.0.1:${port}`;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid case port");
  const server = await (deps.start ?? startApp)(plan.serve,repo,{...env,HOST:"127.0.0.1",PORT:String(port),ORIGIN:origin,NODE_ENV:"production"});
  const now = deps.now ?? Date.now, deadline = now()+Math.min(plan.timeoutMs,30_000);
  try {
    while (server.alive()) {
      if (await (deps.ready ?? ready)(`${origin}${plan.readyPath}`)) {
        if (!server.alive()) throw new Error("design app exited during readiness");
        return await capture(origin);
      }
      if(now()>=deadline) throw new Error("design app readiness timed out");
      await (deps.sleep ?? setTimeout)(100);
    }
    throw new Error("design app exited before readiness");
  } finally { await server.stop(); }
}
