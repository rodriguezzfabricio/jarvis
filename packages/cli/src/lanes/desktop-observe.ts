import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runSession, type SessionOutcome, type SessionSpec } from "../proc/session.ts";
import { launchDesktopBundle } from "./desktop-launch.ts";
import type { DesktopProcess } from "./desktop-process.ts";
import { validDuration, type DesktopNativeObservation, type NativeProbePolicy } from "./desktop-types.ts";
import { assertNoBundleLinks, insideTree } from "./materialize.ts";
export { observeDesktopBuild, type DesktopBuildDeps } from "./desktop-build.ts";
export interface NativeProbeDeps {
  launch?: (bundlePath: string) => Promise<DesktopProcess>;
  spawn?: (spec: SessionSpec) => Promise<SessionOutcome>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export const MENU_SCRIPT = `on run argv
set taskPid to item 1 of argv as integer
tell application "System Events" to tell (first application process whose unix id is taskPid) to return (exists menu bar 2) and (count of menu bar items of menu bar 2 > 0)
end run`;
export const QUIT_SCRIPT = `function run(argv) { ObjC.import("AppKit"); if (!$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0])).terminate) throw new Error("native quit rejected"); }`;
const good = (r: SessionOutcome) => r.code === 0 && !r.timedOut && !r.overflowed;

/** Runner only. Candidate input is solely a bundle path contained in runner-owned build output. */
export async function probeDesktop(bundlePath: string, policy: NativeProbePolicy, deps: NativeProbeDeps = {}): Promise<DesktopNativeObservation> {
  if (typeof bundlePath !== "string" || !isAbsolute(bundlePath) || !bundlePath.endsWith(".app") || !isAbsolute(policy.outputRoot) || !validDuration(policy.stayUpMs) || !validDuration(policy.shutdownMs)) throw new Error("invalid native bundle or probe policy");
  const root = realpathSync(policy.outputRoot);
  if (lstatSync(bundlePath).isSymbolicLink() || !lstatSync(bundlePath).isDirectory() || !insideTree(root, realpathSync(bundlePath)) || root === realpathSync(bundlePath)) throw new Error("native bundle must be inside runner build output");
  assertNoBundleLinks(bundlePath);
  const raw: DesktopNativeObservation = { kind: "qa-desktop-native", status: "fail" };
  let app: DesktopProcess | undefined;
  try {
    app = await (deps.launch ?? launchDesktopBundle)(bundlePath);
    if (!Number.isSafeInteger(app.pid) || app.pid <= 0) throw new Error("invalid native process id");
    raw.pid = app.pid;
    const now = deps.now ?? Date.now; const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))); const started = now();
    while (now() - started < policy.stayUpMs) { if (!app.alive()) throw new Error("desktop exited during smoke window"); await sleep(Math.min(100, policy.stayUpMs - (now() - started))); }
    if (!app.alive()) throw new Error("desktop exited before native menu check");
    raw.stayedUpMs = now() - started;
    const spec = (args: string[]): SessionSpec => ({ bin: "/usr/bin/osascript", args, cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root }, timeoutMs: policy.shutdownMs, maxOutputBytes: 4096 });
    const menu = await (deps.spawn ?? runSession)(spec(["-e", MENU_SCRIPT, String(app.pid)]));
    raw.menuBar = good(menu) && menu.stdout.trim() === "true";
    if (!raw.menuBar || !app.alive()) throw new Error("native menu-bar item unavailable");
    const quit = await (deps.spawn ?? runSession)(spec(["-l", "JavaScript", "-e", QUIT_SCRIPT, String(app.pid)]));
    if (!good(quit)) throw new Error("native quit request failed");
    raw.shutdown = await app.waitForExit(policy.shutdownMs);
    if (raw.shutdown.code !== 0 || raw.shutdown.signal !== null) throw new Error("desktop did not shut down cleanly");
    raw.status = "observed";
  } catch (error) { raw.reason = String(error instanceof Error ? error.message : error); }
  finally { if (app) await app.stop(); }
  return raw;
}
