// A stand-in for `claude -p --output-format stream-json`, used by unit tests.
// It derives its init message from the flags and settings it was given, the way
// the real binary does, and acts out one behavior chosen by FAKE_CLAUDE_MODE:
//   safe | leak-read | leak-network | escape-write | dropped-settings | lazy
// It never touches anything outside the paths in the probe's steps.
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const argv = process.argv.slice(2);
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const mode = process.env.FAKE_CLAUDE_MODE ?? "safe";
const prompt = flag("-p") ?? "";
const settings = JSON.parse(readFileSync(flag("--settings"), "utf8"));
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (argv.includes("--version")) { console.log(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.309"} (Claude Code)`); process.exit(0); }

const init = {
  type: "system", subtype: "init",
  claude_code_version: process.env.FAKE_CLAUDE_VERSION ?? "2.1.309",
  model: flag("--model"),
  permissionMode: flag("--permission-mode") ?? "default",
  apiKeySource: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "none",
  plugins: [
    { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" },
    ...(flag("--setting-sources") === "project" && mode !== "user-plugins" ? [] : [{ name: "user-plugin", path: "/x", source: "user-plugin@market" }]),
  ],
  tools: ["Bash", "Read", "Write"],
};
if (settings.autoMemoryEnabled !== false || mode === "memory-on") init.memory_paths = { auto: "/fake/.claude/projects/x/memory/" };
out(init);
out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1792786200, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1792786200 } } } });

if (mode === "lazy") {
  out({ type: "assistant", message: { content: [{ type: "text", text: "I won't run these." }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "I won't run these." });
  process.exit(0);
}

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
  else if (st.tool === "Bash") {
    // Act out selftest.sh line by line, the way a sandboxed shell would for this mode.
    const lines = readFileSync(st.command.replace(/^sh /, ""), "utf8").split("\n");
    const line = (id) => lines.find((l) => l.endsWith(`# step:${id}`)) ?? "";
    const res = [];
    { const [, val, file] = line("A").match(/printf %s (\S+) > (\S+)/); writeFileSync(file, val); res.push("A:ok"); }
    { const [, path, msg] = line("C").match(/connect\('([^']+)'\);s\.sendall\(b'([^']+)'\)/); res.push(`C:${await socketSend(path, msg)}`); }
    { const file = line("D").match(/^cat (\S+)/)[1]; res.push(mode === "leak-read" ? `D:${readFileSync(file, "utf8").trim()}` : `D:cat: ${file}: Operation not permitted`); }
    res.push(mode === "leak-network" ? "F:200" : "F:000");
    { const file = line("G").match(/printf x > (\S+)\)/)[1]; if (mode === "escape-write") { writeFileSync(file, "x"); res.push("G:written"); } else res.push("G:blocked"); }
    isError = false; text = res.join("\n");
  }
  else if (st.tool === "Write" && st.file_path.includes("/work/")) { writeFileSync(st.file_path, st.content); isError = false; text = "File created"; }
  else if (st.tool === "Read") text = "File is in a directory that is denied by your permission settings.";
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] } });
}
out({ type: "result", subtype: "success", is_error: false, result: "DONE" });
