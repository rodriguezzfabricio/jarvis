import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { pinnedProviderNode } from "../../packages/cli/src/config/pins.ts";
import { verifyProviderCli } from "../../packages/cli/src/release/provider-cli.ts";
import { shortTmp } from "../helpers.ts";

// Decision 157: the provider CLI runs outside the sandbox with a deploy token, so it is verified before use:
// pinned version, pinned path, trusted file and folder, outside anything a session or build can write.
const root = shortTmp("jpc-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function fake(version = "41.2.0", mode = 0o755) {
  const dir = join(root, `c${++n}`);
  for (const d of ["bin", "home", "cwd", "repo"]) mkdirSync(join(dir, d), { recursive: true, mode: 0o755 });
  const bin = join(dir, "bin", "vercel");
  // An npm-style launcher: under the adapters' PATH=/usr/bin:/bin its `env node` finds no node, so it runs only as
  // `<pinned Node> <bin>`, the way the adapters start it (decision 161).
  writeFileSync(bin, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(`Vercel CLI ${version}`)});\n`, { mode });
  chmodSync(bin, mode);
  const input = { provider: "vercel" as const, home: dir, providerHome: join(dir, "home"), providerCwd: join(dir, "cwd"), untrusted: [join(dir, "repo")] };
  return { dir, bin, input };
}
const pins = { vercel: { version: "41.2.0" } };

describe("provider CLI verification", () => {
  it("passes the pinned version at the pinned path, read with the adapters' environment, and returns its real path", async () => {
    const f = fake();
    const link = join(f.dir, "bin", "vercel-link");
    symlinkSync(f.bin, link);
    const calls: SessionSpec[] = [];
    const { runSession } = await import("../../packages/cli/src/proc/session.ts");
    const result = await verifyProviderCli(f.input, { pins, bin: () => link, run: async (spec) => { calls.push(spec); return runSession(spec); } });
    expect(result).toEqual({ ok: true, bin: realpathSync(f.bin), version: "41.2.0", interpreter: pinnedProviderNode() });
    expect(pinnedProviderNode()).toBe(process.execPath);
    expect(calls[0]).toMatchObject({ bin: pinnedProviderNode(), args: [realpathSync(f.bin), "--version"], cwd: f.input.providerCwd, env: { PATH: "/usr/bin:/bin", HOME: f.input.providerHome, CI: "1" } });
    expect(Object.keys(calls[0]!.env).sort()).toEqual(["CI", "HOME", "PATH"]);
  });

  it("refuses a provider with no pin", async () => {
    const f = fake();
    expect(await verifyProviderCli(f.input, { pins: {}, bin: () => f.bin })).toEqual({ ok: false, reason: expect.stringMatching(/no pinned vercel CLI version/) });
  });

  it("refuses a missing CLI", async () => {
    const f = fake();
    expect(await verifyProviderCli(f.input, { pins, bin: () => join(f.dir, "bin", "missing") })).toMatchObject({ ok: false, reason: expect.stringMatching(/not installed/) });
  });

  it.each(["41.2.1", "141.2.0", "41.2.0-beta.1"])("refuses another version (%s)", async (version) => {
    const f = fake(version);
    expect(await verifyProviderCli(f.input, { pins, bin: () => f.bin })).toMatchObject({ ok: false, reason: expect.stringMatching(/not the pinned version/) });
  });

  it("refuses a CLI others can change", async () => {
    const f = fake("41.2.0", 0o775);
    expect(await verifyProviderCli(f.input, { pins, bin: () => f.bin })).toMatchObject({ ok: false, reason: expect.stringMatching(/writable by others/) });
  });

  it("refuses a CLI in a folder sessions or builds can write", async () => {
    const f = fake();
    const planted = join(f.dir, "repo", "vercel");
    writeFileSync(planted, "#!/usr/bin/env node\nconsole.log('41.2.0');\n", { mode: 0o755 });
    expect(await verifyProviderCli(f.input, { pins, bin: () => planted })).toMatchObject({ ok: false, reason: expect.stringMatching(/sessions or builds can write/) });
  });

  it("refuses a CLI whose --version fails", async () => {
    const f = fake();
    writeFileSync(f.bin, "#!/usr/bin/env node\nconsole.log('41.2.0'); process.exit(3);\n", { mode: 0o755 });
    expect(await verifyProviderCli(f.input, { pins, bin: () => f.bin })).toMatchObject({ ok: false, reason: expect.stringMatching(/--version failed/) });
  });
});
