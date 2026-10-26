import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { installDesktopChecks } from "../../packages/cli/src/lanes/desktop.ts";
import { observeDesktopBuild } from "../../packages/cli/src/lanes/desktop-observe.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import * as sandbox from "../../packages/cli/src/sandbox/srt.ts";

// CLI workers cannot nest SRT's mux sandbox. Fake the wrapper factory; keep runSandboxed and its shell real.
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  if (process.env.JARVIS_QA_REAL_SRT === "1") return { ...actual, execFile: vi.fn(actual.execFile) };
  return { ...actual, execFile: vi.fn((_bin: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => ({
    stdin: { end(data: string) { callback(null, (JSON.parse(data) as { command: string }).command, ""); } },
  })) };
});

const roots: string[] = [];
const temp = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "qa-worker-env-"))); roots.push(root); return root; };
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function setup() {
  const root = temp(); const repo = join(root, "checkout"); mkdirSync(repo);
  const build = join(repo, "build.mjs");
  writeFileSync(build, `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('target/Test.app/Contents/MacOS', { recursive: true });
writeFileSync('target/Test.app/Contents/Info.plist', 'fake plist');
writeFileSync('build-env.json', JSON.stringify(process.env));`);
  const plan = { nodeBin: process.execPath, tauriBin: process.execPath, build: { bin: process.execPath, args: [build] }, bundle: "target/Test.app", stayUpMs: 100, shutdownMs: 100, buildTimeoutMs: 2000 };
  const store = new ChecksStore(join(root, "project")); installDesktopChecks(store, plan);
  const allowed = { PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, TMPDIR: root, LANG: "C", LC_ALL: "C", CI: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GOMODCACHE: root, GOCACHE: root, npm_config_cache: root, CARGO_HOME: root, RUSTUP_HOME: root, DEVELOPER_DIR: root };
  const env = { ...allowed, JARVIS_FIXTURES: join(store.checksDir, "fixtures"), PWD: repo, SHLVL: "7", _: "/bin/sh", HTTP_PROXY: "http://proxy.invalid:1234", HTTPS_PROXY: "http://proxy.invalid:1234", UNTRUSTED_BUILD_OPTION: "planted-value" };
  const worker = join(store.checksDir, "fixtures/desktop/lanes/desktop-worker.ts");
  return { root, repo, plan, allowed, env, worker, command: `${quote(process.execPath)} ${quote(worker)}` };
}

describe("desktop worker environment boundary (backlog 88)", () => {
  it("runs the installed worker with shell and proxy variables and returns an observed fake build", async () => {
    const s = setup();
    const result = await runSession({ bin: process.execPath, args: [s.worker], cwd: s.repo, env: s.env, timeoutMs: 5000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "observed", build: { code: 0 } });
    const buildEnv = JSON.parse(readFileSync(join(s.repo, "build-env.json"), "utf8"));
    // macOS can add this value at process startup, independently of the worker's spawn environment.
    if (process.platform === "darwin") delete buildEnv.__CF_USER_TEXT_ENCODING;
    expect(buildEnv).toEqual({ ...s.allowed, CARGO_NET_OFFLINE: "true", npm_config_offline: "true", YARN_ENABLE_NETWORK: "0" });
  });
  it("runs the installed entry through runSandboxed and its shell", async () => {
    const s = setup();
    const result = await sandbox.runSandboxed({ command: s.command, cwd: s.repo, env: s.env, policy: { allowRead: [s.root], denyRead: [], allowWrite: [s.root] }, timeoutMs: 5000 });
    expect(execFile).toHaveBeenCalledOnce(); expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "observed", build: { code: 0 } });
    const buildEnv = JSON.parse(readFileSync(join(s.repo, "build-env.json"), "utf8"));
    for (const key of ["PWD", "SHLVL", "_", "HTTP_PROXY", "HTTPS_PROXY", "UNTRUSTED_BUILD_OPTION", "JARVIS_FIXTURES"]) expect(buildEnv).not.toHaveProperty(key);
  });
  it("keeps the observer's strict rejection of non-allowlisted keys", async () => {
    const s = setup();
    await expect(observeDesktopBuild(s.repo, s.plan, { HTTP_PROXY: "http://proxy.invalid:1234" })).rejects.toThrow(/allowlist/);
  });
});
