// Shared fixture for the protected-check and gate tests (tests/unit/checks-*.test.ts). Each test file
// gets its own `root` (this module is evaluated once per test file) and removes it in its own afterAll.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGate } from "../../../packages/cli/src/checks/gate.ts";
import { ChecksStore } from "../../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../../packages/cli/src/ledger/ledger.ts";
import { shortTmp } from "../../helpers.ts";

export const root = shortTmp("jtk-");
export const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
/** The number of projects made so far in this file; tests use it to name per-test files (a live binding). */
export let n = 0;

export function project() {
  const id = `p${++n}`;
  const jarvisHome = join(root, `jh${n}`);
  const projectDir = join(jarvisHome, "projects", id);
  mkdirSync(join(projectDir, "checks"), { recursive: true });
  const ledger = Ledger.open(projectDir);
  const store = new ChecksStore(projectDir);
  const repo = join(root, `work${n}`, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "value.txt"), "42\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "c1");
  const revision = git(repo, "rev-parse", "HEAD");
  return { id, jarvisHome, projectDir, ledger, store, repo, revision, workRoot: join(root, `work${n}`) };
}
/** The completion line a verify phase prints last (decision 76). */
export const COMPLETE = 'echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"\n';
/** The default assertions: the case exited 0. */
const EXIT0 = `test "$(cat main/code)" = 0 || exit 1\n${COMPLETE}`;
/** One case, "main", running checks/fixtures/<name>.sh in the candidate sandbox; assertions in checks/<name>.verify.sh. */
export const check = (name: string, script: string, p: ReturnType<typeof project>, verify = EXIT0) => {
  mkdirSync(join(p.projectDir, "checks", "fixtures"), { recursive: true });
  writeFileSync(join(p.projectDir, "checks", "fixtures", `${name}.sh`), script);
  writeFileSync(join(p.projectDir, "checks", `${name}.verify.sh`), verify);
  return { name, cases: [{ id: "main", command: `sh "$JARVIS_FIXTURES/${name}.sh"` }], verify: `sh "$JARVIS_CHECKS/${name}.verify.sh"`, timeoutMs: 30_000 };
};
export const out = (r: { evidenceDir: string }, f = "stdout") => readFileSync(join(r.evidenceDir, "cases", "main", f), "utf8");
type Check = ReturnType<typeof check>;
export const gate = (p: ReturnType<typeof project>, c: Check, extra = {}) =>
  runGate({ ledger: p.ledger, store: p.store, projectDir: p.projectDir, jarvisHome: p.jarvisHome, workRoot: p.workRoot, repoPath: p.repo, revision: p.revision, check: c, taskId: "t1", attemptId: "a1", ...extra });
