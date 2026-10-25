import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSession } from "../proc/session.ts";
import { launchDesktop, type DesktopProcess } from "./desktop-process.ts";
import { insideTree } from "./materialize.ts";

/** App metadata selects a contained executable, never a script or an argv list for the native probes. */
export async function launchDesktopBundle(bundlePath: string): Promise<DesktopProcess> {
  const home = mkdtempSync(join(tmpdir(), "jarvis-native-"));
  const env = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: "en_US.UTF-8" };
  try {
    const info = await runSession({ bin: "/usr/libexec/PlistBuddy", args: ["-c", "Print :CFBundleExecutable", join(bundlePath, "Contents/Info.plist")], cwd: home, env, timeoutMs: 10_000, maxOutputBytes: 4096 });
    const name = info.stdout.trim();
    if (info.code !== 0 || info.timedOut || info.overflowed || !name || name === "." || name === ".." || /[/\\\x00-\x1f]/.test(name)) throw new Error("invalid native bundle executable");
    const executable = realpathSync(join(bundlePath, "Contents/MacOS", name));
    if (!insideTree(realpathSync(bundlePath), executable)) throw new Error("native executable escapes bundle");
    const app = await launchDesktop({ bin: executable, args: [], cwd: home, env, timeoutMs: 3_600_000, killGraceMs: 1000 });
    return { ...app, stop: async () => { try { await app.stop(); } finally { rmSync(home, { recursive: true, force: true }); } } };
  } catch (error) { rmSync(home, { recursive: true, force: true }); throw error; }
}
