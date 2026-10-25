import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexReviewer, codexEnvironment } from "../../packages/cli/src/review/codex.ts";
import type { ReviewerInput } from "../../packages/cli/src/review/types.ts";
import { runSession, type SessionSpec } from "../../packages/cli/src/proc/session.ts";
const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.close();
});
// Seatbelt matches real paths; every fixture path is resolved before use.
const darwin = process.platform === "darwin";
const ENV_KEYS = ["ALL_PROXY", "CODEX_CA_CERTIFICATE", "CODEX_HOME", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "OPENSSL_CONF", "PATH", "SSL_CERT_FILE", "TMPDIR", "USER"];

function setup(mode = "pass", version = "codex-cli 0.164.0", probes: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-codex-"))); roots.push(root);
  const workspace = join(root, "checkout"), outputDir = join(root, "output"), tools = join(root, "tools"), home = join(root, "home");
  for (const d of [workspace, outputDir, tools, home]) mkdirSync(d);
  const bin = join(tools, "fake-codex");
  const record = join(outputDir, "calls.jsonl");
  if (mode === "probe") {
    writeFileSync(bin, `#!${process.execPath}\n${readFileSync(resolve("tests/fixtures/fake-confined-codex.mjs"), "utf8")}`, { mode: 0o700 });
    writeFileSync(join(tools, "config.json"), JSON.stringify({ record, version, probes }));
  } else {
    writeFileSync(bin, `#!${process.execPath}\nimport {writeFileSync,appendFileSync,readFileSync} from 'node:fs';
const a=process.argv.slice(2); const val=f=>a[a.indexOf(f)+1];
appendFileSync(${JSON.stringify(record)},JSON.stringify({args:a,env:process.env,stdin:readFileSync(0,'utf8')})+'\\n');
if(a.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
const mode=${JSON.stringify(mode)};
if(mode==='timeout') { process.on('SIGTERM',()=>{ writeFileSync(val('-o'),JSON.stringify({findings:[]})); console.log(JSON.stringify({type:'turn.completed'})); process.exit(0); }); setInterval(()=>{},1000); }
else if(mode==='limit') { console.log(JSON.stringify({type:'error',message:"You've hit your usage limit"})); console.log(JSON.stringify({type:'turn.failed'})); process.exit(1); }
else if(mode==='unrelated') { console.log("You've hit your usage limit"); process.exit(2); }
else { writeFileSync(val('-o'), mode==='garbage'?'not-json':JSON.stringify({findings:[]})); console.log(JSON.stringify({type:mode==='failed'?'turn.failed':'turn.completed'})); }
`, { mode: 0o700 });
  }
  const input: ReviewerInput = { workspace, outputDir, prompt: "review candidate", model: "gpt-6.1-sol", effort: "high", maxTurns: 10, timeoutMs: mode === "timeout" ? 1500 : 20_000 };
  const calls = () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { root, home, tools, input, bin, record, calls, reviewer: createCodexReviewer({ home, binary: bin }) };
}

describe("isolated Codex reviewer", () => {
  it("gives Codex exactly the approved environment keys", () => {
    expect(codexEnvironment({ codexHome: "/jail/codex-home", tmp: "/jail/tmp", proxyPort: 4242 }, "fake-user")).toEqual({
      HOME: "/jail/codex-home/home", USER: "fake-user", PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", CODEX_HOME: "/jail/codex-home", TMPDIR: "/jail/tmp",
      HTTPS_PROXY: "http://127.0.0.1:4242", HTTP_PROXY: "http://127.0.0.1:4242", ALL_PROXY: "http://127.0.0.1:4242",
      CODEX_CA_CERTIFICATE: "/private/etc/ssl/cert.pem", SSL_CERT_FILE: "/private/etc/ssl/cert.pem", OPENSSL_CONF: "/dev/null",
    });
  });
  it.skipIf(!darwin)("checks the exact version and launches under Seatbelt with Codex's own sandbox off, ignored stdin and schema", async () => {
    const s = setup(); const result = await s.reviewer(s.input);
    expect(result.error).toBeUndefined();
    expect(result.rawVerdict).toBe('{"findings":[]}');
    expect(result.reviewer).toBe("codex");
    const calls = s.calls();
    expect(calls[0].args).toEqual(["--version"]);
    expect(calls[1].args).toEqual(["exec", "-C", s.input.workspace, "-m", "gpt-6.1-sol", "--sandbox", "danger-full-access", "--ephemeral", "--json", "--skip-git-repo-check", "-c", "project_doc_max_bytes=0", "-c", 'model_reasoning_effort="high"', "--output-schema", join(s.input.outputDir, "schema.json"), "-o", join(s.input.outputDir, "verdict.json"), "--", "review candidate"]);
    const schema = JSON.parse(readFileSync(join(s.input.outputDir, "schema.json"), "utf8"));
    expect(schema.required).toEqual(["findings"]);
    expect(schema.properties.findings.items.required).toContain("confidence");
    for (const c of calls) {
      expect(Object.keys(c.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(ENV_KEYS);
      expect(c.env.CODEX_HOME).not.toBe(join(s.home, ".jarvis/codex-home"));
      expect(c.stdin).toBe("");
    }
  });
  it.skipIf(!darwin)("recognizes the usage limit sequence", async () => {
    const s = setup("limit");
    expect((await s.reviewer(s.input)).fallbackReason).toBe("usage_limit");
  });
  it.skipIf(!darwin).each(["garbage", "failed", "unrelated", "timeout"])("never offers fallback for %s", async (mode) => {
    const s = setup(mode); const r = await s.reviewer(s.input);
    expect(r.fallbackReason).toBeUndefined();
    if (mode !== "garbage") expect(r.error).toBeTruthy();
    else expect(r.rawVerdict).toBe("not-json");
  });
  it("falls back on a missing absolute binary", async () => {
    const s = setup(); const r = await createCodexReviewer({ home: s.home, binary: join(s.root, "missing") })(s.input);
    expect(r.fallbackReason).toBe("missing_binary");
  });
  it.skipIf(!darwin)("falls back on a version mismatch before launching exec", async () => {
    const s = setup("pass", "codex-cli 0.163.0"); const r = await s.reviewer(s.input);
    expect(r.fallbackReason).toBe("version_mismatch");
    expect(s.calls()).toHaveLength(1);
  });
  it("refuses a PATH binary", () => expect(() => createCodexReviewer({ home: "/safe", binary: "codex" })).toThrow(/absolute/));
});

// Decision 110: the canary. Everything outside the allowed set is planted in this test's own temp folder.
describe.skipIf(!darwin)("confined Codex reviewer reads only its checkout and inputs", () => {
  async function listener(): Promise<number> {
    const server = createServer((socket) => socket.end()); servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return (server.address() as { port: number }).port;
  }
  function plant(root: string, home: string, workspace: string) {
    const token = randomBytes(8).toString("hex");
    const outside = join(root, "outside"); mkdirSync(outside);
    writeFileSync(join(outside, "canary.txt"), `OUTSIDE-${token}`);
    const runnerHome = join(home, ".jarvis"), realCodexHome = join(runnerHome, "codex-home");
    mkdirSync(join(runnerHome, "projects"), { recursive: true }); mkdirSync(realCodexHome);
    writeFileSync(join(runnerHome, "projects", "canary.txt"), `RUNNER-${token}`);
    // A placeholder, not a credential: the reviewer must see this file and nothing else of the real Codex home.
    writeFileSync(join(realCodexHome, "auth.json"), JSON.stringify({ placeholder: token }));
    writeFileSync(join(realCodexHome, "history.sqlite"), `HISTORY-${token}`);
    writeFileSync(join(workspace, "candidate.ts"), `CHECKOUT-${token}`);
    return { token, outside, realCodexHome, runnerHome };
  }
  it("cannot read a canary outside the allowed set, the runner home or Codex's real home, but reads its checkout and private auth", async () => {
    const s = setup("probe");
    const p = plant(s.root, s.home, s.input.workspace);
    const direct = await listener(), upstream = await listener();
    writeFileSync(join(s.tools, "config.json"), JSON.stringify({ record: s.record, probes: {
      read: {
        checkout: join(s.input.workspace, "candidate.ts"), outside: join(p.outside, "canary.txt"), runner: join(p.runnerHome, "projects", "canary.txt"),
        realHistory: join(p.realCodexHome, "history.sqlite"), privateAuth: "$CODEX_HOME/auth.json", privateHistory: "$CODEX_HOME/history.sqlite",
      },
      write: { outside: join(p.outside, "written.txt"), checkout: join(s.input.workspace, "new.txt"), output: join(s.input.outputDir, "scratch.txt"), runner: join(p.runnerHome, "projects", "planted.txt") },
      tcpPort: direct, tunnel: ["example.com", "api.openai.com"],
    } }));
    // The proxy's upstream is a local listener, so an allowed tunnel needs no network.
    const reviewer = createCodexReviewer({ home: s.home, binary: s.bin, confinement: { proxy: { connectUpstream: () => connect(upstream, "127.0.0.1") } } });
    const result = await reviewer(s.input);
    expect(result.error).toBeUndefined();
    const exec = s.calls().find((c) => c.seen);
    expect(exec, "the fake ran its probes").toBeTruthy();
    expect(exec.seen).toEqual({
      "read checkout": `read:CHECKOUT-${p.token}`,
      "read outside": "denied:EPERM",
      "read runner": "denied:EPERM",
      "read realHistory": "denied:EPERM",
      "read privateAuth": `read:${JSON.stringify({ placeholder: p.token })}`,
      "read privateHistory": "denied:ENOENT",
      "write outside": "denied:EPERM",
      "write checkout": "denied:EPERM",
      "write output": "written",
      "write runner": "denied:EPERM",
      tcp: "error:EPERM",
      "tunnel example.com": "HTTP/1.1 403 Forbidden",
      "tunnel api.openai.com": "HTTP/1.1 200 Connection Established",
    });
    expect(existsSync(join(p.outside, "written.txt"))).toBe(false);
    expect(existsSync(join(s.input.workspace, "new.txt"))).toBe(false);
    expect(exec.env.CODEX_HOME).not.toBe(p.realCodexHome);
  });
});


describe("the confinement fails closed", () => {
  it("refuses the review on a platform without Seatbelt and never starts Codex", async () => {
    const s = setup(); const r = await createCodexReviewer({ home: s.home, binary: s.bin, confinement: { platform: "linux" } })(s.input);
    expect(r.error).toMatch(/confinement unavailable, review refused: .*Seatbelt/);
    expect(r.fallbackReason).toBeUndefined();
    expect(s.calls()).toEqual([]);
  });
  it("refuses the review when sandbox-exec is missing", async () => {
    const s = setup(); const r = await createCodexReviewer({ home: s.home, binary: s.bin, confinement: { sandboxExec: join(s.root, "no-sandbox-exec") } })(s.input);
    expect(r.error).toMatch(/confinement unavailable, review refused: sandbox-exec is missing/);
    expect(s.calls()).toEqual([]);
  });
  it.skipIf(!darwin)("refuses the review when the profile can't be applied at all", async () => {
    const s = setup(); const r = await createCodexReviewer({ home: s.home, binary: s.bin, confinement: { sandboxExec: "/usr/bin/false" } })(s.input);
    expect(r.error).toMatch(/could not be applied/);
    expect(s.calls()).toEqual([]);
  });
  it.skipIf(!darwin)("starts every Codex process, the version check included, through sandbox-exec with the review's profile", async () => {
    const s = setup(); const specs: SessionSpec[] = [];
    const r = await createCodexReviewer({ home: s.home, binary: s.bin, session: (spec) => { specs.push(spec); return runSession(spec); } })(s.input);
    expect(r.error).toBeUndefined();
    const codexRuns = specs.filter((spec) => spec.args.includes(s.bin));
    expect(codexRuns.map((spec) => spec.args[spec.args.indexOf(s.bin) + 1])).toEqual(["--version", "exec"]);
    for (const spec of specs) {
      expect(spec.bin).toBe("/usr/bin/sandbox-exec");
      expect(spec.args[0]).toBe("-f");
    }
    expect(new Set(specs.map((spec) => spec.args[1])).size).toBe(1);
  });
  it.skipIf(!darwin)("refuses the review when the profile doesn't hold: a sandbox-exec that ignores it lets the canary be read", async () => {
    const s = setup();
    const ignoring = join(s.tools, "ignoring-sandbox-exec");
    writeFileSync(ignoring, "#!/bin/sh\nshift 2\nexec \"$@\"\n", { mode: 0o700 });
    const r = await createCodexReviewer({ home: s.home, binary: s.bin, confinement: { sandboxExec: ignoring } })(s.input);
    expect(r.error).toMatch(/canary/);
    expect(s.calls()).toEqual([]);
  });
});
