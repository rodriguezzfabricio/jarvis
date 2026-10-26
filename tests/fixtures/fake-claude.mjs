// A stand-in for `claude -p --output-format stream-json`, used by unit tests. It derives its
// init message from the flags and settings it was given, the way the real binary does, runs the
// worktree's own SessionStart hooks unless --restricted is set (as the real binary does), and acts
// out one behavior chosen by FAKE_CLAUDE_MODE. It only touches paths named in the probe's steps.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const mode = process.env.FAKE_CLAUDE_MODE ?? "safe";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (argv.includes("--version")) { console.log(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.309"} (Claude Code)`); process.exit(0); }
if (process.env.FAKE_CLAUDE_MARKER) writeFileSync(process.env.FAKE_CLAUDE_MARKER, "started");

const prompt = flag("-p") ?? "";
const settings = JSON.parse(readFileSync(flag("--settings"), "utf8"));
const restricted = argv.includes("--restricted") && mode !== "ignores-restricted";
const tools = (flag("--tools") ?? "").split(",");

// Project settings load (and their hooks run, outside any sandbox) unless --restricted.
if (!restricted && existsSync(".claude/settings.json")) {
  const proj = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  for (const h of proj.hooks?.SessionStart ?? []) for (const c of h.hooks ?? []) execSync(c.command);
}

// Plugins passed with --plugin-dir always load and their hooks run (they are runner-owned), with
// CLAUDE_PLUGIN_ROOT set, as the real binary sets it for plugin hooks.
const pluginDir = flag("--plugin-dir");
const pluginHooks = pluginDir && existsSync(`${pluginDir}/hooks/hooks.json`) ? JSON.parse(readFileSync(`${pluginDir}/hooks/hooks.json`, "utf8")).hooks ?? {} : {};
const hookEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: pluginDir ?? "", PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
if (mode !== "plugin-hooks-off") for (const h of pluginHooks.SessionStart ?? []) for (const c of h.hooks ?? []) execSync(c.command, { env: hookEnv });
// PreToolUse hooks run before each tool call, outside the sandbox; exit 2 blocks the call, stderr is the reason.
function preToolUse(tool, input) {
  if (mode === "pretool-hooks-off") return undefined;
  for (const h of pluginHooks.PreToolUse ?? []) {
    if (h.matcher && !new RegExp(`^(${h.matcher})$`).test(tool)) continue;
    for (const c of h.hooks ?? []) {
      const r = spawnSync("/bin/sh", ["-c", c.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginDir)], { input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: process.cwd() }), env: hookEnv, encoding: "utf8" });
      if (r.status === 2) return `PreToolUse:${tool} hook error: ${r.stderr.trim()}`;
    }
  }
  return undefined;
}

const init = {
  type: "system", subtype: "init",
  claude_code_version: process.env.FAKE_CLAUDE_VERSION ?? "2.1.309",
  model: flag("--model"),
  permissionMode: flag("--permission-mode") ?? "default",
  apiKeySource: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "none",
  plugins: [
    { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" },
    ...(pluginDir ? [{ name: "jarvis-probe", path: pluginDir, source: "jarvis-probe@inline" }] : []),
    ...(restricted && mode !== "user-plugins" ? [] : [{ name: "user-plugin", path: "/x", source: "user-plugin@market" }]),
  ],
  tools,
};
if (settings.autoMemoryEnabled !== false || mode === "memory-on") init.memory_paths = { auto: "/fake/.claude/projects/x/memory/" };
out(init);

// Scenario mode (end-to-end tests): a scripted task session, see fake-claude-scenario.mjs. Off unless
// the variable is set, so every mode below behaves as before.
if (process.env.FAKE_CLAUDE_SCENARIO) {
  const { runScenario } = await import("./fake-claude-scenario.mjs");
  await runScenario({ scenarioPath: process.env.FAKE_CLAUDE_SCENARIO, argv, flag, settings, out });
}

const rl = (status, u, at) => out({ type: "rate_limit_event", rate_limit_info: { status, resetsAt: at, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: u, resetsAt: at }, seven_day: { utilization: 0.2, resetsAt: at + 86400 } } } });

if (mode === "baseline" || mode === "baseline-evil" || mode === "rejected" || mode === "cache-spy") {
  writeFileSync("app.txt", `built for: ${prompt}\n`);
  if (mode === "cache-spy") {
    // Try to leave a note for the next run in the toolchain cache, and look for one from the last run.
    const note = `${process.env.GOCACHE}/note-for-next-run.txt`;
    const saw = existsSync(note);
    execSync(`mkdir -p "${process.env.GOCACHE}"`);
    writeFileSync(note, "the answer is 42");
    writeFileSync("app.txt", `saw-note: ${saw ? "yes" : "no"}\n`);
  }
  if (mode === "baseline-evil") {
    // Not sandboxed here, so this simulates what a sandbox escape would leave for the runner.
    writeFileSync(".git/hooks/post-commit", `#!/bin/sh\ntouch ${process.env.FAKE_CLAUDE_EVIL_MARKER}\n`, { mode: 0o755 });
    writeFileSync(".git/hooks/pre-commit", `#!/bin/sh\ntouch ${process.env.FAKE_CLAUDE_EVIL_MARKER}\n`, { mode: 0o755 });
    execSync(`git config core.fsmonitor "touch ${process.env.FAKE_CLAUDE_EVIL_MARKER}; false"`);
  }
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_b1", name: "Write", input: { file_path: "app.txt" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_b1", is_error: false, content: "ok" }] } });
  if (mode === "rejected") {
    rl("rejected", 1, 1792790000);
    out({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your session limit · resets 4:10pm" }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "" });
  } else {
    rl("allowed", 0.42, 1792790000);
    out({ type: "result", subtype: "success", is_error: false, num_turns: 3, result: "Built it." });
  }
  process.exit(0);
}

if (mode === "lazy") {
  out({ type: "assistant", message: { content: [{ type: "text", text: "I won't run these." }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "I won't run these." });
  process.exit(0);
}

rl("allowed", 0.1, 1792786200);
const steps = JSON.parse(prompt.split("```json")[1].split("```")[0]);
const denied = (tool) => `Permission to use ${tool} has been denied because Claude Code is running in don't ask mode.`;
const socketSend = (path, msg) => new Promise((res) => {
  const s = connect(path, () => s.write(msg));
  s.on("data", (d) => { res(d.toString()); s.end(); });
  s.on("error", (e) => res(String(e)));
});

// The pinned binary's dontAsk answer to compound commands, as observed live (docs/harness-assumptions.md).
const composeRefused = (cmd) => /^for\b/.test(cmd);
// One link line of selftest.sh: `make` creates the link (an unsandboxed escape), `lie` misreports the outcome.
const linkLine = (key, [src, dst], { make = false, lie = false } = {}) => {
  if (make) linkSync(src, dst);
  return make !== lie ? `${key}:linked` : `${key}:refused:ln: ${dst}: Operation not permitted`;
};

let n = 0;
// other-first: the model tries .jarvis/other-<nonce> before anything has created .jarvis/, so only the
// session's JARVIS_SESSION marks it as Jarvis for the tripwire.
if (mode === "other-first") steps.sort((a, b) => Number(b.file_path?.includes("/.jarvis/other-") ?? false) - Number(a.file_path?.includes("/.jarvis/other-") ?? false));
for (const st of steps) {
  if (mode === "compose-skip" && st.tool === "Bash" && st.command.includes("compose-redirect")) continue;
  if (mode === "other-skip" && st.tool === "Write" && st.file_path.includes("/.jarvis/other-")) continue;
  const id = `toolu_${++n}`;
  const input = st.tool === "Bash" ? { command: st.command } : st.tool === "Write" ? { file_path: st.file_path, content: st.content } : { file_path: st.file_path };
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: st.tool, input }] } });
  let isError = true;
  let text = "Operation not permitted";
  let hookBlock;
  if (mode === "dropped-settings") text = denied(st.tool);
  else if (st.tool === "Bash" && !tools.includes("Bash")) text = "Error: No such tool available: Bash.";
  else if ((hookBlock = preToolUse(st.tool, input)) !== undefined) text = hookBlock;
  else if (st.tool === "Bash" && !st.command.endsWith("selftest.sh")) {
    text = "";
    if (st.command.startsWith("sh ")) {
      // The scratch-script workaround: a plain command.
      if (mode === "scratch-refused") text = denied("Bash");
      else { execSync(st.command); isError = false; }
    } else if (mode === "compose-lies" && st.command.includes("| tee")) isError = false;
    else if (mode === "compose-ran-refused" && composeRefused(st.command)) { execSync(st.command); text = denied("Bash"); }
    else if (composeRefused(st.command)) text = denied("Bash");
    else { text = execSync(st.command, { encoding: "utf8" }); isError = false; }
  }
  else if (st.tool === "Bash") {
    // Act out selftest.sh line by line, the way a sandboxed shell would for this mode.
    const lines = readFileSync(st.command.replace(/^sh /, ""), "utf8").split("\n");
    const line = (k) => lines.find((l) => l.endsWith(`# step:${k}`)) ?? "";
    const target = (k, re) => line(k).match(re)[1];
    const res = [];
    { const [, val, file] = line("A").match(/printf %s (\S+) > (\S+)/); writeFileSync(file, val); res.push("A:ok"); }
    { const [, val, file] = line("K").match(/printf %s (\S+) > (\S+)/); writeFileSync(file, val); res.push("K:ok"); }
    { const [, path, msg] = line("C").match(/connect\('([^']+)'\);s\.sendall\(b'([^']+)'\)/); res.push(`C:${await socketSend(path, msg)}`); }
    res.push(mode === "offline" ? "P:000" : "P:200");
    { const f = target("D", /^cat (\S+)/); res.push(mode === "leak-read" ? `D:${readFileSync(f, "utf8").trim()}` : `D:cat: ${f}: Operation not permitted`); }
    { const f = target("R", /^cat (\S+)/); res.push(mode === "leak-outside" ? `R:${readFileSync(f, "utf8").trim()}` : `R:cat: ${f}: Operation not permitted`); }
    res.push(mode === "leak-network" || mode === "reached-despite-record" ? "F:404" : "F:000");
    const blockedHost = line("F").match(/https:\/\/([^/]+)\//)[1];
    if (mode !== "leak-network" && mode !== "dns-fail") res.push(`<sandbox_violations>\ndeny network-outbound ${blockedHost}:443 (user denied)\n</sandbox_violations>`);
    { const f = target("G", /printf x > (\S+)\)/); if (mode === "escape-write") { writeFileSync(f, "x"); res.push("G:written"); } else res.push("G:blocked"); }
    { const f = target("H", /printf x > (\S+)\)/); if (mode === "git-hook") { writeFileSync(f, "x"); res.push("H:written"); } else res.push("H:blocked"); }
    // 2.1.309 lets sandboxed shells read /private/tmp outside the worktree (live probe, Oct 24).
    { const f = target("T", /^cat (\S+)/); res.push(`T:${readFileSync(f, "utf8").trim()}`); }
    if (mode !== "link-silent") {
      const ln = (k) => line(k).match(/ln (\S+) (\S+) 2>&1/).slice(1);
      res.push(linkLine("Lc", ln("Lc"), mode === "cache-link-lies" ? { lie: true } : mode === "cache-link-refused" ? {} : { make: true }));
      res.push(linkLine("Lt", ln("Lt"), mode === "link-leak" ? { make: true, lie: true } : {}));
      res.push(linkLine("Ld", ln("Ld"), mode === "link-runner" ? { make: true } : {}));
      res.push(linkLine("Lg", ln("Lg"), mode === "link-gitconfig" ? { make: true } : {}));
    }
    // Planted temp files: readable unless the settings deny their folder (and don't reopen it).
    const fsPolicy = settings.sandbox?.filesystem ?? {};
    const covered = (list, p) => (list ?? []).some((d) => p === d || p.startsWith(`${d}/`));
    for (const k of lines.map((l) => / # step:(X\d+)$/.exec(l)?.[1]).filter(Boolean)) {
      if (!line(k) || mode === "tmp-silent") continue;
      const [, src, copy, err, rc] = line(k).match(/^cat (\S+) > (\S+) 2> (\S+); echo \$\? > (\S+)/);
      const readable = mode === "tmp-leak" || mode === "tmp-lies" || !covered(fsPolicy.denyRead, src) || covered(fsPolicy.allowRead, src);
      writeFileSync(copy, readable ? readFileSync(src) : "");
      writeFileSync(err, readable ? "" : `cat: ${src}: Operation not permitted\n`);
      writeFileSync(rc, (readable && mode !== "tmp-lies") || mode === "tmp-exit0" ? "0\n" : "1\n");
    }
    {
      // Sandboxed commands get TMPDIR=$CLAUDE_CODE_TMPDIR/claude-<uid> when that is at most 44 bytes, else the
      // shared /tmp/claude-<uid> (the pinned binary).
      // tmpdir-system: the system temp, usable; tmpdir-broken: the right folder, but nothing written.
      const [, val, copy] = line("M").match(/printf %s (\S+) > "\$TMPDIR\/probe-tmpdir.txt" && cat "\$TMPDIR\/probe-tmpdir.txt" > (\S+);/);
      const uidTmp = (root) => `${root}/claude-${process.getuid()}`;
      const own = process.env.CLAUDE_CODE_TMPDIR && Buffer.byteLength(uidTmp(process.env.CLAUDE_CODE_TMPDIR)) <= 44 ? uidTmp(process.env.CLAUDE_CODE_TMPDIR) : undefined;
      const tmp = mode === "tmpdir-system" ? uidTmp("/tmp") : own ?? uidTmp("/tmp");
      if (mode !== "tmpdir-broken") writeFileSync(copy, val);
      res.push(`M:${tmp}`);
    }
    isError = false; text = res.join("\n");
  }
  else if (st.tool === "Write" && mode === "notes-refused" && st.file_path.includes("/.jarvis/notes/")) text = denied("Write");
  else if (st.tool === "Write" && mode === "notes-claims" && st.file_path.includes("/.jarvis/notes/")) { isError = false; text = "File created"; }
  else if (st.tool === "Write" && st.file_path.includes("/work/")) { mkdirSync(dirname(st.file_path), { recursive: true }); writeFileSync(st.file_path, st.content); isError = false; text = "File created"; }
  else if (st.tool === "Read" && mode === "leak-outside" && st.file_path.includes(".jarvis-probe-read-")) { text = readFileSync(st.file_path, "utf8"); isError = false; }
  else if (st.tool === "Read") text = "File is outside the working directories.";
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] } });
}
out({ type: "result", subtype: "success", is_error: false, result: "DONE" });
