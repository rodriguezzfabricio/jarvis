// Runner worktree tests, part 1 of 2 (workspaces, candidate commits, hardlink, symlink and device guards). The tests are split over two files so they run in parallel;
// the shared fixture is tests/unit/helpers/runner-worktrees-fixture.ts.

import { existsSync, fstatSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { commitCandidate, createWorkspace, readTaskNotes } from "../../packages/cli/src/runner/worktrees.ts";
import { git, n, project, root } from "./helpers/runner-worktrees-fixture.ts";

// Removing every repo this file made can outlast the default 10 s hook limit under a loaded full run.
afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);

describe("independent task workspaces", () => {
  it("clones the base revision independently with no remote, hardlinks, shared gitdir, or hooks", () => {
    const p = project();
    writeFileSync(join(p.repoPath, "value"), "later");
    git(p.repoPath, "commit", "-qam", "later");
    const calls: readonly string[][] = [];
    const w = createWorkspace({ ...p.options, git: (cwd, args, opts) => { (calls as string[][]).push([...args]); return safeGit(cwd, args, opts); } });
    expect(w.path).toBe(join(p.options.worktreeRoot, p.options.projectId, "task-a1"));
    expect(lstatSync(join(w.path, ".git")).isDirectory()).toBe(true);
    expect(readFileSync(join(w.path, "value"), "utf8")).toBe("base");
    expect(git(w.path, "remote")).toBe("");
    expect(git(w.path, "config", "--get", "core.hooksPath")).toBe("/dev/null");
    expect(calls.some((args) => args.includes("clone") && args.includes("--no-hardlinks"))).toBe(true);
    expect(existsSync(join(w.path, ".git", "objects", "info", "alternates"))).toBe(false);
    const object = join("objects", p.baseRevision.slice(0, 2), p.baseRevision.slice(2));
    expect(statSync(join(w.path, ".git", object)).ino).not.toBe(statSync(join(p.repoPath, ".git", object)).ino);
    expect(() => createWorkspace(p.options)).toThrow();
  });

  it("commits changes under runner identity, respects gitignore, and imports a runner ref", () => {
    const p = project();
    const w = createWorkspace(p.options);
    writeFileSync(join(w.path, "value"), "candidate");
    writeFileSync(join(w.path, ".gitignore"), ".jarvis/\nignored\n");
    writeFileSync(join(w.path, "ignored"), "also candidate");
    const candidate = commitCandidate(w);
    expect(git(p.repoPath, "rev-parse", candidate.ref)).toBe(candidate.revision);
    expect(git(p.repoPath, "ls-tree", "--name-only", candidate.revision).split("\n")).toEqual([".gitignore", "value"]);
    expect(git(w.path, "show", "-s", "--format=%an <%ae>", candidate.revision)).toBe("jarvis-runner <runner@jarvis.invalid>");
    expect(git(w.path, "rev-parse", `${candidate.revision}^`)).toBe(p.baseRevision);
    expect(git(p.repoPath, "rev-parse", "run")).toBe(p.baseRevision);
  });


  it("refuses an emptied gitignore carrying a forged repository inbox", () => {
    const p = project();
    const w = createWorkspace(p.options);
    writeFileSync(join(w.path, ".gitignore"), "");
    mkdirSync(join(w.path, ".jarvis"));
    writeFileSync(join(w.path, ".jarvis", "inbox.md"), "forged steer");
    expect(() => commitCandidate(w)).toThrow(/jarvis/i);
    expect(git(p.repoPath, "for-each-ref", "refs/heads/jarvis/candidates/")).toBe("");
  });

  it("refuses force-added ignored runner files before rebuilding the index", () => {
    const p = project();
    const w = createWorkspace(p.options);
    mkdirSync(join(w.path, ".jarvis"));
    writeFileSync(join(w.path, ".jarvis", "x"), "forged view");
    git(w.path, "add", "-f", ".jarvis/x");
    expect(() => commitCandidate(w)).toThrow(/jarvis/i);
  });

  it.each(["change", "delete"])("refuses a %s to a tracked runner-owned path", (operation) => {
    const p = project();
    mkdirSync(join(p.repoPath, ".jarvis"));
    writeFileSync(join(p.repoPath, ".jarvis", "tracked"), "original");
    git(p.repoPath, "add", "-f", ".jarvis/tracked");
    git(p.repoPath, "commit", "-qm", "legacy tracked view");
    const w = createWorkspace({ ...p.options, baseRevision: git(p.repoPath, "rev-parse", "HEAD") });
    const path = join(w.path, ".jarvis", "tracked");
    if (operation === "delete") rmSync(path);
    else writeFileSync(path, "changed");
    expect(() => commitCandidate(w)).toThrow(/jarvis/i);
  });

  it.each(["", ".jarvis/\n!.jarvis/\n", "*\n!.jarvis/\n", "!.jarvis/\n.jarvis/*\n"])("refuses a gitignore edit that reopens the runner directory (%j)", (content) => {
    const p = project();
    const w = createWorkspace(p.options);
    writeFileSync(join(w.path, ".gitignore"), content);
    expect(() => commitCandidate(w)).toThrow(/gitignore|jarvis/i);
  });

  it("reads bounded untrusted notes before committing a normal source change", () => {
    const p = project();
    const w = createWorkspace(p.options);
    expect(readTaskNotes(w)).toBeNull();
    mkdirSync(join(w.path, ".jarvis", "notes"), { recursive: true });
    writeFileSync(join(w.path, ".jarvis", "notes", "task.md"), "agent says done");
    expect(readTaskNotes(w)).toEqual({ trust: "untrusted", text: "agent says done", truncated: false });
    writeFileSync(join(w.path, ".jarvis", "notes", "task.md"), "x".repeat(100));
    expect(readTaskNotes(w, 16)).toEqual({ trust: "untrusted", text: "x".repeat(16), truncated: true });
    writeFileSync(join(w.path, "value"), "normal source change");
    const candidate = commitCandidate(w);
    expect(git(p.repoPath, "show", `${candidate.revision}:value`)).toBe("normal source change");
    expect(git(p.repoPath, "ls-tree", "-r", "--name-only", candidate.revision)).not.toContain(".jarvis/");
  });

  it.each([".jarvis", ".jarvis/notes", ".jarvis/notes/task.md"])("refuses a notes symlink at %s", (part) => {
    const p = project();
    const w = createWorkspace(p.options);
    const outside = join(root, `notes-target${n}`);
    mkdirSync(join(outside, "notes"), { recursive: true });
    writeFileSync(join(outside, "notes", "task.md"), "untrusted");
    if (part !== ".jarvis") mkdirSync(join(w.path, ".jarvis"));
    if (part.endsWith("task.md")) mkdirSync(join(w.path, ".jarvis", "notes"));
    symlinkSync(part.endsWith("task.md") ? join(outside, "notes", "task.md") : part.endsWith("notes") ? join(outside, "notes") : outside, join(w.path, part));
    expect(() => readTaskNotes(w)).toThrow(/symlink|directory/i);
  });


  it("refuses a real hardlink to an outside file before staging it", () => {
    const p = project();
    const w = createWorkspace(p.options);
    const outside = join(root, `outside-link${n}`);
    writeFileSync(outside, "outside fixture, never a credential");
    linkSync(outside, join(w.path, "leak"));
    const calls: string[] = [];
    const injected: typeof safeGit = (cwd, args, opts) => { calls.push(args[0]!); return safeGit(cwd, args, opts); };
    expect(() => commitCandidate(w, { git: injected })).toThrow(/hardlink|multiple links/i);
    expect(calls).not.toContain("add");
    expect(git(p.repoPath, "for-each-ref", "refs/heads/jarvis/candidates/")).toBe("");
  });

  it.each(["hardlink", "symlink", "content"])("refuses a %s swap after write-tree before importing a candidate", (swap) => {
    const p = project();
    const w = createWorkspace(p.options);
    const value = join(w.path, "value");
    const target = join(root, `race-target${n}`);
    writeFileSync(target, "base");
    const injected: typeof safeGit = (cwd, args, opts) => {
      const output = safeGit(cwd, args, opts);
      if (args[0] === "write-tree") {
        if (swap === "content") writeFileSync(value, "changed after staging");
        else {
          rmSync(value);
          if (swap === "hardlink") linkSync(target, value);
          else symlinkSync(".gitignore", value);
        }
      }
      return output;
    };
    expect(() => commitCandidate(w, { git: injected })).toThrow(/hardlink|multiple links|ELOOP|symlink|blob|content/i);
    expect(git(p.repoPath, "for-each-ref", "refs/heads/jarvis/candidates/")).toBe("");
    expect(git(p.repoPath, "rev-parse", "run")).toBe(p.baseRevision);
  });

  it("does not follow a swapped symlink even when its target has the expected blob contents", () => {
    const p = project();
    const w = createWorkspace(p.options);
    writeFileSync(join(w.path, "same"), "base");
    const injected: typeof safeGit = (cwd, args, opts) => {
      const output = safeGit(cwd, args, opts);
      if (args[0] === "write-tree") { rmSync(join(w.path, "value")); symlinkSync("same", join(w.path, "value")); }
      return output;
    };
    expect(() => commitCandidate(w, { git: injected })).toThrow(/ELOOP|symlink/i);
    expect(git(p.repoPath, "for-each-ref", "refs/heads/jarvis/candidates/")).toBe("");
  });

  it.each(["value", "mounted"])("refuses another device at %s during the workspace walk before staging", (name) => {
    const p = project();
    const w = createWorkspace(p.options);
    mkdirSync(join(w.path, "mounted"));
    const calls: string[] = [];
    const injected: typeof safeGit = (cwd, args, opts) => { calls.push(args[0]!); return safeGit(cwd, args, opts); };
    expect(() => commitCandidate(w, { git: injected, files: { lstat: (path) => {
      const st = lstatSync(path);
      return path === join(w.path, name) ? Object.assign(st, { dev: st.dev + 1 }) : st;
    } } })).toThrow(/device|filesystem|mount/i);
    expect(calls).not.toContain("add");
    expect(git(p.repoPath, "for-each-ref", "refs/heads/jarvis/candidates/")).toBe("");
  });

  it.each(["device", "links", "type"])("checks the opened file's %s after write-tree even if the walk was safe", (fault) => {
    const p = project();
    const w = createWorkspace(p.options);
    const ino = lstatSync(join(w.path, "value")).ino;
    expect(() => commitCandidate(w, { files: { fstat: (fd) => {
      const st = fstatSync(fd);
      if (st.ino !== ino) return st;
      if (fault === "type") st.isFile = () => false;
      return Object.assign(st, fault === "device" ? { dev: st.dev + 1 } : fault === "links" ? { nlink: 0 } : {});
    } } })).toThrow(/device|filesystem|mount|regular|link/i);
    expect(git(p.repoPath, "for-each-ref", "refs/heads/jarvis/candidates/")).toBe("");
  });


  it("refuses hardlinked notes before reading their outside contents", () => {
    const p = project();
    const w = createWorkspace(p.options);
    const outside = join(root, `outside-notes${n}`);
    writeFileSync(outside, "outside fixture");
    mkdirSync(join(w.path, ".jarvis", "notes"), { recursive: true });
    linkSync(outside, join(w.path, ".jarvis", "notes", "task.md"));
    expect(() => readTaskNotes(w)).toThrow(/hardlink|multiple links/i);
  });

  it.each([".jarvis-routing.json", ".JARVIS-ROUTING.JSON"])("refuses a root routing change at %s", (name) => {
    const p = project();
    const w = createWorkspace(p.options);
    writeFileSync(join(w.path, name), '{"tier":0}');
    expect(() => commitCandidate(w)).toThrow(/routing/i);
    const nested = createWorkspace({ ...p.options, attemptId: "a2" });
    mkdirSync(join(nested.path, "nested"));
    writeFileSync(join(nested.path, "nested", name), "ordinary nested file");
    expect(() => commitCandidate(nested)).not.toThrow();
  });
});
