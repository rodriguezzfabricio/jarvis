import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { safeGit } from "../eval/git.ts";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import { runSandboxed, type SandboxedRun } from "../sandbox/srt.ts";
import { tempRoots } from "../sandbox/temp.ts";
import type { ChecksStore } from "./store.ts";

/**
 * Gates (decisions 16, 49, 76): only the runner makes evidence. A protected check runs after the session
 * has ended, on a fresh checkout of the committed revision, inside the sandbox runtime, with its raw
 * output captured straight from the process and hashed into a ledger gate_result entry.
 *
 * The runner is the driver (decision 76, after Codex stage 0 reviews 6 and 7). A check lists cases; the
 * runner runs each case's command in the candidate sandbox and records that process's own stdout,
 * stderr and exit code in a folder no sandbox can write. Nothing the candidate writes is treated as an
 * observation: its only channel is its own output, and producing the expected output for inputs it
 * didn't choose is what passing means. The expectations live in `verify`, which the candidate sandbox
 * can't read. `verify` runs in its own sandbox with no candidate code and no checkout, reads a copy of
 * the recorded observations, and proves it ran to the end by printing, as its last line,
 * `JARVIS-CHECK-COMPLETE <nonce>`, with the nonce from $JARVIS_COMPLETION_FILE, which is created only
 * after every case has ended.
 */

export interface GateCase {
  /** Observations land in $JARVIS_OUT/<id>/{stdout,stderr,code}. */
  id: string;
  /** Shell, run in the candidate sandbox at the checkout. $JARVIS_FIXTURES (read-only) holds checks/fixtures. */
  command: string;
  timeoutMs?: number;
}

export interface GateCheck {
  name: string;
  cases: GateCase[];
  /** Shell: the assertions, over $JARVIS_OUT only; must finish with the completion line. $JARVIS_CHECKS is readable. */
  verify: string;
  /** Default per case, and the verify phase's limit. */
  timeoutMs: number;
  allowLocalBinding?: boolean;
}

export interface GateInput {
  ledger: Ledger;
  store: ChecksStore;
  projectDir: string;
  jarvisHome: string;
  /** Where checkouts and per-check caches go (~/.jarvis-work), outside the runner folder. */
  workRoot: string;
  /** The agent's worktree; only its committed objects are used. */
  repoPath: string;
  revision: string;
  check: GateCheck;
  taskId: string;
  attemptId: string;
  extraEnv?: Record<string, string>;
  /** Test seam: removes the run's scratch folder after the result is recorded. */
  cleanup?: (dir: string) => void;
  /** Test seam: runs one sandboxed phase (default runSandboxed), so a test can see each phase's policy. */
  sandbox?: typeof runSandboxed;
}

export type GateStatus = "pass" | "fail" | "tampered" | "error";
export interface GateResult {
  status: GateStatus;
  entry: LedgerEntry;
  evidenceDir: string;
}

export const COMPLETION_PREFIX = "JARVIS-CHECK-COMPLETE";
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Observations handed to the verify phase are capped (per gate); more fails the gate. */
const MAX_OUT_BYTES = 16 * 1024 * 1024;

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** True if the last non-empty line of the verify phase's stdout is exactly the completion line. */
export function completed(stdout: string, nonce: string): boolean {
  const last = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1);
  return last === `${COMPLETION_PREFIX} ${nonce}`;
}

function checkShape(c: GateCheck): string | undefined {
  if (typeof c.verify !== "string" || c.verify.trim() === "") return "a check needs a verify phase (decision 76)";
  if (!Array.isArray(c.cases) || c.cases.length === 0) return "a check needs at least one case (decision 76)";
  const seen = new Set<string>();
  for (const k of c.cases) {
    if (typeof k?.id !== "string" || !CASE_ID.test(k.id) || seen.has(k.id)) return `bad or repeated case id: ${String(k?.id)}`;
    if (typeof k.command !== "string" || k.command.trim() === "") return `case ${k.id} has no command`;
    seen.add(k.id);
  }
  return undefined;
}

export async function runGate(g: GateInput): Promise<GateResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceDir = join(g.projectDir, "evidence", `${g.attemptId}-${g.check.name}-${stamp}`);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const base = { check: g.check.name, revision: g.revision, cases: g.check.cases, verify: g.check.verify };
  const record = (status: GateStatus, data: Record<string, unknown>) =>
    g.ledger.append({ kind: "gate_result", actor: "runner", task_id: g.taskId, attempt_id: g.attemptId, data: { ...base, status, ...data } });

  const v = g.store.verify(g.ledger);
  if (!v.ok) return { status: "tampered", entry: record("tampered", { problems: v.problems }), evidenceDir };
  const shape = checkShape(g.check);
  if (shape) return { status: "error", entry: record("error", { problems: [shape] }), evidenceDir };

  return execute(g, evidenceDir, `${g.attemptId}-${g.check.name}-${stamp}`, v.lockHash, (runDir, checkout) => {
    // A fresh clone of the committed objects: no working-tree edits, no hooks, no repo config.
    // --no-local goes through the pack transport, where index-pack recomputes every object's hash,
    // so an agent can't swap a loose object's contents under its old name (Codex stage 0 review 5).
    // No separate fsck afterwards: index-pack already checked everything it would (decision 75).
    safeGit(runDir, ["-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true", "clone", "--quiet", "--no-local", "--no-checkout", g.repoPath, checkout], { home: homedir() });
    safeGit(checkout, ["checkout", "--quiet", "--detach", g.revision], { home: homedir() });
    const head = safeGit(checkout, ["rev-parse", "HEAD"], { home: homedir() }).toString().trim();
    return head === g.revision ? undefined : `checkout is at ${head}`;
  }, (outcome) => ({ status: outcome.status, entry: record(outcome.status, outcome.data), evidenceDir }));
}

/** What running a check needs, whoever keeps the result: the runner records it, feedback doesn't. */
interface RunInput {
  store: ChecksStore;
  jarvisHome: string;
  workRoot: string;
  check: GateCheck;
  extraEnv?: Record<string, string>;
  cleanup?: (dir: string) => void;
  sandbox?: (r: SandboxedRun) => ReturnType<typeof runSandboxed>;
}
interface Outcome { status: GateStatus; data: Record<string, unknown> }

/**
 * Runs the cases and the verify phase on a checkout `prepare` fills (a returned problem stops with error).
 * `settle` keeps the outcome before the scratch folder is removed, so a cleanup fault never loses a
 * recorded result (Codex review of the commands branch, medium 4).
 */
async function execute<R>(g: RunInput, evidenceDir: string, label: string, lockHash: string | undefined, prepare: (runDir: string, checkout: string) => string | undefined, settle: (outcome: Outcome) => R): Promise<R> {
  const gateDir = join(g.workRoot, "checks", label);
  const runDir = join(gateDir, "run");
  const checkout = join(runDir, "checkout");
  const home = join(runDir, "home");
  const cache = join(runDir, "cache");
  const verifyDir = join(gateDir, "verify");
  const obsDir = join(verifyDir, "obs");
  const verifyHome = join(verifyDir, "home");
  const fixtures = join(g.store.checksDir, "fixtures");
  for (const d of [home, cache, obsDir, verifyHome]) mkdirSync(d, { recursive: true, mode: 0o700 });
  try {
    const problem = prepare(runDir, checkout);
    if (problem !== undefined) return settle({ status: "error", data: { problems: [problem] } });

    const real = (p: string) => realpathSync(p);
    const commonEnv = { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CI: "1" };
    const hasFixtures = existsSync(fixtures);
    const systemTemp = tempRoots();

    // The cases: candidate code runs here. It can read the checkout and the fixtures, not the
    // expectations (the rest of the checks folder), the verify folder or the recorded observations.
    const files: Record<string, string> = Object.create(null) as Record<string, string>;
    const caseResults: { id: string; code: number | null; timedOut: boolean; durationMs: number }[] = [];
    // The observation cap is enforced while capturing: each case gets what's left of it, and a case
    // that passes it is stopped there; no later case and no verify phase run (Codex stage 0 review 16).
    let captured = 0;
    let overCap = false;
    for (const k of g.check.cases) {
      const caseEvidence = join(evidenceDir, "cases", k.id);
      mkdirSync(caseEvidence, { recursive: true, mode: 0o700 });
      const r = await (g.sandbox ?? runSandboxed)({
        policy: {
          // Decision 95: no system temp folder either; the run folder (with its private TMPDIR) is reopened.
          denyRead: [real(g.jarvisHome), real(homedir()), real(verifyDir), ...systemTemp],
          allowRead: [real(runDir), ...(hasFixtures ? [real(fixtures)] : [])],
          allowWrite: [real(checkout), real(home), real(cache)],
          allowLocalBinding: g.check.allowLocalBinding === true,
        },
        command: k.command,
        cwd: real(checkout),
        env: { ...commonEnv, ...(hasFixtures ? { JARVIS_FIXTURES: real(fixtures) } : {}), HOME: real(home), TMPDIR: real(home), GOMODCACHE: join(real(cache), "go-mod"), GOCACHE: join(real(cache), "go-build"), npm_config_cache: join(real(cache), "npm"), ...(g.extraEnv ?? {}) },
        timeoutMs: k.timeoutMs ?? g.check.timeoutMs,
        stdoutPath: join(caseEvidence, "stdout"),
        stderrPath: join(caseEvidence, "stderr"),
        killGraceMs: 5_000,
        maxOutputBytes: MAX_OUT_BYTES - captured,
      });
      captured += lstatSync(join(caseEvidence, "stdout")).size + lstatSync(join(caseEvidence, "stderr")).size;
      overCap ||= r.overflowed;
      // Written by the runner from the process's own outcome.
      writeFileSync(join(caseEvidence, "code"), r.code === null ? "signal\n" : `${r.code}\n`);
      caseResults.push({ id: k.id, code: r.code, timedOut: r.timedOut, durationMs: r.durationMs });
      for (const f of ["stdout", "stderr", "code"]) files[`cases/${k.id}/${f}`] = sha(join(caseEvidence, f));
      if (overCap) break;
    }
    const allFinished = caseResults.length === g.check.cases.length && caseResults.every((c) => !c.timedOut);
    const withinCap = !overCap && captured <= MAX_OUT_BYTES;

    // The assertions: no candidate code and no checkout, only the checks and a copy of the observations.
    // Skipped once the cap is passed: oversized observations are never copied or judged.
    let ver: { code: number | null; timedOut: boolean } = { code: null, timedOut: false };
    let complete = false;
    if (withinCap) {
      for (const k of g.check.cases) {
        mkdirSync(join(obsDir, k.id), { recursive: true, mode: 0o700 });
        for (const f of ["stdout", "stderr", "code"]) copyFileSync(join(evidenceDir, "cases", k.id, f), join(obsDir, k.id, f));
      }
      const nonce = randomBytes(24).toString("hex");
      const completionFile = join(verifyDir, "completion");
      writeFileSync(completionFile, nonce, { mode: 0o600 });
      const verifyStdout = join(evidenceDir, "verify-stdout.log");
      ver = await (g.sandbox ?? runSandboxed)({
        policy: {
          denyRead: [real(g.jarvisHome), real(homedir()), real(runDir), ...systemTemp],
          allowRead: [real(verifyDir), real(g.store.checksDir)],
          allowWrite: [real(verifyHome)],
        },
        command: g.check.verify,
        cwd: real(obsDir),
        env: { ...commonEnv, JARVIS_CHECKS: real(g.store.checksDir), JARVIS_OUT: real(obsDir), HOME: real(verifyHome), TMPDIR: real(verifyHome), JARVIS_COMPLETION_FILE: real(completionFile), ...(g.extraEnv ?? {}) },
        timeoutMs: g.check.timeoutMs,
        stdoutPath: verifyStdout,
        stderrPath: join(evidenceDir, "verify-stderr.log"),
        killGraceMs: 5_000,
      });
      complete = completed(readFileSync(verifyStdout, "utf8"), nonce);
      for (const f of ["verify-stdout.log", "verify-stderr.log"]) files[f] = sha(join(evidenceDir, f));
    }
    const verifyOk = !ver.timedOut && ver.code === 0;
    // Pass only if every case finished, every observation was judged, and the assertions exited 0
    // and ran to the end.
    const status: GateStatus = allFinished && withinCap && verifyOk && complete ? "pass" : "fail";
    return settle({ status, data: {
      caseResults,
      verifyExitCode: ver.code,
      verifyTimedOut: ver.timedOut,
      completed: complete,
      ...(withinCap ? {} : { observationsOverCap: true }),
      checksLock: lockHash,
      evidence: { dir: evidenceDir, files: { ...files } },
    } });
  } catch (err) {
    return settle({ status: "error", data: { problems: [String(err)] } });
  } finally {
    // The result is already settled: a folder that won't go away is left for the run's cleanup sweep,
    // never turned into an exception a candidate could choose (golden-task run, read-only Go module trees).
    try { (g.cleanup ?? removeRunDir)(gateDir); } catch { /* left behind; the recorded result stands */ }
  }
}

/** `chmod -R u+rwx` over directories only, opened without following links, so no link leads out of the run. */
function makeRemovable(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, (fstatSync(fd).mode & 0o7777) | 0o700); } finally { closeSync(fd); }
  for (const name of readdirSync(path)) makeRemovable(join(path, name));
}

/** Removes a run folder candidate code may have left read-only. */
export function removeRunDir(dir: string): void {
  makeRemovable(dir);
  rmSync(dir, { recursive: true, force: true });
}

export interface FeedbackInput extends RunInput {
  /** Verified ledger entries, read without a writer. Feedback is never given a ledger to append to. */
  entries: readonly LedgerEntry[];
  /** The working tree to judge: edits and untracked files count; ignored files, .git and .jarvis don't. */
  workTree: string;
  /** Test seam: runs between staging the working tree and materializing the staged tree. */
  afterStage?: () => void;
}
export interface FeedbackCase { id: string; code: number | null; timedOut: boolean; stdoutTail: string; stderrTail: string }
export interface FeedbackResult { check: string; status: GateStatus; problems: string[]; cases: FeedbackCase[] }
const TAIL_BYTES = 2000;

function tailOf(path: string): string {
  if (!existsSync(path)) return "";
  const bytes = readFileSync(path);
  // Candidate output reaches a terminal: no control characters besides newlines and tabs.
  return bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)).toString("utf8").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "?");
}

/** Lexically inside the tree and never into .git: relative links only, as for the runner's candidates. */
function linkStaysInside(path: string, link: string): boolean {
  if (link === "" || link.startsWith("/") || link.includes("\0")) return false;
  const target = posix.normalize(posix.join(posix.dirname(path), link));
  return target !== ".." && !target.startsWith("../") && !/^\.git(?:\/|$)/i.test(target);
}

/**
 * Stages what `git add --all` would take (tracked and untracked, not ignored, never .jarvis) into a
 * runner-private index and object store, checks the tree, then checks it out into the copy. Nothing
 * reads the live tree after staging, and git refuses paths beyond a symlink while staging, so swapping
 * a parent for a symlink can't put outside files in the copy (Codex review of the commands branch, high 1).
 */
function copyWorkTree(workTree: string, checkout: string, stage: string, afterStage?: () => void): void {
  const objects = join(stage, "objects");
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  const env = { GIT_INDEX_FILE: join(stage, "index"), GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "", GIT_NO_REPLACE_OBJECTS: "1" };
  const git = (args: readonly string[], extra: Record<string, string> = {}, input?: Buffer) =>
    safeGit(workTree, args, { home: homedir(), env: { ...env, ...extra }, ...(input ? { input } : {}) }).toString();
  const runnerPath = (p: string) => /^\.jarvis$/i.test(p.split("/")[0]!);
  // Tracked paths come from the project's own index, so a tracked file .gitignore matches still counts.
  const tracked = safeGit(workTree, ["ls-files", "-z", "--cached"], { home: homedir() }).toString().split("\0")
    .filter((p) => p !== "" && !runnerPath(p) && lstatSync(join(workTree, p), { throwIfNoEntry: false }) !== undefined);
  const untracked = git(["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter((p) => p !== "" && !runnerPath(p));
  for (const p of [...tracked, ...untracked]) {
    const st = lstatSync(join(workTree, p), { throwIfNoEntry: false });
    if (st?.isFile() && st.nlink !== 1) throw new Error(`working tree file is hard-linked: ${p}`);
  }
  if (tracked.length) git(["add", "--all", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], { GIT_LITERAL_PATHSPECS: "1" }, Buffer.from(tracked.join("\0")));
  git(["add", "--all", "--", ".", ":(exclude,icase).jarvis"]);
  const tree = git(["write-tree"]).trim();
  for (const entry of git(["ls-tree", "-r", "-z", "--full-tree", tree]).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, , oid] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (path.split("/").some((part) => /^\.git[. ]*$/i.test(part) || /^git~[0-9]+$/i.test(part)) || runnerPath(path)) throw new Error(`working tree touches git or runner internals: ${path}`);
    if (mode === "160000") throw new Error(`nested repositories are not supported: ${path}`);
    if (mode === "120000" && !linkStaysInside(path, git(["cat-file", "blob", oid!]))) throw new Error(`symlink leaves the working tree: ${path}`);
  }
  afterStage?.();
  git(["checkout-index", "--all", `--prefix=${checkout}/`]);
}

/**
 * Decision 49: a gate run from inside a session is feedback only. The same cases and verify phase run
 * on a copy of the working tree; nothing is recorded and nothing is kept. The observations live in a
 * scratch folder that is removed before this returns. Only the cases' own output is shown: the verify
 * phase's output can carry the expectations (decision 76).
 */
export async function runFeedbackGate(f: FeedbackInput): Promise<FeedbackResult> {
  const checked = f.store.verify({ entries: () => [...f.entries] });
  if (!checked.ok) return { check: f.check.name, status: "tampered", problems: checked.problems, cases: [] };
  const shape = checkShape(f.check);
  if (shape) return { check: f.check.name, status: "error", problems: [shape], cases: [] };
  const label = `feedback-${f.check.name}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const scratch = join(f.workRoot, "feedback", label);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  try {
    const outcome = await execute(f, scratch, label, checked.lockHash, (runDir, checkout) => { copyWorkTree(f.workTree, checkout, join(dirname(runDir), "stage"), f.afterStage); return undefined; }, (o) => o);
    const results = (outcome.data.caseResults ?? []) as { id: string; code: number | null; timedOut: boolean }[];
    const tail = (id: string, name: string) => tailOf(join(scratch, "cases", id, name));
    return {
      check: f.check.name, status: outcome.status, problems: (outcome.data.problems ?? []) as string[],
      cases: results.map((c) => ({ id: c.id, code: c.code, timedOut: c.timedOut, stdoutTail: tail(c.id, "stdout"), stderrTail: tail(c.id, "stderr") })),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Re-hashes a gate_result's evidence files; any edit after the run shows up here. */
export function verifyEvidence(entry: LedgerEntry): { ok: boolean; problems: string[] } {
  const d = entry.data as { evidence?: { dir: string; files: Record<string, string> } };
  if (!d.evidence) return { ok: false, problems: ["no evidence recorded"] };
  const problems: string[] = [];
  for (const [f, h] of Object.entries(d.evidence.files)) {
    const p = join(d.evidence.dir, f);
    if (!existsSync(p)) problems.push(`${f} missing`);
    else if (sha(p) !== h) problems.push(`${f} changed after the run`);
  }
  return { ok: problems.length === 0, problems };
}
