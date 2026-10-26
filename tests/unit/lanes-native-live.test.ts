import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { launchSandboxedDesktop } from "../../packages/cli/src/lanes/desktop-sandbox.ts";
import type { DesktopProcess } from "../../packages/cli/src/lanes/desktop-process.ts";

// Integrator only, from an unsandboxed macOS terminal: Seatbelt profiles cannot nest (decision 110).
it.skipIf(process.env.JARVIS_NATIVE_LIVE !== "1" || process.platform !== "darwin")("real Seatbelt denies a fake app's home/temp reads and network, preserving its PID", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-live-")));
  const home = join(root, "runner"), workRoot = join(home, "work"), bundle = join(workRoot, "Canary.app");
  const server = createServer((_req, res) => { hits++; res.end("local control"); }); let hits = 0, app: DesktopProcess | undefined;
  try {
    mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true }); mkdirSync(join(home, ".jarvis"));
    for (const path of [join(home, "canary"), join(home, ".jarvis/canary"), join(root, "temp-canary")]) writeFileSync(path, "planted fake canary", { mode: 0o600 });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    expect(await (await fetch(url)).text()).toBe("local control"); hits = 0;
    writeFileSync(join(bundle, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Canary</string></dict></plist>');
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const script = `#!/bin/sh
[ "$(/bin/cat "${bundle}/Contents/Info.plist")" ] || exit 10
for path in ${[join(home, "canary"), join(home, ".jarvis/canary"), join(root, "temp-canary")].map(quote).join(" ")}; do
  /bin/cat "$path" >/dev/null 2>&1 && exit 11
done
/usr/bin/curl --version >/dev/null 2>&1 || exit 13
/usr/bin/curl --noproxy '*' --connect-timeout 1 --max-time 2 ${quote(url)} >/dev/null 2>&1 && exit 12
printf '%s' "$$" > "$HOME/pid"
exit 0
`;
    writeFileSync(join(bundle, "Contents/MacOS/Canary"), script, { mode: 0o700 });
    // Capture only the runner-owned private HOME; use the real process launcher and sandbox.
    let privateHome = "";
    const { launchDesktop } = await import("../../packages/cli/src/lanes/desktop-process.ts");
    app = await launchSandboxedDesktop(bundle, { home, workRoot }, { launch: async spec => { privateHome = spec.env.HOME!; return launchDesktop(spec); } });
    expect(await app.waitForExit(10_000)).toEqual({ code: 0, signal: null });
    expect(Number(readFileSync(join(privateHome, "pid"), "utf8"))).toBe(app.pid); expect(hits).toBe(0);
  } finally {
    try { await app?.stop(); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
  }
}, 30_000);
