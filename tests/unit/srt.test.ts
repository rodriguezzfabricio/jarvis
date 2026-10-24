import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runSandboxed } from "../../packages/cli/src/sandbox/srt.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jtsr-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

async function run(command: string, env: Record<string, string> = {}) {
  const dir = join(root, `r${++n}`);
  mkdirSync(join(dir, "tmp"), { recursive: true });
  const r = await runSandboxed({
    policy: { allowRead: [dir], denyRead: [], allowWrite: [dir] },
    command,
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", TMPDIR: join(dir, "tmp"), ...env },
    timeoutMs: 30_000,
    stdoutPath: join(dir, "out"),
    stderrPath: join(dir, "err"),
  });
  return { code: r.code, out: readFileSync(join(dir, "out"), "utf8"), dir };
}

/** The library's shared temp folder exists wherever Claude Code has run; make sure it does here too. */
function withSharedTmp<T>(fn: () => Promise<T>): Promise<T> {
  const made = ["/private/tmp/claude"].filter((d) => !existsSync(d));
  for (const d of made) mkdirSync(d, { recursive: true });
  return fn().finally(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
}

// Codex stage 0 review 16, lane D.
describe("sandboxed runs", { timeout: 60_000 }, () => {
  it("never copies the runner's own environment into the sandbox, even through the wrapper the library builds", async () => {
    const keys = ["JAVA_TOOL_OPTIONS", "HTTPS_PROXY", "HTTP_PROXY", "NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_TMPDIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.JAVA_TOOL_OPTIONS = "-Djavax.net.ssl.keyStorePassword=RunnerSecretJ7q";
    process.env.HTTPS_PROXY = "http://svc:RunnerSecretP4x@proxy.acme.net:3128";
    process.env.HTTP_PROXY = "http://svc:RunnerSecretP5y@proxy.acme.net:3128";
    process.env.NODE_EXTRA_CA_CERTS = "/Users/x/RunnerSecretCa.pem";
    process.env.CLAUDE_CODE_TMPDIR = "/private/tmp/RunnerSecretTmp";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    process.env.GIT_CONFIG_VALUE_0 = "Authorization: Bearer RunnerSecretG8z";
    try {
      const r = await run("env");
      expect(r.code).toBe(0);
      expect(r.out).toContain("PATH=");
      expect(r.out).not.toContain("RunnerSecret");
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("gives the command the run's own TMPDIR, not the library's shared one", async () => {
    const r = await run('echo "TMPDIR=$TMPDIR"; t=$(mktemp "$TMPDIR/x.XXXXXX") && echo made');
    expect(r.out).toContain(`TMPDIR=${join(r.dir, "tmp")}\n`);
    expect(r.out).toContain("made");
  });

  it("can't write to the library's shared temp folder", () =>
    withSharedTmp(async () => {
      const r = await run('for d in /tmp/claude /private/tmp/claude; do echo x > "$d/jarvis-probe-$$" 2>/dev/null && echo "WROTE $d" && rm -f "$d/jarvis-probe-$$"; done; echo done');
      expect(r.out).toContain("done");
      expect(r.out).not.toContain("WROTE");
    }));
});
