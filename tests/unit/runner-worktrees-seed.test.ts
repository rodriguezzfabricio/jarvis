// Decision 160: a repair's fresh workspace starts from its failed candidate's files, reconciled with work the
// run branch gained since, while HEAD (the next candidate's parent) stays the run branch.
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commitCandidate, createWorkspace, mergeCandidate, seedWorkspace } from "../../packages/cli/src/runner/worktrees.ts";
import { git, project, root } from "./helpers/runner-worktrees-fixture.ts";

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A base with two files, and a failed first attempt that edits one, adds one and deletes one. */
function failedAttempt() {
  const p = project();
  writeFileSync(join(p.repoPath, "gone"), "base file the attempt deletes");
  git(p.repoPath, "add", "-A"); git(p.repoPath, "commit", "-qm", "two files");
  const base = git(p.repoPath, "rev-parse", "HEAD");
  const w1 = createWorkspace({ ...p.options, baseRevision: base });
  writeFileSync(join(w1.path, "value"), "first draft");
  writeFileSync(join(w1.path, "added"), "kept work");
  unlinkSync(join(w1.path, "gone"));
  return { p, base, candidate: commitCandidate(w1) };
}
const second = (p: ReturnType<typeof project>, baseRevision: string) => createWorkspace({ ...p.options, attemptId: "a2", baseRevision });
// A missing file is an assertion failure, not a thrown ENOENT, so a dropped reconcile is caught, never an ERROR (decision 146).
const read = (dir: string, file: string) => { expect(existsSync(join(dir, file)), `${file} exists`).toBe(true); return readFileSync(join(dir, file), "utf8"); };

describe("seeding a repair workspace from its failed candidate", () => {
  it("checks the candidate's files out over an unchanged base, and the next candidate is still the whole change", () => {
    const { p, base, candidate } = failedAttempt();
    const w2 = second(p, base);
    expect(seedWorkspace(w2, candidate)).toBe("seeded");
    expect(read(w2.path, "value")).toBe("first draft");
    expect(read(w2.path, "added")).toBe("kept work");
    expect(existsSync(join(w2.path, "gone"))).toBe(false);
    expect(git(w2.path, "rev-parse", "HEAD")).toBe(base);
    writeFileSync(join(w2.path, "value"), "repaired"); // the repair edits, it doesn't redo
    const next = commitCandidate(w2);
    expect(git(p.repoPath, "rev-parse", `${next.revision}^`)).toBe(base);
    expect(git(p.repoPath, "rev-list", "--count", `${base}..${next.revision}`)).toBe("1");
    expect(git(p.repoPath, "diff", "--name-status", base, next.revision).split("\n").sort()).toEqual(["A\tadded", "D\tgone", "M\tvalue"]);
  });

  it("reconciles a promotion the run branch gained since the failed candidate's base", () => {
    const { p, candidate } = failedAttempt();
    writeFileSync(join(p.repoPath, "other"), "promoted meanwhile");
    git(p.repoPath, "add", "-A"); git(p.repoPath, "commit", "-qm", "another task");
    const head = git(p.repoPath, "rev-parse", "HEAD");
    const w2 = second(p, head);
    expect(seedWorkspace(w2, candidate)).toBe("seeded");
    expect(read(w2.path, "other")).toBe("promoted meanwhile");
    expect(read(w2.path, "value")).toBe("first draft");
    expect(existsSync(join(w2.path, "gone"))).toBe(false);
    expect(git(w2.path, "rev-parse", "HEAD")).toBe(head);
  });

  it("leaves the workspace at the new head when the candidate conflicts with it", () => {
    const { p, candidate } = failedAttempt();
    writeFileSync(join(p.repoPath, "value"), "promoted meanwhile");
    git(p.repoPath, "commit", "-qam", "another task edits value");
    const head = git(p.repoPath, "rev-parse", "HEAD");
    const w2 = second(p, head);
    expect(seedWorkspace(w2, candidate)).toBe("conflict");
    expect(read(w2.path, "value")).toBe("promoted meanwhile");
    expect(existsSync(join(w2.path, "added"))).toBe(false);
    expect(git(w2.path, "status", "--porcelain")).toBe("");
  });

  it("never seeds from a runner merge (decision 100 repairs it from the new head) or a candidate that is gone", () => {
    const { p, candidate } = failedAttempt();
    writeFileSync(join(p.repoPath, "other"), "promoted meanwhile");
    git(p.repoPath, "add", "-A"); git(p.repoPath, "commit", "-qm", "another task");
    const head = git(p.repoPath, "rev-parse", "HEAD");
    const merged = mergeCandidate({ repoPath: p.repoPath, candidate, head, home: root })!;
    const w2 = second(p, head);
    expect(seedWorkspace(w2, merged)).toBe("unavailable");
    expect(existsSync(join(w2.path, "added"))).toBe(false);
    expect(seedWorkspace(w2, { revision: candidate.revision, ref: "refs/heads/jarvis/candidates/task/none" })).toBe("unavailable");
    expect(git(w2.path, "status", "--porcelain")).toBe("");
    expect(() => seedWorkspace(w2, { revision: candidate.revision, ref: "refs/heads/run" })).toThrow(/runner-owned/);
  });
});
