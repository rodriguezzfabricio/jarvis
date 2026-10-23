import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { safeGit } from "../eval/git.ts";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import { runSandboxed } from "../sandbox/srt.ts";
import type { ChecksStore } from "./store.ts";

/**
 * Gates (decisions 16, 49, 76): only the runner makes evidence. A protected check runs after the session
 * has ended, on a fresh checkout of the committed revision, inside the sandbox runtime, with its raw
 * output captured straight from the process and hashed into a ledger gate_result entry.
 *
 * A check has two phases, each in its own sandbox (decision 76, Codex stage 0 review 6). `command` runs
 * the candidate (it may import, start or drive it) and writes what it observed to $JARVIS_OUT. `verify`
 * holds the assertions and runs no candidate code: it can read only the protected checks and
 * $JARVIS_OUT, not the checkout, and it proves it ran to the end by printing, as its last line,
 * `JARVIS-CHECK-COMPLETE <nonce>` with the nonce from $JARVIS_COMPLETION_FILE, which is created only
 * after the first phase has ended and is unreadable from its sandbox. So candidate code that exits 0
 * early, or forges output, can't produce a pass: a pass needs both phases to exit 0 and the completion line.
 */

export interface GateCheck {
  name: string;
  /** Phase 1, shell: runs the candidate and writes observations to $JARVIS_OUT. $JARVIS_CHECKS is read-only. */
  command: string;
  /** Phase 2, shell: the assertions, over $JARVIS_OUT only; must finish with the completion line. */
  verify: string;
  /** Per phase. */
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
}

export type GateStatus = "pass" | "fail" | "tampered" | "error";
export interface GateResult {
  status: GateStatus;
  entry: LedgerEntry;
  evidenceDir: string;
}

export const COMPLETION_PREFIX = "JARVIS-CHECK-COMPLETE";
/** Observations copied into the evidence are capped (per gate). */
const MAX_OUT_BYTES = 16 * 1024 * 1024;

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** True if the last non-empty line of the verify phase's stdout is exactly the completion line. */
export function completed(stdout: string, nonce: string): boolean {
  const last = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1);
  return last === `${COMPLETION_PREFIX} ${nonce}`;
}

export async function runGate(g: GateInput): Promise<GateResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceDir = join(g.projectDir, "evidence", `${g.attemptId}-${g.check.name}-${stamp}`);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const base = { check: g.check.name, revision: g.revision, command: g.check.command, verify: g.check.verify };
  const record = (status: GateStatus, data: Record<string, unknown>) =>
    g.ledger.append({ kind: "gate_result", actor: "runner", task_id: g.taskId, attempt_id: g.attemptId, data: { ...base, status, ...data } });

  const v = g.store.verify(g.ledger);
  if (!v.ok) return { status: "tampered", entry: record("tampered", { problems: v.problems }), evidenceDir };
  if (typeof g.check.verify !== "string" || g.check.verify.trim() === "") return { status: "error", entry: record("error", { problems: ["a check needs a verify phase (decision 76)"] }), evidenceDir };

  const gateDir = join(g.workRoot, "checks", `${g.attemptId}-${g.check.name}-${stamp}`);
  const runDir = join(gateDir, "run");
  const checkout = join(runDir, "checkout");
  const home = join(runDir, "home");
  const cache = join(runDir, "cache");
  const outDir = join(gateDir, "out");
  const verifyDir = join(gateDir, "verify");
  const verifyHome = join(verifyDir, "home");
  for (const d of [home, cache, outDir, join(verifyDir, "obs"), verifyHome]) mkdirSync(d, { recursive: true, mode: 0o700 });
  try {
    // A fresh clone of the committed objects: no working-tree edits, no hooks, no repo config.
    // --no-local goes through the pack transport, where index-pack recomputes every object's hash,
    // so an agent can't swap a loose object's contents under its old name (Codex stage 0 review 5).
    // No separate fsck afterwards: index-pack already checked everything it would (decision 75).
    safeGit(runDir, ["-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true", "clone", "--quiet", "--no-local", "--no-checkout", g.repoPath, checkout], { home: homedir() });
    safeGit(checkout, ["checkout", "--quiet", "--detach", g.revision], { home: homedir() });
    const head = safeGit(checkout, ["rev-parse", "HEAD"], { home: homedir() }).toString().trim();
    if (head !== g.revision) return { status: "error", entry: record("error", { problems: [`checkout is at ${head}`] }), evidenceDir };

    const real = (p: string) => realpathSync(p);
    const commonEnv = { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CI: "1", JARVIS_CHECKS: real(g.store.checksDir) };

    // Phase 1: the candidate. It can't see the verify folder (where the nonce will be).
    const run = await runSandboxed({
      policy: {
        denyRead: [real(g.jarvisHome), real(homedir()), real(verifyDir)],
        allowRead: [real(runDir), real(outDir), real(g.store.checksDir)],
        allowWrite: [real(checkout), real(home), real(cache), real(outDir)],
        allowLocalBinding: g.check.allowLocalBinding === true,
      },
      command: g.check.command,
      cwd: real(checkout),
      env: { ...commonEnv, JARVIS_OUT: real(outDir), HOME: real(home), TMPDIR: real(home), GOMODCACHE: join(real(cache), "go-mod"), GOCACHE: join(real(cache), "go-build"), npm_config_cache: join(real(cache), "npm"), ...(g.extraEnv ?? {}) },
      timeoutMs: g.check.timeoutMs,
      stdoutPath: join(evidenceDir, "stdout.log"),
      stderrPath: join(evidenceDir, "stderr.log"),
      killGraceMs: 5_000,
    });
    const runOk = !run.timedOut && run.code === 0;

    // Phase 2: the assertions. No candidate code and no checkout: only the checks and a copy of the
    // observations (regular files only), made after phase 1 ended, where nothing from phase 1 can write.
    const obsDir = join(verifyDir, "obs");
    const copied = copyObservations(outDir, obsDir);
    const nonce = randomBytes(24).toString("hex");
    const completionFile = join(verifyDir, "completion");
    writeFileSync(completionFile, nonce, { mode: 0o600 });
    const verifyStdout = join(evidenceDir, "verify-stdout.log");
    const ver = await runSandboxed({
      policy: {
        denyRead: [real(g.jarvisHome), real(homedir()), real(runDir), real(outDir)],
        allowRead: [real(verifyDir), real(g.store.checksDir)],
        allowWrite: [real(verifyHome)],
      },
      command: g.check.verify,
      cwd: real(obsDir),
      env: { ...commonEnv, JARVIS_OUT: real(obsDir), HOME: real(verifyHome), TMPDIR: real(verifyHome), JARVIS_COMPLETION_FILE: real(completionFile), ...(g.extraEnv ?? {}) },
      timeoutMs: g.check.timeoutMs,
      stdoutPath: verifyStdout,
      stderrPath: join(evidenceDir, "verify-stderr.log"),
      killGraceMs: 5_000,
    });
    const verifyOk = !ver.timedOut && ver.code === 0;
    const complete = completed(readFileSync(verifyStdout, "utf8"), nonce);
    // Pass only if the candidate phase exited 0 on its own, every observation was judged, and the
    // assertions exited 0 and ran to the end.
    const status: GateStatus = runOk && !copied.truncated && verifyOk && complete ? "pass" : "fail";

    const files: Record<string, string> = {};
    for (const f of ["stdout.log", "stderr.log", "verify-stdout.log", "verify-stderr.log"]) files[f] = sha(join(evidenceDir, f));
    for (const rel of Object.keys(copied.files)) {
      mkdirSync(dirname(join(evidenceDir, "out", rel)), { recursive: true, mode: 0o700 });
      copyFileSync(join(obsDir, rel), join(evidenceDir, "out", rel));
      files[`out/${rel}`] = sha(join(evidenceDir, "out", rel));
    }
    const entry = record(status, {
      exitCode: run.code,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      verifyExitCode: ver.code,
      verifyTimedOut: ver.timedOut,
      completed: complete,
      checksLock: v.lockHash,
      ...(copied.truncated ? { observationsTruncated: true } : {}),
      evidence: { dir: evidenceDir, files },
    });
    return { status, entry, evidenceDir };
  } catch (err) {
    return { status: "error", entry: record("error", { problems: [String(err)] }), evidenceDir };
  } finally {
    rmSync(gateDir, { recursive: true, force: true });
  }
}

/** Copies regular files from the observations folder into the evidence (no symlinks), up to a size cap. */
function copyObservations(from: string, to: string): { files: Record<string, string>; truncated: boolean } {
  const files: Record<string, string> = {};
  let total = 0;
  let truncated = false;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        if (total + st.size > MAX_OUT_BYTES) {
          truncated = true;
          continue;
        }
        total += st.size;
        const rel = relative(from, p);
        mkdirSync(dirname(join(to, rel)), { recursive: true, mode: 0o700 });
        copyFileSync(p, join(to, rel));
        files[rel] = "";
      }
    }
  };
  walk(from);
  return { files, truncated };
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
