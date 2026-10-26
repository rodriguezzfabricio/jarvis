import type { TestProject } from "vitest/node";

// Retained until the snapshot worker and its caller drop this compatibility context together.
declare module "vitest" {
  export interface ProvidedContext {
    realGit: string;
    shimEnv: Record<string, string>;
  }
}

/** No discovery: every test and worker uses Node's native process execution (decision 137). */
export default function setup(project: TestProject): void {
  project.provide("realGit", "");
  project.provide("shimEnv", {});
}
