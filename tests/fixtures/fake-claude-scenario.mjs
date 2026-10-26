// Scenario mode for tests/fixtures/fake-claude.mjs: scripts what a task session does in its cwd, so the
// runner loop can be tested end to end without the real claude. Loaded only when FAKE_CLAUDE_SCENARIO
// names a scenario file; without it the fake behaves exactly as before. Plain Node, no dependencies.
//
// The variable is set by the test's own `claude` shim (tests/integration/e2e-helpers.ts), never by the
// runner, so buildChildEnv's allowlist stays as it is. Next to the scenario file the fake keeps
// <file>.state (which sessions were used, under <file>.lock) and <file>.calls.jsonl (one line per launch).
//
// Scenario file (JSON):
//   { "description": "...",
//     "sessions": [
//       { "name": "T1-attempt-1",        // shows up in the calls log
//         "task": "T1",                  // optional: only for a session whose prompt or run header has the line "Task: T1"
//         "match": "regex",              // optional: tested (flag m) against prompt + "\n" + run header
//         "repeat": false,               // optional: true keeps the session available after use
//         "rateLimitAtStart": true,      // optional: the "allowed" rate_limit_event every real run emits first
//         "steps": [ ... ] } ] }
// Each launch takes the first unused session that matches, in file order. No match: an error result, exit 1.
//
// Steps (paths are relative to the cwd and may not leave it, or enter .git, unless "escape": true,
// which simulates a sandbox escape; absolute paths need "escape" too):
//   { "write": "src/a.mjs", "content": "..." }   or "lines": ["...", "..."] (joined, trailing newline)
//   { "edit": "src/a.mjs", "old": "...", "new": "..." }   (an is_error tool_result if "old" isn't there)
//   { "delete": "src/a.mjs" }
//   { "notes": "text", "task": "T1" }           writes .jarvis/notes/<task>.md (task defaults to the session's)
//   { "bash": "node --test", "output": "...", "isError": false }   events only; nothing is executed
//   { "exec": "jarvis act …", "saveAs": "act.out" }   runs the command with /bin/sh in the session's own
//        environment and cwd, as a Bash tool call (unsandboxed: the sandbox is tested elsewhere); "saveAs"
//        also writes its output and "EXIT:<status>" to that workspace path
//   { "text": "assistant text" }
//   { "event": { ...raw stream-json event... } }
//   { "rateLimit": { "status": "rejected", "resetsInSec": 2 } }    or "resetsAt" (Unix seconds); also
//        "utilization", "type"; a rejected one is followed by the assistant rate_limit error message
//        unless "message": false (decision 62; stage0-findings §2 for the shape)
//   { "sleepMs": 500 }
//   { "result": { "subtype": "success", "is_error": false, "text": "Done" } }
//   { "exit": 1 }                                  exits now, with no further output
//   { "hang": true }                               never ends (for timeout tests)
// After the last step: a success result (unless one was emitted), then exit 0.
//
// Every launch is also checked against the permanent safety envelope (AGENTS.md); a launch that misses
// any requirement does nothing, logs the problems and exits 3.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BUILD_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"];
const FULL_MODEL_ID = /^claude-[a-z]+-\d+(-\d+)*(-\d{8})?$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN_ENV = [/^ANTHROPIC_API_KEY$/, /^ANTHROPIC_AUTH_TOKEN$/, /^ANTHROPIC_BASE_URL$/, /^CLAUDE_CODE_USE_/, /_BASE_URL$/, /^CLAUDE_CONFIG_DIR$/, /^CLAUDE_CODE_OAUTH_TOKEN$/];

/** Problems with how this session was launched, against the permanent safety requirements. */
export function envelopeProblems(argv, settings, env) {
  const values = (f) => argv.flatMap((a, i) => (a === f ? [argv[i + 1]] : a.startsWith(`${f}=`) ? [a.slice(f.length + 1)] : []));
  const once = (f, v) => { const got = values(f); return got.length === 1 && got[0] === v ? [] : [`${f} ${v} (got ${JSON.stringify(got)})`]; };
  const p = [
    ...once("--permission-mode", "dontAsk"),
    ...once("--permission-prompts", "none"),
    ...once("--output-format", "stream-json"),
  ];
  if (argv.filter((a) => a === "--restricted").length !== 1) p.push("--restricted exactly once");
  const tools = values("--tools");
  if (tools.length !== 1 || (tools[0] ?? "").split(",").some((t) => !BUILD_TOOLS.includes(t))) p.push(`--tools must be one list from BUILD_TOOLS (got ${JSON.stringify(tools)})`);
  for (const f of ["--strict-mcp-config", "--no-session-persistence", "--mcp-config", "--settings"]) if (!argv.includes(f)) p.push(`missing ${f}`);
  for (const f of ["--setting-sources", "--dangerously-skip-permissions", "--resume", "--continue", "--add-dir"]) if (argv.some((a) => a === f || a.startsWith(`${f}=`))) p.push(`forbidden ${f}`);
  const model = values("--model");
  if (model.length !== 1 || !FULL_MODEL_ID.test(model[0] ?? "")) p.push(`--model must be one full model ID (got ${JSON.stringify(model)})`);
  if (settings?.sandbox?.enabled !== true) p.push("sandbox.enabled");
  if (settings?.sandbox?.failIfUnavailable !== true) p.push("sandbox.failIfUnavailable");
  if (settings?.sandbox?.allowUnsandboxedCommands !== false) p.push("sandbox.allowUnsandboxedCommands");
  if (settings?.autoMemoryEnabled !== false) p.push("autoMemoryEnabled");
  if (settings?.permissions?.blockReadsOutsideWorkingDirectories !== true) p.push("permissions.blockReadsOutsideWorkingDirectories");
  for (const k of Object.keys(env)) if (env[k] && FORBIDDEN_ENV.some((re) => re.test(k))) p.push(`credential or reroute variable in env: ${k}`);
  return p;
}

function withLock(lockDir, fn) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { mkdirSync(lockDir); break; } catch (e) {
      if (e.code !== "EEXIST" || Date.now() > deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { rmdirSync(lockDir); }
}

const taskOf = (text) => text.match(/^Task: (\S+)$/m)?.[1];

/** Picks and marks the session for this launch. Exported for tests. */
export function pickSession(scenario, used, text) {
  const task = taskOf(text);
  return scenario.sessions.findIndex((s, i) =>
    (s.repeat === true || !used.includes(i))
    && (s.task === undefined || s.task === task)
    && (s.match === undefined || new RegExp(s.match, "m").test(text)));
}

export async function runScenario({ scenarioPath, argv, flag, settings, out }) {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  if (!Array.isArray(scenario.sessions)) throw new Error("scenario needs a sessions array");
  const cwd = process.cwd();
  const prompt = flag("-p") ?? "";
  const headerPath = flag("--append-system-prompt-file");
  const header = headerPath && existsSync(headerPath) ? readFileSync(headerPath, "utf8") : "";
  const text = `${prompt}\n${header}`;
  const problems = envelopeProblems(argv, settings, process.env);

  const statePath = `${scenarioPath}.state`;
  const index = problems.length ? -1 : withLock(`${scenarioPath}.lock`, () => {
    const used = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).used : [];
    const i = pickSession(scenario, used, text);
    if (i >= 0 && !used.includes(i)) writeFileSync(statePath, JSON.stringify({ used: [...used, i] }));
    return i;
  });
  const session = index >= 0 ? scenario.sessions[index] : undefined;
  const calls = existsSync(`${scenarioPath}.calls.jsonl`) ? readFileSync(`${scenarioPath}.calls.jsonl`, "utf8").split("\n").filter(Boolean).length : 0;
  appendFileSync(`${scenarioPath}.calls.jsonl`, `${JSON.stringify({
    n: calls + 1, session: session?.name ?? null, index, task: taskOf(text) ?? null, cwd,
    model: flag("--model") ?? null, effort: flag("--effort") ?? null, tools: flag("--tools") ?? null, maxTurns: flag("--max-turns") ?? null,
    prompt, envelope: problems, ts: Date.now(),
  })}\n`);

  const finish = async (code) => {
    await new Promise((res) => process.stdout.write("", res));
    process.exit(code);
  };
  if (problems.length) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: `fake-claude refused an unsafe launch: ${problems.join("; ")}` });
    return finish(3);
  }
  if (!session) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: `fake-claude scenario: no session matches task ${taskOf(text) ?? "(none)"}` });
    return finish(1);
  }

  const now = () => Math.floor(Date.now() / 1000);
  const rl = (o) => {
    const status = o.status ?? "allowed";
    const at = o.resetsAt ?? now() + (o.resetsInSec ?? 5 * 3600);
    const u = o.utilization ?? (status === "rejected" ? 1 : 0.1);
    out({ type: "rate_limit_event", rate_limit_info: { status, resetsAt: at, rateLimitType: o.type ?? "five_hour", overageStatus: "rejected", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: u, resetsAt: at }, seven_day: { utilization: 0.2, resetsAt: at + 86400 } } } });
    if (status === "rejected" && o.message !== false) out({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your session limit · resets soon" }] } });
  };
  const target = (p, escape) => {
    if (typeof p !== "string" || p === "" || p.includes("${")) throw new Error(`scenario path not usable: ${String(p)}`);
    const abs = resolve(cwd, p);
    const rel = relative(cwd, abs);
    const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    const inGit = rel === ".git" || rel.startsWith(`.git${sep}`);
    if ((isAbsolute(p) || !inside || inGit) && escape !== true) throw new Error(`scenario path leaves the workspace without "escape": ${p}`);
    return abs;
  };
  let n = 0;
  const tool = (name, input, run) => {
    const id = `toolu_s${++n}`;
    out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    let isError = false;
    let content;
    try { content = run(); } catch (e) { isError = true; content = String(e?.message ?? e); }
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }] } });
  };
  const write = (abs, content) => { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); return "File created successfully"; };

  if (session.rateLimitAtStart !== false) rl({ status: "allowed", utilization: 0.1 });
  let resulted = false;
  for (const st of session.steps ?? []) {
    if ("write" in st) {
      const abs = target(st.write, st.escape);
      const content = st.content ?? (Array.isArray(st.lines) ? `${st.lines.join("\n")}\n` : "");
      tool("Write", { file_path: abs, content }, () => write(abs, content));
    } else if ("edit" in st) {
      const abs = target(st.edit, st.escape);
      tool("Edit", { file_path: abs, old_string: st.old, new_string: st.new }, () => {
        const before = readFileSync(abs, "utf8");
        if (!before.includes(st.old)) throw new Error("String to replace not found in file.");
        writeFileSync(abs, before.replace(st.old, st.new));
        return "The file has been updated.";
      });
    } else if ("delete" in st) {
      const abs = target(st.delete, st.escape);
      tool("Bash", { command: `rm ${st.delete}` }, () => { rmSync(abs, { force: true }); return ""; });
    } else if ("notes" in st) {
      const task = st.task ?? session.task ?? taskOf(text);
      if (!TASK_ID.test(task ?? "")) throw new Error("notes step needs a task id");
      const abs = join(cwd, ".jarvis", "notes", `${task}.md`);
      tool("Write", { file_path: abs, content: st.notes }, () => write(abs, st.notes.endsWith("\n") ? st.notes : `${st.notes}\n`));
    } else if ("bash" in st) {
      const id = `toolu_s${++n}`;
      out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: st.bash } }] } });
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: st.isError === true, content: st.output ?? "" }] } });
    } else if ("exec" in st) {
      tool("Bash", { command: st.exec }, () => {
        const r = spawnSync("/bin/sh", ["-c", st.exec], { cwd, env: process.env, encoding: "utf8", timeout: st.timeoutMs ?? 60_000 });
        const text = `${r.stdout ?? ""}${r.stderr ?? ""}EXIT:${r.status ?? r.signal}\n`;
        if (st.saveAs !== undefined) write(target(st.saveAs, st.escape), text);
        return text;
      });
    } else if ("text" in st) {
      out({ type: "assistant", message: { content: [{ type: "text", text: st.text }] } });
    } else if ("event" in st) {
      out(st.event);
      if (st.event?.type === "result") resulted = true;
    } else if ("rateLimit" in st) {
      rl(st.rateLimit);
    } else if ("sleepMs" in st) {
      await sleep(st.sleepMs);
    } else if ("result" in st) {
      const r = st.result ?? {};
      out({ type: "result", subtype: r.subtype ?? "success", is_error: r.is_error ?? false, num_turns: r.num_turns ?? n + 1, result: r.text ?? "" });
      resulted = true;
    } else if ("exit" in st) {
      return finish(st.exit);
    } else if ("hang" in st) {
      setInterval(() => {}, 1 << 30);
      await new Promise(() => {});
    } else {
      throw new Error(`unknown scenario step: ${JSON.stringify(st)}`);
    }
  }
  if (!resulted) out({ type: "result", subtype: "success", is_error: false, num_turns: n + 1, result: "Done." });
  return finish(0);
}
