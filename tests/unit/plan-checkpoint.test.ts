import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkpointPlan, initializePlanningRepository } from "../../packages/cli/src/runner/plan-checkpoint.ts";
import { safeGit } from "../../packages/cli/src/eval/git.ts";
import { approvedSpec } from "../../packages/cli/src/commands/run-compose.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
// The plan-lens fixture is prose input, not a parsed spec fixture; use the production grammar here.
const spec = readFileSync(new URL("../fixtures/plan-review/good/spec.md", import.meta.url), "utf8").replace(/^- (A\d+ \[delegated\]):/gm, "- **$1:**");
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "planning-checkpoint-"))); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(join(repo, "docs/spec"), { recursive: true });
  writeFileSync(join(repo, "docs/spec/v1.md"), spec);
  const git = (args: string[]) => safeGit(repo, args, { home: root }).toString().trim();
  return { root, repo, git };
}
it("checkpoints only planning documents in a new repository, never product code or .jarvis", () => {
  const p = project(); writeFileSync(join(p.repo, "PRODUCT.md"), "Items CLI");
  writeFileSync(join(p.repo, "app.mjs"), "unreviewed product code");
  mkdirSync(join(p.repo, ".jarvis")); writeFileSync(join(p.repo, ".jarvis/plan.json"), "{}");
  checkpointPlan(p.repo, p.root);
  expect(p.git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")).toEqual(["PRODUCT.md", "docs/spec/v1.md"]);
  expect(p.git(["status", "--porcelain"])).toContain("app.mjs");
  const head = p.git(["rev-parse", "HEAD"]); checkpointPlan(p.repo, p.root);
  expect(p.git(["rev-parse", "HEAD"])).toBe(head);
});
it("preserves unrelated staged work and disables repository hooks", () => {
  const p = project(); p.git(["init", "-q", "-b", "main"]); p.git(["commit", "--allow-empty", "-qm", "initial"]);
  writeFileSync(join(p.repo, "committed.mjs"), "preserve committed product code"); p.git(["add", "committed.mjs"]); p.git(["commit", "-qm", "existing product"]);
  writeFileSync(join(p.repo, "app.mjs"), "keep staged"); p.git(["add", "app.mjs"]);
  writeFileSync(join(p.repo, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 91\n", { mode: 0o700 });
  checkpointPlan(p.repo, p.root);
  expect(p.git(["diff", "--cached", "--name-only"])).toBe("app.mjs");
  expect(p.git(["ls-tree", "-r", "--name-only", "HEAD"])).toBe("committed.mjs\ndocs/spec/v1.md");
});
it("refuses a draft before creating a repository", () => {
  const p = project(); writeFileSync(join(p.repo, "docs/spec/v1.md"), spec.replace("status: confirmed", "status: draft"));
  expect(() => checkpointPlan(p.repo, p.root)).toThrow(/draft/);
});
it("refuses changed approved spec content but permits later confirmation without content edits", () => {
  const p = project(); writeFileSync(join(p.repo, "docs/spec/v1.md"), spec.replace("status: confirmed", "status: unconfirmed"));
  checkpointPlan(p.repo, p.root);
  writeFileSync(join(p.repo, "docs/spec/v1.md"), spec); checkpointPlan(p.repo, p.root);
  writeFileSync(join(p.repo, "docs/spec/v1.md"), spec.replace("Save named items", "Delete named items"));
  expect(() => checkpointPlan(p.repo, p.root)).toThrow(/new spec version/);
});
it("refuses planning document symlinks before committing anything", () => {
  const p = project(); const outside = join(p.root, "outside.md"); writeFileSync(outside, "outside");
  symlinkSync(outside, join(p.repo, "PRODUCT.md"));
  expect(() => checkpointPlan(p.repo, p.root)).toThrow(/symlink/);
});
it("the run also refuses a draft that was committed without the checkpoint command", () => {
  const p = project(); p.git(["init", "-q", "-b", "main"]);
  writeFileSync(join(p.repo, "docs/spec/v1.md"), spec.replace("status: confirmed", "status: draft"));
  p.git(["add", "docs/spec/v1.md"]); p.git(["commit", "-qm", "draft"]);
  expect(() => approvedSpec((args) => p.git([...args]), "main")).toThrow(/draft/);
});
it("never executes a repository clean filter while checkpointing planning documents", () => {
  const p = project(); p.git(["init", "-q", "-b", "main"]); p.git(["commit", "--allow-empty", "-qm", "initial"]);
  const marker = join(p.root, "filter-ran");
  writeFileSync(join(p.repo, ".gitattributes"), "*.md filter=unsafe\n");
  p.git(["config", "filter.unsafe.clean", `touch '${marker}'; cat`]);
  p.git(["config", "filter.unsafe.required", "true"]);
  checkpointPlan(p.repo, p.root);
  expect(existsSync(marker)).toBe(false);
  expect(p.git(["show", "HEAD:docs/spec/v1.md"])).toBe(spec.trim());
});

it("refuses a symlinked git marker without changing the other repository", () => {
  const p = project(), other = project(); checkpointPlan(other.repo, other.root);
  const head = other.git(["rev-parse", "HEAD"]), index = readFileSync(join(other.repo, ".git/index"));
  symlinkSync(join(other.repo, ".git"), join(p.repo, ".git"));
  writeFileSync(join(p.repo, "PRODUCT.md"), "must not enter the other repository");
  expect(() => checkpointPlan(p.repo, p.root)).toThrow(/git.*symlink/i);
  expect(other.git(["rev-parse", "HEAD"])).toBe(head);
  expect(readFileSync(join(other.repo, ".git/index"))).toEqual(index);
});
it("refuses a git file pointing to an unrelated repository, but supports a real linked worktree", () => {
  const p = project(), other = project(); checkpointPlan(other.repo, other.root);
  const head = other.git(["rev-parse", "HEAD"]);
  writeFileSync(join(p.repo, ".git"), `gitdir: ${join(other.repo, ".git")}\n`);
  expect(() => checkpointPlan(p.repo, p.root)).toThrow(/git.*worktree/i);
  expect(other.git(["rev-parse", "HEAD"])).toBe(head);
  const linked = join(other.root, "linked"); other.git(["worktree", "add", "-b", "planning", linked]);
  writeFileSync(join(linked, "PRODUCT.md"), "linked planning");
  expect(checkpointPlan(linked, other.root)).toMatch(/^[a-f0-9]{40}$/);
  expect(other.git(["rev-parse", "HEAD"])).toBe(head);
});
it("bounds spec bytes before parsing them", () => {
  const p = project(); writeFileSync(join(p.repo, "docs/spec/v1.md"), "x".repeat(256 * 1024 + 1));
  expect(() => checkpointPlan(p.repo, p.root)).toThrow(/byte limit/);
  expect(existsSync(join(p.repo, ".git"))).toBe(false);
});
it("still rejects gaps and malformed earlier versions after bounded capture", () => {
  const p = project();
  writeFileSync(join(p.repo, "docs/spec/v3.md"), spec.replace("spec: 1", "spec: 3").replace("supersedes: none", "supersedes: 2"));
  expect(() => checkpointPlan(p.repo, p.root)).toThrow(/Missing v2/);
  rmSync(join(p.repo, "docs/spec/v3.md"));
  writeFileSync(join(p.repo, "docs/spec/v2.md"), spec.replace("spec: 1", "spec: 2").replace("supersedes: none", "supersedes: 1"));
  writeFileSync(join(p.repo, "docs/spec/v1.md"), "invalid spec");
  expect(() => checkpointPlan(p.repo, p.root)).toThrow(/valid spec history/);
});

it("bootstraps an empty project before intake without committing or requiring a spec", () => {
  const p = project(); rmSync(join(p.repo, "docs"), { recursive: true });
  writeFileSync(join(p.repo, "user.txt"), "preserve me");
  expect(initializePlanningRepository(p.repo, p.root)).toBe(p.repo);
  expect(p.git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
  expect(() => p.git(["rev-parse", "--verify", "HEAD"])).toThrow();
  expect(p.git(["ls-files"])).toBe("");
  expect(initializePlanningRepository(p.repo, p.root)).toBe(p.repo);
  const nested = join(p.repo, "nested"); mkdirSync(nested);
  expect(() => initializePlanningRepository(nested, p.root)).toThrow(/repository root/);
  expect(existsSync(join(nested, ".git"))).toBe(false);
});
