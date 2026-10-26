// Vitest globalSetup (vitest.config.ts): finds the real git binary once per run, for tests/setup/real-git.ts.
// On macOS, /usr/bin/git is a shim that looks up the active developer directory and then runs the git in
// it. Every spawn through the shim costs about three times the CPU of the real git (measured: about 22 ms
// against about 8 ms for `git rev-parse`), and the suite starts thousands of them.
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Absolute path of the git the /usr/bin/git shim would run, or "" when there is nothing to swap. */
    realGit: string;
  }
}

export default function setup(project: TestProject): void {
  let realGit = "";
  if (process.platform === "darwin") {
    try {
      // The shim's own rule: DEVELOPER_DIR when set, otherwise what xcode-select reports.
      const developerDir = process.env.DEVELOPER_DIR || execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim();
      const candidate = `${developerDir}/usr/bin/git`;
      accessSync(candidate, constants.X_OK);
      realGit = candidate;
    } catch {
      // No developer directory: leave the shim in place.
    }
  }
  project.provide("realGit", realGit);
}
