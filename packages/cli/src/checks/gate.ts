import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { safeGit } from "../eval/git.ts";
import type { Ledger, LedgerEntry } from "../ledger/ledger.ts";
import { runSandboxed } from "../sandbox/srt.ts";
import type { ChecksStore } from "./store.ts";

/**
 * Gates (decisions 16, 49): only the runner makes evidence. A protected check runs after the session
 * has ended, on a fresh checkout of the committed revision, inside the sandbox runtime, with its raw
 * output captured straight from the process and hashed into a ledger gate_result entry.
 */

export interface GateCheck {
  name: string;
  /** Shell command; $JARVIS_CHECKS points at the protected checks folder (read-only). */
  command: string;
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

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

export async function runGate(g: GateInput): Promise<GateResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceDir = join(g.projectDir, "evidence", `${g.attemptId}-${g.check.name}-${stamp}`);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const base = { check: g.check.name, revision: g.revision, command: g.check.command };
  const record = (status: GateStatus, data: Record<string, unknown>) =>
    g.ledger.append({ kind: "gate_result", actor: "runner", task_id: g.taskId, attempt_id: g.attemptId, data: { ...base, status, ...data } });

  const v = g.store.verify(g.ledger);
  if (!v.ok) return { status: "tampered", entry: record("tampered", { problems: v.problems }), evidenceDir };

  const runDir = join(g.workRoot, "checks", `${g.attemptId}-${g.check.name}-${stamp}`);
  const checkout = join(runDir, "checkout");
  const home = join(runDir, "home");
  const cache = join(runDir, "cache");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  try {
    // A fresh clone of the committed objects: no working-tree edits, no hooks, no repo config.
    // --no-local goes through the pack transport, where index-pack recomputes every object's hash,
    // so an agent can't swap a loose object's contents under its old name (Codex stage 0 review 5).
    safeGit(runDir, ["-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true", "clone", "--quiet", "--no-local", "--no-checkout", g.repoPath, checkout], { home: homedir() });
    safeGit(checkout, ["fsck", "--full", "--strict", "--no-dangling", "--no-progress"], { home: homedir() });
    safeGit(checkout, ["checkout", "--quiet", "--detach", g.revision], { home: homedir() });
    const head = safeGit(checkout, ["rev-parse", "HEAD"], { home: homedir() }).toString().trim();
    if (head !== g.revision) return { status: "error", entry: record("error", { problems: [`checkout is at ${head}`] }), evidenceDir };

    const real = (p: string) => realpathSync(p);
    const policy = {
      denyRead: [real(g.jarvisHome), real(homedir())],
      allowRead: [real(runDir), real(g.store.checksDir)],
      allowWrite: [real(checkout), real(home), real(cache)],
      allowLocalBinding: g.check.allowLocalBinding === true,
    };
    const env: Record<string, string> = {
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: real(home),
      TMPDIR: real(home),
      LANG: "en_US.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      CI: "1",
      JARVIS_CHECKS: real(g.store.checksDir),
      GOMODCACHE: join(real(cache), "go-mod"),
      GOCACHE: join(real(cache), "go-build"),
      npm_config_cache: join(real(cache), "npm"),
      ...(g.extraEnv ?? {}),
    };
    const stdoutPath = join(evidenceDir, "stdout.log");
    const stderrPath = join(evidenceDir, "stderr.log");
    const out = await runSandboxed({ policy, command: g.check.command, cwd: real(checkout), env, timeoutMs: g.check.timeoutMs, stdoutPath, stderrPath, killGraceMs: 5_000 });
    // Pass only on the sandboxed command's own exit 0: a signal (code null) or a timeout is a failure.
    const status: GateStatus = !out.timedOut && out.code === 0 ? "pass" : "fail";
    const entry = record(status, {
      exitCode: out.code,
      timedOut: out.timedOut,
      durationMs: out.durationMs,
      checksLock: v.lockHash,
      evidence: { dir: evidenceDir, files: { "stdout.log": sha(stdoutPath), "stderr.log": sha(stderrPath) } },
    });
    return { status, entry, evidenceDir };
  } catch (err) {
    return { status: "error", entry: record("error", { problems: [String(err)] }), evidenceDir };
  } finally {
    rmSync(runDir, { recursive: true, force: true });
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
