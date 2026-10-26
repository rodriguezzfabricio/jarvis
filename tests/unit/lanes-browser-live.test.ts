import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { runSandboxed } from "../../packages/cli/src/sandbox/srt.ts";
import { tempRoots } from "../../packages/cli/src/sandbox/temp.ts";
import { recordWebBaseline, verifyWebObservation } from "../../packages/cli/src/lanes/verify.ts";
import { verifyQaToolchain } from "../../packages/cli/src/lanes/toolchain.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.on("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

// Integrator only, from outside a sandbox. Supply the pinned, approved materialized toolchain's
// JARVIS_BROWSER_MANIFEST and JARVIS_BROWSER_MANIFEST_SHA256; never resolve a candidate's packages.
// Runs the real observeWeb (three viewports, an iframe, isolated axe) inside the gate's srt policy, then the
// axe baseline on its real output: the unit tests only ever see fakes. Without --single-process this fails with
// "bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer: Permission denied (1100)"; with the flag
// but one browser reused across viewports, the second viewport's newPage dies (SIGTRAP).
it.skipIf(process.env.JARVIS_BROWSER_LIVE !== "1")("pinned Chromium runs the full web observation inside the gate's srt policy, and the axe baseline holds on its real output", async () => {
  const manifest = process.env.JARVIS_BROWSER_MANIFEST, hash = process.env.JARVIS_BROWSER_MANIFEST_SHA256;
  if (!manifest || !hash) throw new Error("set JARVIS_BROWSER_MANIFEST and JARVIS_BROWSER_MANIFEST_SHA256 to the approved toolchain");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-gate-live-")));
  try {
    const checkout = join(root, "checkout"), home = join(root, "home");
    mkdirSync(checkout); mkdirSync(home);
    const tools = verifyQaToolchain(manifest, hash, checkout);
    const sourceRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
    const lanes = (file: string) => JSON.stringify(pathToFileURL(join(sourceRoot, "packages/cli/src/lanes", file)).href);
    const driver = join(root, "observe.mjs");
    // The page serves itself from inside the sandbox (allowLocalBinding), with pre-existing contrast failures
    // and an iframe; the "grown" variant adds one more failing node.
    writeFileSync(driver, `import { createServer } from "node:http";
import { observeWeb } from ${lanes("browser.ts")};
import { loadBrowserRuntime } from ${lanes("toolchain.ts")};
const [manifest, hash, checkout, port, variant] = process.argv.slice(2);
const bad = (id, text) => '<button id="' + id + '" style="color:#999;background:#fff">' + text + '</button>';
const html = '<!doctype html><html lang="en"><head><title>Jobs</title></head><body><main><h1>Jobs</h1>' + bad("a", "one") + bad("b", "two") + (variant === "grown" ? bad("c", "three") : "") +
  '<iframe title="embed" srcdoc="<!doctype html><html lang=en><title>f</title><body><p style=&quot;color:#bbb;background:#fff&quot;>frame text</p></body></html>"></iframe></main></body></html>';
const server = createServer((_, res) => { res.setHeader("content-type", "text/html"); res.end(html); });
await new Promise(resolve => server.listen(Number(port), "127.0.0.1", resolve));
try {
  const observation = await observeWeb("http://127.0.0.1:" + port + "/jobs", loadBrowserRuntime(manifest, hash, checkout));
  console.log("JARVIS-OBSERVATION " + JSON.stringify(observation));
} finally { server.close(); }
`);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/jobs`;
    const observe = async (variant: string) => {
      const result = await runSandboxed({
        policy: {
          denyRead: [realpathSync(homedir()), ...tempRoots()],
          // The trusted source tree stands in for the installed driver in checks/fixtures.
          allowRead: [root, tools.root, sourceRoot, dirname(realpathSync(process.execPath))],
          allowWrite: [checkout, home],
          allowLocalBinding: true,
        },
        command: [process.execPath, driver, tools.manifestPath, tools.manifestHash, checkout, String(port), variant].map(quote).join(" "),
        cwd: checkout, env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: "en_US.UTF-8" },
        timeoutMs: 90_000, killGraceMs: 5000, maxOutputBytes: 16 * 1024 * 1024,
      });
      expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false, overflowed: false });
      const line = result.stdout.split("\n").find(l => l.startsWith("JARVIS-OBSERVATION "));
      if (!line) throw new Error(`no observation in stdout: ${result.stdout.slice(0, 500)}`);
      return JSON.parse(line.slice("JARVIS-OBSERVATION ".length)) as { pages: { width: number; frameCount: number }[] };
    };

    const expected = { url, axeVersion: tools.axeVersion };
    const base = await observe("base");
    expect(base.pages.map(p => p.width)).toEqual([375, 768, 1440]);
    expect(base.pages.map(p => p.frameCount)).toEqual([2, 2, 2]);
    // Today's strict behaviour fails the pre-existing contrast and frame-title problems; the baseline allows exactly those.
    expect(verifyWebObservation(base, expected).ok).toBe(false);
    const baseline = recordWebBaseline(base, expected, "a".repeat(40));
    expect(verifyWebObservation(await observe("base"), { ...expected, baseline })).toEqual({ ok: true, problems: [] });
    expect(verifyWebObservation(await observe("grown"), { ...expected, baseline }).ok).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 240_000);
