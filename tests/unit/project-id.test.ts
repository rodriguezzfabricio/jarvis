import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { projectId, projectRoot, resolveProject } from "../../packages/cli/src/config/project.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo() { const root = mkdtempSync(join(tmpdir(), "Jarvis Project_ID-")); roots.push(root); mkdirSync(join(root, ".git")); mkdirSync(join(root, "src/nested"), { recursive: true }); return root; }
it("derives the exact sanitized folder name and hash of the canonical git top level", () => {
  const root = repo(); const canonical = realpathSync(root);
  const expected = `${basename(canonical)}-${createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  expect(projectId(root)).toBe(expected); expect(projectId(join(root, "src/nested"))).toBe(expected);
  expect(projectRoot(join(root, "src"))).toBe(canonical);
});
it("uses the same id through a directory alias and supports linked-worktree .git files", () => {
  const root = repo(); const alias = join(root, "alias"); symlinkSync(join(root, "src"), alias);
  expect(projectId(alias)).toBe(projectId(root)); rmSync(join(root, ".git"), { recursive: true }); writeFileSync(join(root, ".git"), "gitdir: /unused/test-fixture\n");
  expect(projectId(join(root, "src"))).toBe(projectId(root));
});
it("keeps same-named repos distinct", () => {
  const one = repo(); const two = repo(); const a = join(one, "same"); const b = join(two, "same");
  for (const path of [a, b]) mkdirSync(join(path, ".git"), { recursive: true });
  expect(projectId(a)).not.toBe(projectId(b));
});
it("resolves explicit option, then environment, then derived id and rejects traversal", () => {
  const cwd = repo(); expect(resolveProject({ option: "chosen", env: { JARVIS_PROJECT: "environment" }, cwd })).toBe("chosen");
  expect(resolveProject({ env: { JARVIS_PROJECT: "environment" }, cwd })).toBe("environment");
  expect(resolveProject({ env: {}, cwd })).toBe(projectId(cwd));
  for (const option of ["", "../outside", "/tmp/x", ".", "a/b"]) expect(() => resolveProject({ option, env: {}, cwd })).toThrow(/project/i);
});
it("refuses a symlinked .git marker and reports a non-repository", () => {
  const root = repo(); rmSync(join(root, ".git"), { recursive: true });
  expect(() => projectId(root)).toThrow(/repository/i); symlinkSync(join(root, "src"), join(root, ".git"));
  expect(() => projectId(root)).toThrow(/symlink/i);
});
