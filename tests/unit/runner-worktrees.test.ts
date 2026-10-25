import { chmodSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { checkCandidate, commitCandidate, createWorkspace, deleteCandidateBranches, promoteCandidate, readTaskNotes } from "../../packages/cli/src/runner/worktrees.ts";
import { runGate, verifyEvidence, type GateInput, type GateResult } from "../../packages/cli/src/checks/gate.ts";
import * as sandbox from "../../packages/cli/src/sandbox/srt.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { buildLease, rebuildState } from "../../packages/cli/src/runner/state.ts";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("jrw-");
// Removing every repo this file made can outlast the default 10 s hook limit under a loaded full run.
afterAll(() => rmSync(root, { recursive: true, force: true }), 120_000);
const git = (cwd: string, ...args: string[]) => safeGit(cwd, args, { home: root }).toString().trim();
let n = 0;
function project() {
  const repoPath = join(root, `repo${++n}`);
  mkdirSync(repoPath);
  git(repoPath, "init", "-q", "-b", "run");
  writeFileSync(join(repoPath, "value"), "base");
  writeFileSync(join(repoPath, ".gitignore"), ".jarvis/\n");
  git(repoPath, "add", "-A");
  git(repoPath, "commit", "-qm", "base");
  const baseRevision = git(repoPath, "rev-parse", "HEAD");
  const options = { repoPath, projectId: `p${n}`, taskId: "task", attemptId: "a1", baseRevision, worktreeRoot: join(root, "worktrees"), home: root };
  return { repoPath, baseRevision, options };
}

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

  it("rejects absolute symlinks even when their target is inside the workspace", () => {
    const p = project();
    const w = createWorkspace(p.options);
    symlinkSync(join(w.path, "value"), join(w.path, "absolute"));
    expect(() => commitCandidate(w)).toThrow(/absolute.*symlink|symlink.*absolute/i);
    const relative = createWorkspace({ ...p.options, attemptId: "a2" });
    mkdirSync(join(relative.path, "nested"));
    symlinkSync("../value", join(relative.path, "nested", "relative"));
    expect(() => commitCandidate(relative)).not.toThrow();
  });

  it("pins every workspace git call and refuses a garbage HEAD without changing the ancestor index", () => {
    const p = project();
    const w = createWorkspace({ ...p.options, worktreeRoot: join(p.repoPath, "nested-worktrees") });
    const calls: Parameters<typeof safeGit>[] = [];
    const injected: typeof safeGit = (cwd, args, opts) => { calls.push([cwd, args, opts]); return safeGit(cwd, args, opts); };
    commitCandidate(w, { git: injected });
    for (const [cwd, , opts] of calls.filter(([cwd]) => cwd === w.path)) {
      expect(opts.env).toMatchObject({ GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd, GIT_CEILING_DIRECTORIES: join(p.repoPath, "nested-worktrees", p.options.projectId) });
    }
    const before = readFileSync(join(p.repoPath, ".git", "index"));
    writeFileSync(join(w.path, ".git", "HEAD"), "garbage\n");
    expect(() => commitCandidate(w)).toThrow();
    expect(readFileSync(join(p.repoPath, ".git", "index"))).toEqual(before);
  });

  it("refuses a garbage HEAD in an ancestor repository before rewriting any index", () => {
    const p = project();
    const w = createWorkspace({ ...p.options, worktreeRoot: join(p.repoPath, "nested-worktrees") });
    const before = readFileSync(join(p.repoPath, ".git", "index"));
    const workspaceIndex = readFileSync(join(w.path, ".git", "index"));
    writeFileSync(join(w.path, ".git", "HEAD"), "garbage\n");
    expect(() => readTaskNotes(w)).toThrow(/repository|HEAD|commit/i);
    expect(() => commitCandidate(w)).toThrow();
    expect(existsSync(join(w.path, ".git", "index"))).toBe(true);
    expect(readFileSync(join(w.path, ".git", "index"))).toEqual(workspaceIndex);
    expect(readFileSync(join(p.repoPath, ".git", "index"))).toEqual(before);
  });

  it("reads invalid UTF-8 notes leniently as untrusted text", () => {
    const p = project();
    const w = createWorkspace(p.options);
    mkdirSync(join(w.path, ".jarvis", "notes"), { recursive: true });
    writeFileSync(join(w.path, ".jarvis", "notes", "task.md"), Buffer.from([0x61, 0xff, 0x62]));
    expect(() => readTaskNotes(w)).not.toThrow();
    expect(readTaskNotes(w)).toEqual({ trust: "untrusted", text: "a�b", truncated: false });
  });

  it.each([".jarvis/x", ".JARVIS-ROUTING.JSON"])("revalidates an imported candidate changing %s before promotion", (name) => {
    const p = project();
    const w = createWorkspace(p.options);
    if (name.includes("/")) mkdirSync(join(w.path, ".jarvis"));
    writeFileSync(join(w.path, name), "forged policy");
    git(w.path, "add", "--force", name);
    git(w.path, "commit", "-qm", "bypass candidate helper");
    const revision = git(w.path, "rev-parse", "HEAD");
    const ref = "refs/heads/jarvis/candidates/task/a1";
    safeGit(p.repoPath, ["-c", "protocol.file.allow=always", "fetch", "--quiet", w.path, `${revision}:${ref}`], { home: root });
    expect(() => promoteCandidate({ ...p.options, candidate: { revision, ref }, runBranch: "run", expectedHead: p.baseRevision })).toThrow(/jarvis|routing/i);
    expect(git(p.repoPath, "rev-parse", "run")).toBe(p.baseRevision);
  });

  it("safeGit prevents a planted pre-commit hook from executing", () => {
    const p = project();
    const w = createWorkspace(p.options);
    const marker = join(root, `hook${n}`);
    const hook = join(w.path, ".git", "hooks", "pre-commit");
    mkdirSync(join(w.path, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(w.path, "value"), "candidate");
    expect(commitCandidate(w).revision).toMatch(/^[a-f0-9]{40}$/);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses tampered config and gitdir symlinks before a runner git call", () => {
    for (const tamper of [
      (path: string) => writeFileSync(join(path, ".git", "config"), "[core]\n hooksPath = hooks\n"),
      (path: string) => { rmSync(join(path, ".git"), { recursive: true }); symlinkSync(project().repoPath + "/.git", join(path, ".git")); },
    ]) {
      const p = project();
      const w = createWorkspace(p.options);
      tamper(w.path);
      const fake = vi.fn(() => Buffer.from(""));
      expect(() => commitCandidate(w, { git: fake })).toThrow(/config|git/i);
      expect(fake).not.toHaveBeenCalled();
    }
  });

  it("rejects external and dangling symlinks but permits internal links", () => {
    for (const target of [root, join(root, "missing")]) {
      const p = project();
      const w = createWorkspace(p.options);
      symlinkSync(target, join(w.path, "escape"));
      expect(() => commitCandidate(w)).toThrow(/symlink/i);
    }
    const p = project();
    const w = createWorkspace(p.options);
    symlinkSync("value", join(w.path, "inside"));
    expect(commitCandidate(w).revision).toMatch(/^[a-f0-9]{40}$/);
  });

  it("refuses a candidate tree containing .git internals, including nested case variants", () => {
    for (const name of [".git/config", "nested/.GiT/hooks/pre-commit"]) {
      const p = project();
      const w = createWorkspace(p.options);
      const fake: typeof safeGit = (cwd, args, opts) => args.includes("ls-tree")
        ? Buffer.from(`100644 blob ${"a".repeat(40)}\t${name}\0`)
        : safeGit(cwd, args, opts);
      expect(() => commitCandidate(w, { git: fake })).toThrow(/git internals/i);
      expect(git(p.repoPath, "for-each-ref", "refs/heads/jarvis/candidates/")).toBe("");
    }
  });

  it("checks the committed revision by delegating to the existing gate", async () => {
    const p = project();
    const w = createWorkspace(p.options);
    const candidate = commitCandidate(w);
    const projectDir = join(root, `protected${n}`);
    const ledger = Ledger.open(projectDir);
    const input = { ledger, store: new ChecksStore(projectDir), projectDir, jarvisHome: root, workRoot: root, check: { name: "unit", cases: [{ id: "main", command: "true" }], verify: "true", timeoutMs: 1 } };
    const gate = vi.fn(async (_input: GateInput) => ({ status: "pass" } as GateResult));
    await checkCandidate(w, candidate, input, gate);
    expect(gate).toHaveBeenCalledWith({ ...input, repoPath: p.repoPath, revision: candidate.revision, taskId: "task", attemptId: "a1" });
  });


  it("the real gate checks an imported candidate through its branch", async () => {
    const p = project();
    const w = createWorkspace(p.options);
    writeFileSync(join(w.path, "value"), "candidate value\n");
    const candidate = commitCandidate(w);
    const jarvisHome = join(root, `gate-home${n}`);
    const projectDir = join(jarvisHome, "projects", p.options.projectId);
    const ledger = Ledger.open(projectDir);
    const store = new ChecksStore(projectDir);
    mkdirSync(join(store.checksDir, "fixtures"), { recursive: true });
    writeFileSync(join(store.checksDir, "fixtures", "value.sh"), "cat value\n");
    writeFileSync(join(store.checksDir, "value.verify.sh"), [
      'test "$(cat main/code)" = 0 || exit 1',
      'test "$(cat main/stdout)" = "candidate value" || exit 1',
      'echo "JARVIS-CHECK-COMPLETE $(cat "$JARVIS_COMPLETION_FILE")"',
    ].join("\n") + "\n");
    store.approve(ledger, "protected value check");
    // The worker sandbox forbids SRT's mux socket. Keep the real gate/Git/evidence path and fake
    // only sandbox transport, using the existing process runner on these local fixture commands.
    const execution = vi.spyOn(sandbox, "runSandboxed").mockImplementation((input) =>
      runSession({ ...input, bin: "/bin/sh", args: ["-c", input.command] }));
    try {
      const result = await checkCandidate(w, candidate, {
        ledger, store, projectDir, jarvisHome, workRoot: join(root, `gate-work${n}`),
        check: { name: "value", cases: [{ id: "main", command: 'sh "$JARVIS_FIXTURES/value.sh"' }], verify: 'sh "$JARVIS_CHECKS/value.verify.sh"', timeoutMs: 30_000 },
      }, runGate);
      expect(result.status, JSON.stringify(result.entry.data)).toBe("pass");
      expect(candidate.ref).toBe("refs/heads/jarvis/candidates/task/a1");
      expect(verifyEvidence(result.entry)).toEqual({ ok: true, problems: [] });
      expect(execution).toHaveBeenCalledTimes(2);
      expect(execution.mock.calls[0]?.[0].cwd).not.toBe(w.path);
    } finally {
      execution.mockRestore();
    }
  }, 120_000);

  it("deletes only runner candidate branches, preserves other refs, and is idempotent", () => {
    const p = project();
    const refs = ["refs/heads/jarvis/candidates/task/a1", "refs/heads/jarvis/candidates/other/a2"];
    const keep = ["refs/heads/run", "refs/heads/jarvis/candidates-keep", "refs/tags/jarvis/candidates/task/a1", "refs/jarvis/other"];
    for (const ref of [...refs, ...keep]) git(p.repoPath, "update-ref", ref, p.baseRevision);
    expect(deleteCandidateBranches(p.repoPath, { home: root })).toEqual([...refs].sort());
    expect(git(p.repoPath, "for-each-ref", "--format=%(refname)", "refs/heads/jarvis/candidates/")).toBe("");
    for (const ref of keep) expect(git(p.repoPath, "rev-parse", ref)).toBe(p.baseRevision);
    expect(deleteCandidateBranches(p.repoPath, { home: root })).toEqual([]);
  });

  it("does not delete a candidate branch that changed after cleanup enumerated it", () => {
    const p = project();
    const ref = "refs/heads/jarvis/candidates/task/a1";
    git(p.repoPath, "update-ref", ref, p.baseRevision);
    writeFileSync(join(p.repoPath, "value"), "new revision");
    git(p.repoPath, "commit", "-qam", "later");
    const newer = git(p.repoPath, "rev-parse", "HEAD");
    const concurrentGit: typeof safeGit = (cwd, args, opts) => {
      const output = safeGit(cwd, args, opts);
      if (args.includes("for-each-ref")) safeGit(cwd, ["update-ref", ref, newer], opts);
      return output;
    };
    expect(() => deleteCandidateBranches(p.repoPath, { home: root, git: concurrentGit })).toThrow(/expected|lock ref/i);
    expect(git(p.repoPath, "rev-parse", ref)).toBe(newer);
  });

  it("fast-forwards an accepted candidate, keeps the last-green tag, and can merge a divergence", () => {
    for (const diverge of [false, true]) {
      const p = project();
      const w = createWorkspace(p.options);
      writeFileSync(join(w.path, "value"), "candidate");
      const candidate = commitCandidate(w);
      if (diverge) {
        writeFileSync(join(p.repoPath, "other"), "parallel");
        git(p.repoPath, "add", "-A");
        git(p.repoPath, "commit", "-qm", "other task");
      }
      const expectedHead = git(p.repoPath, "rev-parse", "HEAD");
      const revision = promoteCandidate({ ...p.options, candidate, runBranch: "run", expectedHead });
      expect(git(p.repoPath, "rev-parse", "last-green")).toBe(revision);
      expect(git(p.repoPath, "rev-parse", "run")).toBe(revision);
      expect(readFileSync(join(p.repoPath, "value"), "utf8")).toBe("candidate");
      if (!diverge) expect(revision).toBe(candidate.revision);
      else expect(git(p.repoPath, "show", "-s", "--format=%P").split(" ")).toEqual([expectedHead, candidate.revision]);
    }
  });


  it("rejects a base checkout with an escaping symlink before returning a session workspace", () => {
    const p = project();
    symlinkSync(root, join(p.repoPath, "escape"));
    git(p.repoPath, "add", "-A");
    git(p.repoPath, "commit", "-qm", "external symlink");
    expect(() => createWorkspace({ ...p.options, baseRevision: git(p.repoPath, "rev-parse", "HEAD") })).toThrow(/symlink/i);
  });

  it("does not execute planted checkout or merge hooks during promotion", () => {
    const p = project();
    const w = createWorkspace(p.options);
    const candidate = commitCandidate(w);
    const marker = join(root, `promotion-hook${n}`);
    for (const name of ["post-checkout", "post-merge"]) {
      const hook = join(p.repoPath, ".git", "hooks", name);
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(hook, 0o755);
    }
    promoteCandidate({ ...p.options, candidate, runBranch: "run", expectedHead: p.baseRevision });
    expect(existsSync(marker)).toBe(false);
  });

  it("a crash after importing a candidate never advances the branch or last-green", () => {
    const p = project();
    git(p.repoPath, "tag", "last-green", p.baseRevision);
    const w = createWorkspace(p.options);
    writeFileSync(join(w.path, "value"), "unacknowledged candidate");
    const ledger = Ledger.open(join(root, `crash${n}`));
    ledger.append({ kind: "run_started", actor: "runner", data: { runId: "crashed", pid: 51 } });
    ledger.append({ kind: "task_created", actor: "runner", task_id: "task", data: {} });
    ledger.append(buildLease({ taskId: "task", attemptId: "a1", runId: "crashed", holderPid: 51, ttlMs: 1000, workspace: w.path }, () => 0));
    ledger.append({ kind: "attempt_started", actor: "runner", task_id: "task", attempt_id: "a1", data: { runId: "crashed", workspace: w.path, baseRevision: p.baseRevision } });
    const candidate = commitCandidate(w); // Crash boundary: attempt_ended is deliberately never written.
    const state = rebuildState(ledger.entries(), { now: 100, alivePids: new Set() });
    expect(state.tasks.task).toMatchObject({ status: "failed", attemptCount: 1, interruption: "attempt ended without a result" });
    expect(state.lastGreenRevision).toBeNull();
    expect(git(p.repoPath, "show", `${candidate.ref}:value`)).toBe("unacknowledged candidate");
    expect(git(p.repoPath, "rev-parse", "run")).toBe(p.baseRevision);
    expect(git(p.repoPath, "rev-parse", "last-green")).toBe(p.baseRevision);
  });

  it("refuses path escapes, symbolic project roots, stale promotions and dirty repositories", () => {
    const p = project();
    for (const projectId of ["..", "../escape", "/tmp/escape"]) expect(() => createWorkspace({ ...p.options, projectId })).toThrow();
    mkdirSync(p.options.worktreeRoot, { recursive: true });
    symlinkSync(root, join(p.options.worktreeRoot, "linked"));
    expect(() => createWorkspace({ ...p.options, projectId: "linked" })).toThrow();
    const w = createWorkspace(p.options);
    const candidate = commitCandidate(w);
    const input = { ...p.options, candidate, runBranch: "run", expectedHead: "f".repeat(40) };
    expect(() => promoteCandidate(input)).toThrow(/moved|head/i);
    writeFileSync(join(p.repoPath, "dirty"), "keep");
    expect(() => promoteCandidate({ ...input, expectedHead: p.baseRevision })).toThrow(/dirty|clean/i);
    expect(readFileSync(join(p.repoPath, "dirty"), "utf8")).toBe("keep");
  });
});
