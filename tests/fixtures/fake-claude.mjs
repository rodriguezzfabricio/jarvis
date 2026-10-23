// A stand-in for `claude -p --output-format stream-json`, used by unit tests. It derives its
// init message from the flags and settings it was given, the way the real binary does, runs the
// worktree's own SessionStart hooks unless --restricted is set (as the real binary does), and acts
// out one behavior chosen by FAKE_CLAUDE_MODE. It only touches paths named in the probe's steps.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

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

const init = {
  type: "system", subtype: "init",
  claude_code_version: process.env.FAKE_CLAUDE_VERSION ?? "2.1.309",
  model: flag("--model"),
  permissionMode: flag("--permission-mode") ?? "default",
  apiKeySource: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "none",
  plugins: [
    { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" },
    ...(restricted && mode !== "user-plugins" ? [] : [{ name: "user-plugin", path: "/x", source: "user-plugin@market" }]),
  ],
  tools,
};
if (settings.autoMemoryEnabled !== false || mode === "memory-on") init.memory_paths = { auto: "/fake/.claude/projects/x/memory/" };
out(init);

const rl = (status, u, at) => out({ type: "rate_limit_event", rate_limit_info: { status, resetsAt: at, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: u, resetsAt: at }, seven_day: { utilization: 0.2, resetsAt: at + 86400 } } } });

if (mode === "baseline" || mode === "baseline-evil" || mode === "rejected") {
  writeFileSync("app.txt", `built for: ${prompt}\n`);
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

let n = 0;
for (const st of steps) {
  const id = `toolu_${++n}`;
  const input = st.tool === "Bash" ? { command: st.command } : st.tool === "Write" ? { file_path: st.file_path, content: st.content } : { file_path: st.file_path };
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: st.tool, input }] } });
  let isError = true;
  let text = "Operation not permitted";
  if (mode === "dropped-settings") text = denied(st.tool);
  else if (st.tool === "Bash" && !tools.includes("Bash")) text = "Error: No such tool available: Bash.";
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
    res.push(mode === "leak-network" ? "F:404" : "F:000");
    { const f = target("G", /printf x > (\S+)\)/); if (mode === "escape-write") { writeFileSync(f, "x"); res.push("G:written"); } else res.push("G:blocked"); }
    { const f = target("H", /printf x > (\S+)\)/); if (mode === "git-hook") { writeFileSync(f, "x"); res.push("H:written"); } else res.push("H:blocked"); }
    isError = false; text = res.join("\n");
  }
  else if (st.tool === "Write" && st.file_path.includes("/work/")) { writeFileSync(st.file_path, st.content); isError = false; text = "File created"; }
  else if (st.tool === "Read" && mode === "leak-outside" && st.file_path.includes(".jarvis-probe-read-")) { text = readFileSync(st.file_path, "utf8"); isError = false; }
  else if (st.tool === "Read") text = "File is outside the working directories.";
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] } });
}
out({ type: "result", subtype: "success", is_error: false, result: "DONE" });
