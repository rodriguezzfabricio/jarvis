import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareProductionRun } from "../../packages/cli/src/commands/run-compose.ts";
import type { PreparedRun } from "../../packages/cli/src/commands/run.ts";
import { parseReleaseSetup, saveReleaseSetup } from "../../packages/cli/src/release/config.ts";
import { createE2EProject, type E2EProject } from "../integration/e2e-helpers.ts";

const projects: E2EProject[] = [];
const runs: PreparedRun[] = [];
afterEach(async () => { for (const run of runs.splice(0)) await run.close(); for (const p of projects.splice(0)) p.cleanup(); });
class Host extends EventEmitter { readonly pid = 4242; kill() { return true; } }

it("local mode ignores saved release and phone configuration, while keeping checks and review", async () => {
  const p = createE2EProject({ scenario: "happy", approveChecks: true }); projects.push(p);
  // A configuration that would reject an ordinary run if its phone approval adapter were loaded.
  writeFileSync(join(p.jarvisHome, "notify.json"), JSON.stringify({ baseUrl: "https://chatgpt.com", topic: "fake-out", replyTopic: "fake-in" }), { mode: 0o600 });
  saveReleaseSetup(p.projectDir, parseReleaseSetup({ version: 1, provider: "netlify", plan: "free", siteId: "local-proof", productionUrl: "https://example.invalid",
    build: { command: "node build.mjs", output: "dist", timeoutMs: 60_000 } }));
  const notifier = vi.fn(() => { throw new Error("local mode reached notifier"); });
  const provider = vi.fn(() => { throw new Error("local mode reached provider"); });
  const review = vi.fn(async () => "pass" as const);
  const warnings: string[] = [];
  const run = await prepareProductionRun({ projectId: p.projectId, projectDir: p.projectDir, jarvisHome: p.jarvisHome, repoPath: p.repoPath, local: true }, {
    home: p.home, preflight: async () => true, reprobe: async () => true, createReview: () => review, signals: new Host(),
    createNotifier: notifier, release: { cli: { bin: provider } }, warn: (text) => warnings.push(text),
  });
  runs.push(run);
  expect(run.drive).toBeUndefined();
  expect(run.loop.review).toBe(review);
  expect(Object.keys(run.loop.checks).sort()).toEqual(["ac1", "ac2", "ac3", "unit"]);
  await run.loop.notifyBlocked!({ taskId: "T1", reason: "check failed" });
  await run.loop.notify!({ taskId: "T1", waitMs: 7200000, resumeAt: Date.now() + 7200000 });
  await run.close(); await run.finished({ status: "blocked", done: [], blocked: ["T1"] });
  expect(notifier).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  expect(warnings.join("\n")).toMatch(/T1.*check failed/);
});

it("local mode still refuses missing protected-check approval", async () => {
  const p = createE2EProject({ scenario: "happy", approveChecks: false }); projects.push(p);
  await expect(prepareProductionRun({ projectId: p.projectId, projectDir: p.projectDir, jarvisHome: p.jarvisHome, repoPath: p.repoPath, local: true }, { home: p.home }))
    .rejects.toThrow(/checks.*never approved/);
});
