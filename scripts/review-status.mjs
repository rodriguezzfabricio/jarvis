#!/usr/bin/env node
// Diagnostic only: reads existing artifacts, never runs checks or approves stages.
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const CHECKS = ["typecheck", "unit-tests", "live-probe", "doctor-live", "mutation-check"];
const SEVERITIES = ["critical", "high", "medium", "low"];
const ROUND = /^stage\d+-\d+$/;

// Logs can be large. Only their tail is needed; verdicts/status must fit in full.
function read(path, limit = 65536, tail = false) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { text: null, error: "not a regular file" };
    if (!tail && stat.size > limit) return { text: null, error: "file exceeds read limit" };
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const start = tail ? Math.max(0, stat.size - limit) : 0;
    let n = 0;
    while (n < buffer.length) {
      const got = readSync(fd, buffer, n, buffer.length - n, start + n);
      if (!got) break;
      n += got;
    }
    return { text: stripVTControlCharacters(buffer.subarray(0, n).toString("utf8")), error: null };
  } catch (error) {
    return { text: null, error: error.code === "ENOENT" ? "missing" : "unreadable" };
  } finally { if (fd !== undefined) closeSync(fd); }
}

function names(path) {
  try { return readdirSync(path, { withFileTypes: true }); }
  catch { return null; }
}

function footer(log) {
  if (log.text === null) return null;
  const match = /(?:^|\n)exit (\d+)\s*$/.exec(log.text);
  return match ? Number(match[1]) : null;
}

function validVerdict(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !["verdict", "summary", "findings", "remaining_for_stage0"].includes(key))) return false;
  if (!["PASS", "FAIL"].includes(value.verdict) || typeof value.summary !== "string") return false;
  if (!Array.isArray(value.remaining_for_stage0) || !value.remaining_for_stage0.every((x) => typeof x === "string")) return false;
  return Array.isArray(value.findings) && value.findings.every((finding) =>
    finding && Object.keys(finding).every((key) => ["severity", "title", "file", "line", "scenario", "fix"].includes(key)) &&
    SEVERITIES.includes(finding.severity) && Number.isInteger(finding.line) &&
    ["title", "file", "scenario", "fix"].every((key) => typeof finding[key] === "string"));
}

function inspectRound(root, name) {
  const path = join(root, name);
  const files = names(path)?.map((entry) => entry.name) ?? [];
  const statusFile = read(join(path, "status"));
  const status = statusFile.text?.trim() ?? "";
  const parallel = /^stage0-(\d+)$/.test(name) && Number(name.split("-")[1]) >= 16 ||
    files.some((file) => /^(?:prompt|verdict)-[A-D]\./.test(file)) || /^lane /m.test(status);
  const ids = parallel ? ["A", "B", "C", "D"] : ["single"];
  const exits = new Map();
  const problems = [];
  let completed = false;
  let evidenceReady = false;
  for (const line of status.split("\n").filter(Boolean)) {
    if (completed) { problems.push("Status marker after review completion"); continue; }
    if (line === "evidence-done") {
      if (evidenceReady) problems.push("Duplicate evidence completion marker");
      evidenceReady = true;
      continue;
    }
    if (parallel && line === "codex-done") { completed = true; evidenceReady = true; continue; }
    const lane = parallel ? /^lane ([A-D]) exit (\d+)$/.exec(line) : /^codex-done-(\d+)$/.exec(line);
    if (!lane) { problems.push("Unrecognized status marker"); continue; }
    const id = parallel ? lane[1] : "single";
    const code = Number(parallel ? lane[2] : lane[1]);
    if (parallel && !evidenceReady) problems.push("Lane completion before evidence completion");
    if (exits.has(id)) problems.push(`Duplicate completion marker for ${id}`);
    exits.set(id, code);
    evidenceReady = true;
    if (!parallel) completed = true;
  }
  if (statusFile.error && statusFile.error !== "missing") problems.push(`Status ${statusFile.error}`);

  const workspaceFile = read(join(path, "workspace.txt"));
  const candidate = workspaceFile.text?.trim();
  const workspace = candidate && isAbsolute(candidate) && !/[\r\n]/.test(candidate) ? candidate : null;
  if (candidate && !workspace) problems.push("Invalid workspace pointer");
  if (completed && !workspace) problems.push("Missing workspace pointer after review completion");
  const requireEvidence = evidenceReady && (workspace !== null || completed);
  const evidenceDir = workspace ? join(workspace, ".review-evidence") : null;
  const readme = evidenceDir ? read(join(evidenceDir, "README.txt")) : { text: null };
  const documented = /(?:^|\n)revision ([a-f0-9]{40}|[a-f0-9]{64})(?:\r?\n|$)/.exec(readme.text ?? "")?.[1] ?? null;
  const inferred = workspace ? /-([a-f0-9]{40}|[a-f0-9]{64})$/.exec(basename(workspace))?.[1] ?? null : null;
  const revision = documented ?? inferred;
  if (documented && inferred && documented !== inferred) problems.push("Workspace and README revisions disagree");
  if (requireEvidence && !revision) problems.push("Missing revision identity");

  const logs = new Map();
  const evidence = CHECKS.map((name) => {
    const log = evidenceDir ? read(join(evidenceDir, `${name}.log`), 131072, true) : { text: null, error: "missing workspace" };
    logs.set(name, log);
    const exitCode = footer(log);
    if (exitCode !== null && exitCode !== 0) problems.push(`${name} exited ${exitCode}`);
    if (requireEvidence && exitCode === null) problems.push(`${name} lacks a completed exit footer`);
    return { name, exitCode, state: exitCode === 0 ? "passed" : exitCode !== null ? "failed" : "pending", detail: log.error ?? null };
  });
  const installLog = evidenceDir ? read(join(evidenceDir, "install.log"), 131072, true) : { text: null, error: "missing workspace" };
  const installExit = footer(installLog);
  if (installExit !== null && installExit !== 0) problems.push(`install exited ${installExit}`);
  const install = { exitCode: installExit, detail: installLog.error ?? "informational; historical runners omit an install exit footer" };
  const mutationText = logs.get("mutation-check").text ?? "";
  const caught = [...mutationText.matchAll(/^all (\d+) mutations caught\s*$/gm)].at(-1);
  const missed = [...mutationText.matchAll(/^(\d+) (?:mutation\(s\)|mutations?) not caught\s*$/gm)].at(-1);
  const mutations = { caught: caught ? Number(caught[1]) : null, notCaught: missed ? Number(missed[1]) : caught ? 0 : null };
  if (mutations.notCaught > 0) problems.push(`${mutations.notCaught} mutations not caught`);
  if (requireEvidence && !(mutations.caught > 0)) problems.push("Missing positive mutation completion summary");

  const lanes = ids.map((id) => {
    const exitCode = exits.get(id) ?? null;
    const raw = read(join(path, id === "single" ? "verdict.json" : `verdict-${id}.json`), 2 * 1024 * 1024);
    let value;
    try { value = JSON.parse(raw.text ?? ""); } catch { /* Mid-write is pending until the lane completes. */ }
    const valid = validVerdict(value);
    const findings = Object.fromEntries(SEVERITIES.map((severity) => [severity, valid ? value.findings.filter((f) => f.severity === severity).length : 0]));
    const terminal = completed || exitCode !== null;
    let state = "pending";
    if (terminal) {
      if (exitCode === null) problems.push(`Lane ${id} lacks a completion marker`);
      else if (exitCode !== 0) problems.push(`Lane ${id} exited ${exitCode}`);
      if (!valid) problems.push(`Lane ${id} verdict ${raw.error ?? "invalid"}`);
      if (valid && (value.verdict === "FAIL" || findings.critical > 0 || findings.high > 0)) problems.push(`Lane ${id} reports a blocking result`);
      state = exitCode === 0 && valid && value.verdict === "PASS" && findings.critical === 0 && findings.high === 0 ? "finished" : "failed";
    }
    return { id, state, exitCode, verdict: valid ? value.verdict : null, findings, detail: valid ? null : raw.error ?? "invalid or partial JSON" };
  });
  const finished = completed && lanes.every((lane) => lane.state === "finished") && evidence.every((log) => log.exitCode === 0);
  const state = problems.length ? "failed" : finished ? "finished" : evidenceReady ? "reviewing" : workspace || status ? "capturing evidence" : "queued";
  return { name, advisory: true, state, result: state === "failed" ? "FAIL" : state === "finished" ? "PASS" : "PENDING", revision, workspace, evidence, install, mutations, lanes, problems };
}

export function inspectReviews(root = join(homedir(), ".jarvis", "codex-review")) {
  const entries = names(root);
  const rounds = (entries ?? []).filter((entry) => entry.isDirectory() && ROUND.test(entry.name))
    .map((entry) => entry.name).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((name) => inspectRound(root, name));
  return { advisory: true, root, rootReadable: entries !== null, rounds, notes: [
    "Advisory only: recorded artifacts do not grant stage approval or prove current process liveness.",
    "Queued means no progress marker is visible. Historical runners write workspace.txt only after evidence collection.",
    ...(entries ? [] : ["Review root is missing or unreadable."]),
  ] };
}

function printHuman(report) {
  console.log("Advisory review status — no stage approval or process-liveness claim\n");
  console.log("Round | State | Result | Revision | Lanes");
  for (const round of report.rounds) {
    console.log(`${round.name} | ${round.state} | ${round.result} | ${round.revision?.slice(0, 12) ?? "unknown"} | ${round.lanes.map((lane) => `${lane.id}:${lane.state}/${lane.verdict ?? "?"} C${lane.findings.critical} H${lane.findings.high} M${lane.findings.medium} L${lane.findings.low}`).join(" ")}`);
    console.log(`  Evidence: ${round.evidence.map((log) => `${log.name}=${log.exitCode ?? "pending"}`).join(", ")}; mutations=${round.mutations.caught ?? "?"} caught/${round.mutations.notCaught ?? "?"} not caught`);
    for (const problem of round.problems) console.log(`  ${problem}`);
  }
  if (!report.rounds.length) console.log("No review rounds found.");
  console.log(`\n${report.notes.join("\n")}`);
}

function isMain() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const help = args.includes("--help") || args.includes("-h");
  if (positional.length > 1 || args.some((arg) => arg.startsWith("-") && !["--json", "--help", "-h"].includes(arg)) || (help && args.length !== 1)) {
    console.error("Usage: node scripts/review-status.mjs [review-root] [--json]");
    process.exitCode = 1;
  } else if (help) {
    console.log("Usage: node scripts/review-status.mjs [review-root] [--json]\nDefault root: ~/.jarvis/codex-review\nExit 0: all recorded rounds pass; 1: a failed round, invalid arguments, or missing/unreadable explicit root; 2: incomplete or absent rounds. Advisory only.");
  } else {
    const report = inspectReviews(positional[0] ? resolve(positional[0]) : undefined);
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    process.exitCode = (positional.length && !report.rootReadable) || report.rounds.some((round) => round.result === "FAIL") ? 1 : report.rounds.length && report.rounds.every((round) => round.result === "PASS") ? 0 : 2;
  }
}
