import { createHash } from "node:crypto";
import { constants, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { runGate, type GateCheck, type GateInput, type GateResult, type GateStatus } from "../checks/gate.ts";
import { ChecksStore } from "../checks/store.ts";
import { Ledger } from "../ledger/ledger.ts";

/**
 * Hidden checks for golden tasks (02-golden-tasks.md, "How every task runs", step 2). They live in the
 * private evals repo, never in a snapshot:
 *
 *   hidden/<task>/checks/   the golden task's own success criteria, in the runner's protected-check format
 *                           (decision 76): <name>.check.json files, plus fixtures/, expected/ and verify
 *                           scripts. The runner applies them to each run's final revision, for both arms.
 *   hidden/<task>/gate/     the protected checks the Jarvis loop gates on: the project's own suite
 *                           (decision 97). Required by the Jarvis arm; it shares no file with checks/.
 *
 * Sessions never see either folder: they are copied into a runner-owned project folder under ~/.jarvis,
 * which task settings deny, and the evals repo is outside every working directory (decision 69).
 */

const checkName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const CheckFile = z.object({
  name: checkName,
  criteria: z.array(z.string().regex(/^AC[1-9]\d*$/)).default([]),
  cases: z.array(z.object({ id: z.string().min(1), command: z.string().min(1), timeoutMs: z.number().int().positive().optional() }).strict()).min(1),
  verify: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  allowLocalBinding: z.boolean().optional(),
}).strict();

export interface HiddenChecks {
  /** Real path of the folder the checks were read from. */
  dir: string;
  checks: Record<string, GateCheck>;
  /** Spec criterion ids each check covers (empty for a project test suite such as `unit`). */
  criteria: Record<string, string[]>;
}

export function hiddenDir(evalsRepo: string, taskId: string, kind: "checks" | "gate" = "checks"): string {
  return join(evalsRepo, "hidden", taskId, kind);
}

/** Relative paths of every file below root; symlinks are refused, so nothing outside the folder is copied. */
function files(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`hidden checks may not contain symlinks: ${relative(root, p)}`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(root, p));
    }
  };
  walk(root);
  return out;
}

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const f of files(root)) out[f] = sha(readFileSync(join(root, f)));
  return out;
}

export function loadHiddenChecks(dir: string): HiddenChecks {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new Error(`no hidden checks at ${dir} (the evals repo's hidden/<task>/checks/, decision 76 format)`);
  const real = realpathSync(dir);
  files(real);
  const checks: Record<string, GateCheck> = Object.create(null) as Record<string, GateCheck>;
  const criteria: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const f of readdirSync(real).filter((n) => n.endsWith(".check.json")).sort()) {
    const parsed = CheckFile.safeParse(JSON.parse(readFileSync(join(real, f), "utf8")));
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const c = parsed.data;
    if (`${c.name}.check.json` !== f) throw new Error(`${f}: name must match the file name`);
    const cases = c.cases.map((k) => ({ id: k.id, command: k.command, ...(k.timeoutMs !== undefined ? { timeoutMs: k.timeoutMs } : {}) }));
    checks[c.name] = { name: c.name, cases, verify: c.verify, timeoutMs: c.timeoutMs, ...(c.allowLocalBinding !== undefined ? { allowLocalBinding: c.allowLocalBinding } : {}) };
    criteria[c.name] = c.criteria;
  }
  if (!Object.keys(checks).length) throw new Error(`${dir}: no <name>.check.json files`);
  return { dir: real, checks, criteria };
}

/**
 * Copies hidden checks into a fresh runner-owned project folder and approves them (checks.lock plus a
 * checks_approved ledger entry), so every gate re-verifies their hashes before it runs (decision 15).
 */
export function installHiddenChecks(projectDir: string, ledger: Ledger, hidden: HiddenChecks, reason: string): ChecksStore {
  const store = new ChecksStore(projectDir);
  if (existsSync(store.checksDir)) throw new Error(`checks folder must be fresh: ${store.checksDir}`);
  const source = hashTree(hidden.dir);
  cpSync(hidden.dir, store.checksDir, { recursive: true, mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false });
  const copied = store.hashAll();
  const same = Object.keys(source).length === Object.keys(copied).length && Object.entries(source).every(([f, h]) => copied[f] === h);
  if (!same) throw new Error("hidden checks changed while they were being installed");
  store.approve(ledger, reason);
  return store;
}

/**
 * The identity of a grading suite: a hash over every file's path and content hash. Two grades compare
 * only when their suites match (compare.ts), so a relaxed check can't make one arm look better.
 */
export function suiteFingerprint(fileHashes: Readonly<Record<string, string>>): string {
  const lines = Object.keys(fileHashes).sort().map((f) => `${f} ${fileHashes[f]}`);
  return createHash("sha256").update(JSON.stringify(lines)).digest("hex");
}

/** The gate checks the loop sees must hold no file of the grading suite (decision 97: hidden checks only grade). */
export function assertHiddenDisjoint(gate: HiddenChecks, grading: HiddenChecks): void {
  if (gate.dir === grading.dir) throw new Error("the gate checks and the grading checks must be different folders (decision 97)");
  const graded = new Map<string, string>();
  for (const [f, h] of Object.entries(hashTree(grading.dir))) if (lstatSync(join(grading.dir, f)).size >= MIN_LEAK_BYTES) graded.set(h, f);
  const shared = Object.entries(hashTree(gate.dir)).flatMap(([f, h]) => (graded.has(h) ? [`${f} (= grading ${graded.get(h)})`] : []));
  if (shared.length) throw new Error(`refused: the gate checks hold grading files, which would reach the loop and its reviewers: ${shared.join(", ")}`);
}

/** Files shorter than this are too generic to call a leak (an empty JSON object, a one-word fixture). */
export const MIN_LEAK_BYTES = 16;

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The hidden tests must never reach a session (02-golden-tasks.md step 2). Refuses a snapshot that sits
 * inside a hidden folder or contains one, or that contains any hidden file's exact bytes (for instance a
 * source revision that already includes the fix and its tests), before any session starts.
 */
export function assertHiddenAbsent(workspace: string, hiddenDirs: readonly string[]): void {
  const ws = realpathSync(workspace);
  const byHash = new Map<string, string>();
  for (const d of hiddenDirs) {
    const real = realpathSync(d);
    if (inside(real, ws) || inside(ws, real)) throw new Error(`hidden checks and the snapshot overlap: ${real}`);
    for (const f of files(real)) {
      const buf = readFileSync(join(real, f));
      if (buf.length >= MIN_LEAK_BYTES) byHash.set(sha(buf), f);
    }
  }
  const leaks: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (dir === ws && name === ".git") continue;
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const hit = byHash.get(sha(readFileSync(p)));
        if (hit !== undefined) leaks.push(`${relative(ws, p)} (= hidden ${hit})`);
      }
    }
  };
  walk(ws);
  if (leaks.length) throw new Error(`refused: hidden check files are in the snapshot: ${leaks.join(", ")}`);
}

export interface GradeCheck { name: string; status: GateStatus }
export interface Grade {
  revision: string;
  /** suiteFingerprint of the grading suite as installed for this grade. */
  suite: string;
  gradedAt: string;
  /** Every hidden check passed on the revision. */
  pass: boolean;
  checks: GradeCheck[];
  /** The runner-owned folder with the grading ledger, checks and evidence. */
  projectDir: string;
}

export interface GradeInput {
  /** The run's results folder (~/.jarvis/evals/<task>/<run>); grade.json is written there. */
  runDir: string;
  /** The run's snapshot repo; only its committed objects are used (a fresh clone per check). */
  repoPath: string;
  revision: string;
  hidden: HiddenChecks;
  jarvisHome: string;
  workRoot: string;
  /** Test seam; production is the protected-check gate (checks/gate.ts). */
  gate?: (input: GateInput) => Promise<GateResult>;
}

/**
 * Grades a recorded run of either arm from its summary.json: the snapshot repo (`workspace`) at the
 * revision the run delivered (`finalCommit`). The baseline records its own final commit; the Jarvis arm
 * records last-green, or its base revision when nothing was accepted.
 */
export async function gradeRecordedRun(runDir: string, hidden: HiddenChecks, o: { jarvisHome: string; workRoot: string; gate?: GradeInput["gate"] }): Promise<Grade> {
  const s = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8")) as { workspace?: unknown; finalCommit?: unknown; started?: unknown };
  if (s.started !== true) throw new Error(`${runDir}: the run never started a session; nothing to grade`);
  if (typeof s.workspace !== "string" || typeof s.finalCommit !== "string") throw new Error(`${runDir}: summary.json has no workspace or finalCommit`);
  if (!existsSync(s.workspace)) throw new Error(`${runDir}: the run's workspace is gone: ${s.workspace}`);
  return gradeRun({ runDir, repoPath: s.workspace, revision: s.finalCommit, hidden, jarvisHome: o.jarvisHome, workRoot: o.workRoot, ...(o.gate ? { gate: o.gate } : {}) });
}

/** Applies the hidden checks to a run's final revision on the real gate, for either arm. */
export async function gradeRun(g: GradeInput): Promise<Grade> {
  if (!/^[0-9a-f]{40}$/.test(g.revision)) throw new Error(`grading needs a full revision, not ${g.revision}`);
  const projectDir = join(resolve(g.runDir), "grade", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  const ledger = Ledger.open(projectDir);
  const store = installHiddenChecks(projectDir, ledger, g.hidden, "golden task hidden checks (grading)");
  // What runs is what was hashed: the descriptors are parsed from the installed, locked copy, never from the
  // copy parsed before the run (the evals repo may have changed since). Each gate re-verifies the lock.
  const installed = loadHiddenChecks(store.checksDir);
  const suite = suiteFingerprint(store.hashAll());
  const locked = store.verify(ledger);
  if (!locked.ok) throw new Error(`grading checks changed after install: ${locked.problems.join("; ")}`);
  const gate = g.gate ?? runGate;
  const checks: GradeCheck[] = [];
  for (const name of Object.keys(installed.checks).sort()) {
    const r = await gate({ ledger, store, projectDir, jarvisHome: g.jarvisHome, workRoot: g.workRoot, repoPath: g.repoPath, revision: g.revision, check: installed.checks[name]!, taskId: "grade", attemptId: "g1" });
    checks.push({ name, status: r.status });
  }
  const grade: Grade = { revision: g.revision, suite, gradedAt: new Date().toISOString(), pass: checks.length > 0 && checks.every((c) => c.status === "pass"), checks, projectDir };
  const tmp = join(g.runDir, `.grade.json.${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(grade, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, join(g.runDir, "grade.json"));
  return grade;
}
