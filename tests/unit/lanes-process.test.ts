import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchDesktop } from "../../packages/cli/src/lanes/desktop-process.ts";
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "qa-process-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check() && Date.now() < end) await sleep(20); expect(check()).toBe(true); }
describe("real desktop process groups with synthetic Node children", () => {
  it("stops and reaps a child plus its grandchild", async () => {
    const root = temp(); const file = join(root, "grandchild");
    const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(file)},String(child.pid)); process.on('SIGTERM',()=>child.kill('SIGTERM')); child.on('exit',()=>process.exit(0)); setInterval(()=>{},1000);`;
    const app = await launchDesktop({ bin: process.execPath, args: ["-e", code], cwd: root, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 3000, killGraceMs: 500 });
    let grandchild = 0;
    try { await until(() => existsSync(file)); grandchild = Number(readFileSync(file, "utf8")); await expect(app.stop()).resolves.toBeUndefined(); await until(() => !alive(app.pid) && !alive(grandchild)); }
    finally { for (const pid of [grandchild, app.pid]) if (pid > 0 && alive(pid)) process.kill(pid, "SIGTERM"); await app.waitForExit(1000); }
  });
  it("surfaces failed group termination instead of swallowing EPERM", async () => {
    const root = temp(); const error = Object.assign(new Error("denied group kill"), { code: "EPERM" });
    const app = await launchDesktop({ bin: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: root, env: {}, timeoutMs: 3000, killGraceMs: 50 }, { kill: (pid, signal) => { if (signal !== 0) throw error; return process.kill(pid, 0); } });
    try { const failure = await app.stop().then(() => undefined, (error: unknown) => error); expect(failure).toBe(error); }
    finally {
      for (const pid of [-app.pid, app.pid]) {
        try { process.kill(pid, "SIGKILL"); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await app.waitForExit(1000);
    }
  });
});
