import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { runSandboxed } from "../../packages/cli/src/sandbox/srt.ts";
import { tempRoots } from "../../packages/cli/src/sandbox/temp.ts";
import { verifyQaToolchain } from "../../packages/cli/src/lanes/toolchain.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Integrator only, from outside a sandbox. Supply the pinned, approved materialized toolchain's
// JARVIS_BROWSER_MANIFEST and JARVIS_BROWSER_MANIFEST_SHA256; never resolve a candidate's packages.
it.skipIf(process.env.JARVIS_BROWSER_LIVE !== "1")("pinned Chromium loads a page and runs isolated axe inside the gate's srt policy", async () => {
  const manifest = process.env.JARVIS_BROWSER_MANIFEST, hash = process.env.JARVIS_BROWSER_MANIFEST_SHA256;
  if (!manifest || !hash) throw new Error("set JARVIS_BROWSER_MANIFEST and JARVIS_BROWSER_MANIFEST_SHA256 to the approved toolchain");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-gate-live-")));
  try {
    const checkout = join(root, "checkout"), home = join(root, "home");
    mkdirSync(checkout); mkdirSync(home);
    const tools = verifyQaToolchain(manifest, hash, checkout);
    const sourceRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
    const toolchainModule = pathToFileURL(join(sourceRoot, "packages/cli/src/lanes/toolchain.ts")).href;
    const framesModule = pathToFileURL(join(sourceRoot, "packages/cli/src/lanes/browser-frames.ts")).href;
    const driver = join(root, "smoke.mjs");
    writeFileSync(driver, `import { loadBrowserRuntime } from ${JSON.stringify(toolchainModule)};
import { isolatedFrames } from ${JSON.stringify(framesModule)};
const runtime = loadBrowserRuntime(...process.argv.slice(2));
const browser = await runtime.launch();
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.goto('data:text/html,<html lang="en"><title>Smoke</title><main><h1>Browser smoke</h1><button>Save</button></main></html>', { waitUntil: "networkidle", timeout: 30000 });
    const tree = await page.locator("body").ariaSnapshot();
    const coverage = await isolatedFrames(page, runtime.axeSource);
    const screenshot = await page.screenshot({ fullPage: true });
    if (!tree.includes("Browser smoke") || coverage.frameCount !== 1 || !screenshot.length) throw Error("incomplete browser smoke");
    const axe = coverage.frames[0].axe;
    if (axe.version !== ${JSON.stringify(tools.axeVersion)} || !Array.isArray(axe.violations)) throw Error("axe did not run");
    console.log("JARVIS-BROWSER-SMOKE-COMPLETE");
  } finally { await page.close(); }
} finally { await browser.close(); }
`);
    const result = await runSandboxed({
      policy: {
        denyRead: [realpathSync(homedir()), ...tempRoots()],
        // The trusted source tree stands in for the installed driver in checks/fixtures.
        allowRead: [root, tools.root, sourceRoot, dirname(realpathSync(process.execPath))],
        allowWrite: [checkout, home],
      },
      command: [process.execPath, driver, tools.manifestPath, tools.manifestHash, checkout].map(quote).join(" "),
      cwd: checkout, env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: "en_US.UTF-8" },
      timeoutMs: 60_000, killGraceMs: 5000, maxOutputBytes: 1024 * 1024,
    });
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false, overflowed: false });
    expect(result.stdout).toContain("JARVIS-BROWSER-SMOKE-COMPLETE");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 90_000);
