import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkpointPlan } from "../../packages/cli/src/runner/plan-checkpoint.ts";
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
