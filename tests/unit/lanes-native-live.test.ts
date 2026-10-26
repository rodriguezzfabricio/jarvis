import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createSocketServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchSandboxedDesktop } from "../../packages/cli/src/lanes/desktop-sandbox.ts";
import { launchDesktop, type DesktopProcess } from "../../packages/cli/src/lanes/desktop-process.ts";

const DENIED = "Operation not permitted";
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
/** Every line the app logged for one kind of attempt: each must be a sandbox refusal, and all must be there. */
const refusals = (path: string) => readFileSync(path, "utf8").trim().split("\n");

// Integrator only, from an unsandboxed macOS terminal: Seatbelt profiles cannot nest (decision 110).
it.skipIf(process.env.JARVIS_NATIVE_LIVE !== "1" || process.platform !== "darwin")("real Seatbelt denies a fake app's home, runner-home and temp reads, writes outside its private folders, links to a denied file and all network (TCP and a Unix socket), preserving its PID", async () => {
  // A short root: the Unix socket sits in the app's private temp folder (an allowed file area, so only
  // the network rule can refuse it), and macOS socket paths stop at 104 bytes. Both system temp
  // spellings get a canary: /private/tmp here, the per-user /private/var/folders through tmpdir().
  const root = realpathSync(mkdtempSync("/private/tmp/nl-")), hostTmp = realpathSync(mkdtempSync(join(tmpdir(), "native-live-")));
  const home = join(root, "runner"), workRoot = join(home, "work"), bundle = join(workRoot, "Canary.app");
  const jarvisCanary = join(home, ".jarvis/canary");
  const canaries = [join(home, "canary"), jarvisCanary, join(root, "temp-canary"), join(hostTmp, "temp-canary")];
  let httpHits = 0, socketHits = 0, app: DesktopProcess | undefined, privateHome = "";
  const http = createHttpServer((_req, res) => { httpHits++; res.end("local control"); });
  const broker = createSocketServer(socket => { socketHits++; socket.end(); });
  try {
    mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true }); mkdirSync(join(home, ".jarvis"));
    for (const path of canaries) writeFileSync(path, "planted fake canary", { mode: 0o600 });
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
    const port = (http.address() as AddressInfo).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("local control"); httpHits = 0;
    writeFileSync(join(bundle, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Canary</string></dict></plist>');
    // Each attempt must fail, and its stderr goes to a log the test reads: a refusal must say EPERM,
    // so a tool that merely failed to start can't pass for a denial.
    const script = `#!/bin/sh
/bin/cat ${q(join(bundle, "Contents/Info.plist"))} >/dev/null || exit 10
for path in ${canaries.map(q).join(" ")}; do
  /bin/cat "$path" >/dev/null 2>>"$HOME/read.err" && exit 11
done
/bin/ls ${q(homedir())} >/dev/null 2>>"$HOME/read.err" && exit 11
/usr/bin/touch ${q(join(workRoot, "escaped"))} 2>>"$HOME/write.err" && exit 12
/usr/bin/touch ${q(join(bundle, "escaped"))} 2>>"$HOME/write.err" && exit 12
/bin/ln ${q(jarvisCanary)} "$HOME/hard" 2>>"$HOME/link.err" && exit 13
/bin/ln -s ${q(jarvisCanary)} "$HOME/soft" || exit 15
/bin/cat "$HOME/soft" >/dev/null 2>>"$HOME/link.err" && exit 13
/usr/bin/nc -v -z -G 1 127.0.0.1 ${port} 2>>"$HOME/net.err" && exit 14
/usr/bin/nc -U "$TMPDIR/broker.sock" </dev/null 2>/dev/null && exit 14
printf '%s' "$$" > "$HOME/pid"
exit 0
`;
    writeFileSync(join(bundle, "Contents/MacOS/Canary"), script, { mode: 0o700 });
    // The real process launcher and sandbox. The hook only records the private HOME and opens a
    // broker-style socket in the private temp folder, with one runner-side control connection.
    app = await launchSandboxedDesktop(bundle, { home, workRoot }, { launch: async spec => {
      privateHome = spec.env.HOME!;
      const socket = join(spec.env.TMPDIR!, "broker.sock");
      await new Promise<void>((resolve, reject) => { broker.once("error", reject); broker.listen(socket, resolve); });
      await new Promise<void>((resolve, reject) => { const c = connect(socket, () => { c.end(); resolve(); }); c.once("error", reject); });
      return launchDesktop(spec);
    } });
    expect(await app.waitForExit(20_000)).toEqual({ code: 0, signal: null });
    expect(Number(readFileSync(join(privateHome, "pid"), "utf8"))).toBe(app.pid);
    expect(refusals(join(privateHome, "read.err"))).toEqual(Array(canaries.length + 1).fill(expect.stringContaining(DENIED)));
    expect(refusals(join(privateHome, "write.err"))).toEqual(Array(2).fill(expect.stringContaining(DENIED)));
    expect(refusals(join(privateHome, "link.err"))).toEqual(Array(2).fill(expect.stringContaining(DENIED)));
    expect(refusals(join(privateHome, "net.err"))).toEqual([expect.stringContaining(DENIED)]);
    expect(httpHits).toBe(0); expect(socketHits).toBe(1);
    for (const path of [join(workRoot, "escaped"), join(bundle, "escaped"), join(privateHome, "hard")]) expect(existsSync(path)).toBe(false);
  } finally {
    try { await app?.stop(); }
    finally {
      await new Promise<void>(resolve => http.close(() => resolve()));
      await new Promise<void>(resolve => broker.listening ? broker.close(() => resolve()) : resolve());
      for (const dir of [root, hostTmp]) rmSync(dir, { recursive: true, force: true });
    }
  }
}, 40_000);
