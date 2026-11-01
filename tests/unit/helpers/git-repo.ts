// initRepo(dir, options): what `git init -q -b <branch>` (and, with `identity`, `git config user.email t@t` and
// `git config user.name t`) would leave in `dir`, made by copying a template repository (git-template.ts)
// instead of starting three processes. One template per kind is made when first needed and removed when the
// test file finishes.
import { rmSync } from "node:fs";
import { afterAll } from "vitest";
import { shortTmp } from "../../helpers.ts";
import { buildRepoTemplate, copyRepoTemplate } from "./git-template.ts";

export interface RepoOptions {
  /** Also set user.email=t@t and user.name=t, as the tests that run a plain `git commit` do. */
  identity?: boolean;
  /** The branch HEAD points to (default main). */
  branch?: string;
}

const templates = new Map<boolean, string>();
afterAll(() => { for (const dir of templates.values()) rmSync(dir, { recursive: true, force: true }); templates.clear(); });
function template(identity: boolean): string {
  let dir = templates.get(identity);
  if (dir === undefined) {
    dir = shortTmp("jgr-");
    buildRepoTemplate(dir, identity);
    templates.set(identity, dir);
  }
  return dir;
}

export function initRepo(dir: string, options: RepoOptions = {}): void {
  copyRepoTemplate(template(options.identity === true), dir, options.branch);
}
