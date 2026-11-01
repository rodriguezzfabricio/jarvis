import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { register } from "../../packages/cli/src/commands/release.ts";
import { parseReleaseSetup, saveReleaseSetup } from "../../packages/cli/src/release/config.ts";
import { prepareRelease, runReleaseStep } from "../../packages/cli/src/release/run.ts";
import { releaseStatus } from "../../packages/cli/src/release/states.ts";
import { artifactDigest } from "../../packages/cli/src/release/manifest.ts";
import { renderReport, notifierSummary } from "../../packages/cli/src/runner/report.ts";
import { rebuildState } from "../../packages/cli/src/runner/state.ts";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { installDesktopChecks } from "../../packages/cli/src/lanes/desktop.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { DEFAULT_ROUTING } from "../../packages/cli/src/runner/routing.ts";
import { doneTask, gateEntry, REVISION } from "./helpers/release-fixture.ts";
import { shortTmp } from "../helpers.ts";

const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const root = shortTmp("jrd-"); let count = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));
const setup = { version: 1, kind: "desktop", appName: "Matches", bundle: "Matches.app", build: { command: "node build.mjs", output: "target", timeoutMs: 1000 } } as const;
const plan = { nodeBin: process.execPath, tauriBin: "/bin/sh", build: { bin: "/bin/sh", args: ["-c", setup.build.command] }, bundle: "target/Matches.app", stayUpMs: 1000, shutdownMs: 1000, buildTimeoutMs: 1000 };

it("accepts a protected desktop setup without any provider or token; refuses escaping bundle paths and deploy fields", () => {
  expect(parseReleaseSetup(setup)).toMatchObject(setup);
  for (const extra of [{ bundle: "../Matches.app" }, { bundle: "/tmp/Matches.app" }, { bundle: "x/.git/Matches.app" }, { bundle: "Matches" }, { provider: "netlify" }, { token: "fake" }, { appName: "bad\nname" }]) {
    expect(() => parseReleaseSetup({ ...setup, ...extra })).toThrow();
  }
});

it("configure installs a locked desktop plan and reports a build-only destination without requesting a provider", async () => {
  const home = join(root, `cli-${++count}`); const out: string[] = [];
  const cli = new Command().exitOverride(); register(cli, { jarvisHome: home, env: { JARVIS_PROJECT: "matches" }, cwd: root, output: t => out.push(t) });
  const args = ["release", "configure", "--kind", "desktop", "--app-name", "Matches", "--bundle", "Matches.app", "--build", "node build.mjs", "--output", "target"];
  await cli.parseAsync(args, { from: "user" });
  const dir = join(home, "projects", "matches"); const ledger = Ledger.open(dir); const store = new ChecksStore(dir);
  expect(store.verify(ledger).ok).toBe(true);
  expect(JSON.parse(readFileSync(join(store.checksDir, "desktop/plan.json"), "utf8"))).toMatchObject({ bundle: "target/Matches.app", build: { bin: "/bin/sh", args: ["-c", "node build.mjs"] } });
  expect(out.join("\n")).toContain("built, not distributed"); expect(out.join("\n")).not.toContain("TOKEN");
  writeFileSync(join(store.checksDir, "desktop/plan.json"), "{}");
  await expect(cli.parseAsync(args, { from: "user" })).rejects.toThrow(/protected check|approved|changed/);
});

async function release(options: { failed?: string; omitted?: string; head?: string; noTasks?: boolean; tamperPlan?: boolean; changedSetup?: boolean; badCopy?: boolean; tamperCapture?: boolean; looseRoot?: boolean } = {}) {
  const projectDir = join(root, `project-${++count}`); mkdirSync(projectDir, { mode: 0o700 });
  // A pre-existing artifacts folder others can write is not a place for the deliverable.
  if (options.looseRoot) { const { chmodSync } = await import("node:fs"); mkdirSync(join(projectDir, "artifacts")); chmodSync(join(projectDir, "artifacts"), 0o777); }
  const ledger = Ledger.open(projectDir); const store = new ChecksStore(projectDir); installDesktopChecks(store, plan); store.approve(ledger, "reviewed");
  if (!options.noTasks) doneTask(ledger, "T1", ["unit", "acceptance"]);
  // Release gates use the real approved lock; task fixtures carry their own verified evidence.
  const lock = store.approve(ledger, "reviewed release").lockHash;
  saveReleaseSetup(projectDir, parseReleaseSetup(options.changedSetup ? { ...setup, build: { ...setup.build, command: "exit 0" } } : setup));
  if (options.tamperPlan) writeFileSync(join(store.checksDir, "desktop/plan.json"), "{}");
  const provider = vi.fn(async () => { throw new Error("desktop may not invoke a provider"); });
  const host = { projectId: "matches", projectDir, workRoot: root, worktreeRoot: root, repoPath: root, home: root, ledger };
  const runtime = (await prepareRelease(host, { run: provider }))!;
  const checks = ["unit", "acceptance"].filter(n => n !== options.omitted).map(name => ({ name, cases: [{ id: "c", command: "true" }], verify: "true", timeoutMs: 1000 }));
  const seen: string[] = [];
  const outcome = await runReleaseStep({ ...host, runtime, jarvisHome: root, gitHome: root, runBranch: "main", git: () => options.head ?? REVISION,
    broker: { handle: provider }, checks, harness: { runTask: provider }, routing: DEFAULT_ROUTING, tier: 1, maxTurns: 1, timeoutMs: 1000,
    seams: { gate: async g => { seen.push(g.check.name); const entry = gateEntry(ledger, g.check.name, { checksLock: lock, status: options.failed === g.check.name ? "fail" : "pass" }); return { status: options.failed === g.check.name ? "fail" : "pass", entry, evidenceDir: projectDir }; },
      desktop: { platform: "darwin", exists: () => true, gate: async g => {
        seen.push(g.check.name);
        const checkout = join(projectDir, "fake-checkout"); const bundle = join(checkout, plan.bundle);
        mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true }); writeFileSync(join(bundle, "Contents/Info.plist"), "fake plist"); writeFileSync(join(bundle, "Contents/MacOS/Matches"), "fake binary", { mode: 0o755 });
        if (options.badCopy) { const { symlinkSync } = await import("node:fs"); symlinkSync(join(projectDir, "release.json"), join(bundle, "secret")); }
        try { await g.afterCases(checkout); } finally { rmSync(checkout, { recursive: true, force: true }); }
        if (options.tamperCapture) {
          const capture = readdirSync(root).find(n => n.startsWith("native-smoke-"))!;
          writeFileSync(join(root, capture, "Matches.app/Contents/MacOS/Matches"), "changed after capture");
        }
        const entry = gateEntry(ledger, "desktop-build", { checksLock: lock, status: options.failed === "desktop-build" ? "fail" : "pass" });
        return { status: options.failed === "desktop-build" ? "fail" : "pass", entry, evidenceDir: projectDir };
      } },
    } });
  const entries = ledger.entries();
  return { projectDir, ledger, runtime, outcome, seen, provider, status: releaseStatus(entries), report: renderReport(rebuildState(entries, { now: Date.now() }), entries) };
}

it("exports a built bundle durably with its hash, reruns every check on the release revision, and never deploys or launches", async () => {
  const r = await release(); expect(r.outcome).toMatchObject({ status: "built" }); expect(r.status.current?.state).toBe("built");
  expect(r.seen).toEqual(["desktop-build", "unit", "acceptance"]); expect(r.runtime.adapters).toEqual([]); expect(r.provider).not.toHaveBeenCalled();
  const record = r.ledger.entries().find(e => e.kind === "decision" && (e.data as { type?: string }).type === "release.desktop-artifact")!.data as { bundlePath: string; artifactHash: string; revision: string };
  expect(record.bundlePath.startsWith(join(r.projectDir, "artifacts") + "/")).toBe(true); expect(existsSync(record.bundlePath)).toBe(true);
  expect(record.artifactHash).toBe(artifactDigest(record.bundlePath)); expect(record.revision).toBe(REVISION);
  for (const text of [r.report, notifierSummary(rebuildState(r.ledger.entries(), { now: Date.now() }), r.ledger.entries())]) {
    expect(text).toContain("built, not distributed"); expect(text).toContain(record.bundlePath); expect(text).toContain(record.artifactHash); expect(text).toMatch(/native smoke: not run.*input isolation/i);
  }
  writeFileSync(join(record.bundlePath, "Contents/MacOS/Matches"), "tampered");
  expect(releaseStatus(r.ledger.entries()).current).toBeUndefined();
  expect(renderReport(rebuildState(r.ledger.entries(), { now: Date.now() }), r.ledger.entries())).toMatch(/Lapsed: built.*artifact/);
});

it.each([{ failed: "unit" }, { failed: "desktop-build" }, { omitted: "acceptance" }, { head: "b".repeat(40) }, { noTasks: true }, { tamperPlan: true }, { changedSetup: true }, { badCopy: true }, { tamperCapture: true }, { looseRoot: true }])("refuses built for incomplete or mismatched evidence: %j", async options => {
  const r = await release(options); expect(r.outcome.status).toBe("stopped"); expect(r.status.current).toBeUndefined(); expect(r.provider).not.toHaveBeenCalled();
  if ("failed" in options && options.failed === "desktop-build") expect(r.ledger.entries().some(e => (e.data as { type?: string }).type === "release.desktop-artifact")).toBe(false);
});

it("a later failed check, edited evidence or an altered executable mode invalidates built at render time", async () => {
  for (const change of ["check", "evidence", "mode", "task", "promotion", "link"] as const) {
    const r = await release(); expect(r.status.current?.state).toBe("built");
    if (change === "link") {
      // The recorded path must be the bundle's real path: a link anywhere above it could show another tree.
      const { renameSync, symlinkSync } = await import("node:fs"); const artifacts = join(r.projectDir, "artifacts");
      renameSync(artifacts, `${artifacts}-moved`); symlinkSync(`${artifacts}-moved`, artifacts);
    }
    if (change === "task") r.ledger.append({ kind: "task_created", actor: "runner", task_id: "T2", data: { title: "new work", requiredChecks: ["unit"], requiredReviews: ["code"] } });
    if (change === "promotion") doneTask(r.ledger, "T2", ["unit"], ["code"], "b".repeat(40));
    if (change === "check") gateEntry(r.ledger, "unit", { status: "fail" });
    if (change === "evidence") {
      const e = r.ledger.entries().filter(e => e.kind === "gate_result" && e.task_id === null).at(-1)!;
      const evidence = (e.data as { evidence: { dir: string } }).evidence; writeFileSync(join(evidence.dir, "stdout"), "edited");
    }
    if (change === "mode") {
      const { chmodSync } = await import("node:fs"); const artifact = r.ledger.entries().find(e => (e.data as { type?: string }).type === "release.desktop-artifact")!;
      chmodSync(join((artifact.data as { bundlePath: string }).bundlePath, "Contents/MacOS/Matches"), 0o600);
    }
    expect(releaseStatus(r.ledger.entries()).current).toBeUndefined();
  }
});

it("configure refuses to approve an edited existing check when no desktop plan has been installed", async () => {
  const home = join(root, `untrusted-${++count}`); const dir = join(home, "projects", "matches"); mkdirSync(join(dir, "checks"), { recursive: true, mode: 0o700 });
  const ledger = Ledger.open(dir); const store = new ChecksStore(dir); const check = join(store.checksDir, "existing.txt");
  writeFileSync(check, "approved"); store.approve(ledger, "original review"); writeFileSync(check, "changed");
  const cli = new Command().exitOverride(); register(cli, { jarvisHome: home, env: { JARVIS_PROJECT: "matches" }, cwd: root, output: () => {} });
  await expect(cli.parseAsync(["release", "configure", "--kind", "desktop", "--app-name", "Matches", "--bundle", "Matches.app"], { from: "user" })).rejects.toThrow(/protected check changed/);
  expect(store.verify(ledger).ok).toBe(false); expect(existsSync(join(store.checksDir, "desktop"))).toBe(false);
});

it("configure never blesses check files that were never approved: a store without a lock must be empty", async () => {
  const home = join(root, `unapproved-${++count}`); const dir = join(home, "projects", "matches"); const store = new ChecksStore(dir);
  mkdirSync(store.checksDir, { recursive: true, mode: 0o700 }); writeFileSync(join(store.checksDir, "sneaked.json"), JSON.stringify({ name: "sneaked", cases: [], verify: "true" }));
  const cli = new Command().exitOverride(); register(cli, { jarvisHome: home, env: { JARVIS_PROJECT: "matches" }, cwd: root, output: () => {} });
  await expect(cli.parseAsync(["release", "configure", "--kind", "desktop", "--app-name", "Matches", "--bundle", "Matches.app"], { from: "user" })).rejects.toThrow(/never approved/);
  expect(existsSync(store.lockPath)).toBe(false); expect(existsSync(join(store.checksDir, "desktop"))).toBe(false);
  expect(Ledger.open(dir).entries().some(e => e.kind === "checks_approved")).toBe(false);
});

it("keeps a verified export when a later required check fails, without calling it built", async () => {
  const r = await release({ failed: "unit" });
  expect(r.outcome.status).toBe("stopped"); expect(r.status.current).toBeUndefined();
  const artifact = r.ledger.entries().find(e => (e.data as { type?: string }).type === "release.desktop-artifact")!.data as { bundlePath: string; artifactHash: string };
  expect(existsSync(artifact.bundlePath)).toBe(true);
  expect(artifactDigest(artifact.bundlePath)).toBe(artifact.artifactHash);
});
