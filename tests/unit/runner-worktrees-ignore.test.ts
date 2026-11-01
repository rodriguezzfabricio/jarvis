import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { commitCandidate, createWorkspace, seedWorkspace, type TaskWorkspace } from "../../packages/cli/src/runner/worktrees.ts";
import { git, project, root } from "./helpers/runner-worktrees-fixture.ts";

afterAll(() => rmSync(root, { recursive: true, force: true }));
const bases = new Map<string, ReturnType<typeof project>>();
let attempt = 0;
function fixture(base = "build/\n", exclude = true) {
  let p = bases.get(base);
  if (!p) {
    p = project();
    if (base !== ".jarvis/\n") {
      writeFileSync(join(p.repoPath, ".gitignore"), base);
      git(p.repoPath, "add", "-A"); git(p.repoPath, "commit", "-qm", "ignore baseline");
    }
    bases.set(base, p);
  }
  const w = createWorkspace({ ...p.options, attemptId: `a${++attempt}`, baseRevision: git(p.repoPath, "rev-parse", "HEAD") });
  mkdirSync(join(w.path, ".git/info"), { recursive: true });
  if (exclude) appendFileSync(join(w.path, ".git/info/exclude"), "\n/.jarvis/\n");
  return w;
}
function check(w: TaskWorkspace, content: string, mode: "staged" | "tree", ignoreName = ".gitignore") {
  writeFileSync(join(w.path, ignoreName), content);
  git(w.path, "add", ignoreName);
  if (mode === "staged") return commitCandidate(w);
  const tree = git(w.path, "write-tree");
  const revision = git(w.path, "commit-tree", tree, "-p", w.baseRevision, "-m", "untrusted candidate");
  const ref = `refs/heads/jarvis/candidates/task/seed-${w.attemptId}`;
  git(w.repoPath, "-c", "protocol.file.allow=always", "fetch", "--quiet", w.path, `${revision}:${ref}`);
  git(w.path, "reset", "--hard", w.baseRevision);
  return seedWorkspace(w, { revision, ref });
}

describe.each(["staged", "tree"] as const)("runner ignore policy (%s)", (mode) => {
  it("allows an unrelated line when info/exclude protects the runner directory", () => {
    const w = fixture();
    mkdirSync(join(w.path, ".jarvis/notes"), { recursive: true });
    writeFileSync(join(w.path, ".jarvis/notes/task.md"), "untrusted claim");
    expect(() => check(w, "build/\n/bin\n", mode)).not.toThrow();
    expect(git(w.path, "check-ignore", ".jarvis/notes/task.md")).toBe(".jarvis/notes/task.md");
    expect(readFileSync(join(w.path, ".git/info/exclude"), "utf8")).toContain("/.jarvis/");
  });
  it("does not accept a removed root ignore even when info/exclude still protects it", () => {
    expect(() => check(fixture(".jarvis/\n"), "build/\n", mode)).toThrow(/keep .jarvis/);
  });
  it("fails closed without the runner exclude or a root ignore", () => {
    expect(() => check(fixture("build/\n", false), "build/\n/bin\n", mode)).toThrow(/keep .jarvis/);
  });
  it.each(["!.jarvis", "!.jarvis/", "!/.jarvis/**", "!/.JaRvIs/notes/file", "!.JARVIS", "!.[j]arvis/", "!/.jar*/**", "!/**/.jarvis/**", "!.jarvis ", "!.jarvis\\/notes"])("refuses negation %s even if masked by a later ignore", (pattern) => {
    expect(() => check(fixture(".jarvis/\n"), `.jarvis/\n${pattern}\n.jarvis/\n`, mode)).toThrow(/gitignore/);
  });
  it("checks a case-renamed root ignore by its stored name", () => {
    const w = fixture();
    git(w.path, "mv", ".gitignore", ".GITIGNORE");
    expect(() => check(w, "!.JaRvIs/\n", mode, ".GITIGNORE")).toThrow(/gitignore/);
  });
  it("allows unrelated negations and escaped literal exclamation marks", () => {
    expect(() => check(fixture(), "build/\n!keep.txt\n!src/.jarvis/\n\\!.jarvis\n", mode)).not.toThrow();
  });
  it("shows that a nested gitignore cannot reopen the root runner directory", () => {
    const w = fixture();
    mkdirSync(join(w.path, "src"));
    writeFileSync(join(w.path, "src/.gitignore"), "!.jarvis/\n!/.jarvis/**\n!../.jarvis/\n");
    git(w.path, "add", "src/.gitignore");
    expect(() => check(w, "build/\n/bin\n", mode)).not.toThrow();
    mkdirSync(join(w.path, ".jarvis"), { recursive: true });
    expect(git(w.path, "check-ignore", ".jarvis/any/depth/file")).toBe(".jarvis/any/depth/file");
  });
});

it("checks the staged ignore, never a harmless working copy substituted after staging", () => {
  const w = fixture(".jarvis/\n");
  writeFileSync(join(w.path, ".gitignore"), "!.jarvis/\n");
  git(w.path, "add", ".gitignore");
  writeFileSync(join(w.path, ".gitignore"), ".jarvis/\n");
  expect(() => commitCandidate(w)).toThrow(/gitignore/);
});

it("propagates an ignore-check infrastructure fault rather than accepting the candidate", () => {
  const w = fixture();
  writeFileSync(join(w.path, ".gitignore"), "build/\n/bin\n");
  expect(() => commitCandidate(w, { git: (cwd, args, options) => {
    if (args.includes("check-ignore")) throw new Error("injected ignore-check failure");
    return safeGit(cwd, args, options);
  } })).toThrow("injected ignore-check failure");
});


it("does not mistake an unreadable ignore blob for an absent file", () => {
  const w = fixture();
  writeFileSync(join(w.path, ".gitignore"), "build/\n/bin\n");
  expect(() => commitCandidate(w, { git: (cwd, args, options) => {
    if (args[0] === "show" && args[1]?.endsWith(":.gitignore")) throw Object.assign(new Error("injected missing blob"), { status: 128 });
    return safeGit(cwd, args, options);
  } })).toThrow("injected missing blob");
});


it("refuses ambiguous root ignore names in the index", () => {
  const w = fixture();
  const blob = git(w.path, "rev-parse", "HEAD:.gitignore");
  git(w.path, "update-index", "--add", "--cacheinfo", `100644,${blob},.GITIGNORE`);
  expect(() => commitCandidate(w)).toThrow(/ambiguous root .gitignore/);
});

it("does not treat a gitignore symlink's target text as ignore rules", () => {
  const w = fixture(".jarvis/\n");
  mkdirSync(join(w.path, ".jarvis"));
  rmSync(join(w.path, ".gitignore"));
  symlinkSync(".jarvis", join(w.path, ".gitignore"));
  expect(() => commitCandidate(w)).toThrow(/keep .jarvis/);
});
