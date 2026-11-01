import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectBroker } from "../../packages/cli/src/broker/host.ts";
import { prepareProductionRun } from "../../packages/cli/src/commands/run-compose.ts";
import { register } from "../../packages/cli/src/commands/run.ts";
import type { Message, Notifier } from "../../packages/cli/src/notify/notifier.ts";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { latestAccepted } from "../../packages/cli/src/release/accepted.ts";
import { parseReleaseSetup, saveReleaseSetup } from "../../packages/cli/src/release/config.ts";
import { manifestHash, releaseRef } from "../../packages/cli/src/release/manifest.ts";
import { prepareRelease, type ReleaseSeams } from "../../packages/cli/src/release/run.ts";
import { runSmoke } from "../../packages/cli/src/release/smoke.ts";
import { missingEvidence, releaseStatus } from "../../packages/cli/src/release/states.ts";
import type { ReleaseEvidence } from "../../packages/cli/src/release/types.ts";
import { renderReport } from "../../packages/cli/src/runner/report.ts";
import { rebuildState } from "../../packages/cli/src/runner/state.ts";
import { createE2EProject, expectRunSound, expectTaskDone, fileAt, lastGreen, sessionCalls, seedTasks, type E2EProject } from "./e2e-helpers.ts";

// Stage 5's proof, on fakes (decision 157): a task 11-shaped run ("Build me a habit tracker": a new web product whose
// plan is done) goes through the production composition to preview-ready on a free-tier preview, with production
// gated. Fake claude acts out the build and ship sessions; a fake provider CLI (a node script at the pinned path)
// stands in for Netlify, and a fake fetch serves what it "deployed". No real provider, network or credential: the
// tokens are random fake values. The release gates and the build run in the real sandbox.
const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const projects: E2EProject[] = [];
afterEach(() => projects.splice(0).forEach((p) => p.cleanup()));

const SESSIONS = [
  { name: "T1-good", task: "T1", steps: [
    { write: "src/multiply.mjs", lines: ["/** Returns the product of two numbers. */", "export function multiply(a, b) {", "  return a * b;", "}"] },
    { notes: "Added multiply." } ] },
  { name: "T2-good", task: "T2", steps: [
    { write: "src/clamp.mjs", lines: ["/** Returns x limited to the range [lo, hi]. */", "export function clamp(x, lo, hi) {", "  return Math.min(hi, Math.max(lo, x));", "}"] },
    { notes: "Added clamp." } ] },
  { name: "ship", task: "ship", steps: [
    // The session also names a site, an origin and an artifact: claims the runner must ignore.
    { write: ".jarvis/release/manifest.json", content: JSON.stringify({ smokePaths: ["/", "/health"], migrations: [], data: { kind: "none" },
      rollback: { steps: ["Restore the previous deploy in Netlify; check /health returns ok."] }, siteId: "someone-elses-site", productionUrl: "https://elsewhere.example.com", artifactDir: "/tmp/elsewhere" }) },
    { write: "src/stray.mjs", content: "export const stray = 1;\n" },
    { notes: "Manifest written: smoke / and /health; no persistent data." } ] },
];
const SITE = "habits-site";
const BUILD = "mkdir -p site && printf '<!doctype html><title>Habit tracker</title><h1>Habits</h1>\\n' > site/index.html && printf 'ok\\n' > site/health && cp src/*.mjs site/";

interface Release { p: E2EProject; sent: Message[]; output: string[]; calls: () => { args: string[]; token: string | null }[]; served: string; tokens: { preview: string; production: string }; seams: ReleaseSeams }
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A fake Netlify CLI at an absolute path outside every session-writable folder; it logs only a hash of the token it got.
 * Its launcher is npm's `#!/usr/bin/env node`, which finds no node under the adapters' PATH, so it runs only when the
 * release step and the adapters start it through the pinned Node (decision 161).
 */
function fakeProvider(root: string): { bin: string; served: string; log: string } {
  const dir = join(root, "provider"); const served = join(dir, "served"); const log = join(dir, "calls.jsonl");
  mkdirSync(served, { recursive: true, mode: 0o755 });
  const bin = join(dir, "netlify");
  writeFileSync(bin, `#!/usr/bin/env node
const { appendFileSync, cpSync, readdirSync } = require("node:fs"); const { createHash } = require("node:crypto");
const args = process.argv.slice(2); const token = process.env.NETLIFY_AUTH_TOKEN;
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, token: token ? createHash("sha256").update(token).digest("hex") : null }) + "\\n");
if (args[0] === "--version") { console.log("netlify-cli/99.1.0 darwin-arm64 node-v24"); process.exit(0); }
if (args[0] === "deploy") {
  const n = readdirSync(${JSON.stringify(served)}).length + 1;
  cpSync(args[args.indexOf("--dir") + 1], ${JSON.stringify(served)} + "/" + n, { recursive: true });
  console.log(JSON.stringify({ deploy_url: "https://deploy-" + n + "--habits.netlify.app", site_id: args[args.indexOf("--site") + 1] }));
  process.exit(0);
}
process.exit(9);
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { bin, served, log };
}

/** Serves https://deploy-<n>--habits.netlify.app/<path> from what the fake provider copied; `fail` answers 500 there. */
function fakeFetch(served: string, fail?: string): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const m = /^deploy-(\d+)--habits\.netlify\.app$/.exec(url.hostname);
    if (!m || url.protocol !== "https:") return new Response("no such host", { status: 502 });
    if (fail && url.pathname === fail) return new Response("broken", { status: 500 });
    const file = join(served, m[1]!, url.pathname === "/" ? "index.html" : url.pathname);
    return existsSync(file) && statSync(file).isFile() ? new Response(readFileSync(file), { status: 200 }) : new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

async function runRelease(options: { failSmoke?: string } = {}): Promise<Release> {
  const p = createE2EProject({ scenario: { description: "task 11 shape: the plan's tasks, then the ship session", sessions: SESSIONS }, projectId: "habits" }); projects.push(p);
  seedTasks(p);
  writeFileSync(join(p.jarvisHome, "notify.json"), JSON.stringify({ baseUrl: "https://example.invalid", topic: "fake-out", replyTopic: "fake-in" }), { mode: 0o600 });
  saveReleaseSetup(p.projectDir, parseReleaseSetup({ version: 1, provider: "netlify", plan: "free", siteId: SITE, productionUrl: "https://habits.example.com",
    build: { command: BUILD, output: "site", timeoutMs: 60_000 } }));
  const tokens = { preview: `fake-preview-${randomUUID()}`, production: `fake-production-${randomUUID()}` };
  mkdirSync(join(p.jarvisHome, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(p.jarvisHome, "secrets", "house-stack.accounts.env"), `NETLIFY_PREVIEW_TOKEN=${tokens.preview}\nNETLIFY_PRODUCTION_TOKEN=${tokens.production}\n`, { mode: 0o600 });
  const provider = fakeProvider(p.root);
  const seams: ReleaseSeams = { cli: { pins: { netlify: { version: "99.1.0" } }, bin: () => provider.bin }, fetch: fakeFetch(provider.served, options.failSmoke) };
  const sent: Message[] = []; const output: string[] = [];
  const notifier: Notifier = { send: async (m) => { sent.push(m); }, poll: async () => [] };
  const program = new Command().exitOverride();
  register(program, {
    jarvisHome: p.jarvisHome, cwd: p.repoPath, env: { JARVIS_PROJECT: p.projectId }, output: (t) => output.push(t), keepAwake: () => {}, probe: async () => ({ ok: true }),
    prepareRun: (context) => prepareProductionRun(context, {
      home: p.home, preflight: async () => true, reprobe: async () => true, createReview: () => async () => "pass", createNotifier: () => notifier, warn: () => {},
      harness: { binaryRealpath: () => p.claudeBin, session: (spec) => runSession({ ...spec, bin: p.claudeBin }), parentEnv: { HOME: p.home, USER: "e2e", LANG: "en_US.UTF-8" } },
      release: seams,
    }),
  });
  await program.parseAsync(["run"], { from: "user" });
  const calls = () => existsSync(provider.log) ? readFileSync(provider.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; token: string | null }) : [];
  return { p, sent, output, calls, served: provider.served, tokens, seams };
}

/** Every file under the test root except the secrets file holds neither fake token. */
function expectTokensContained(r: Release): void {
  const secrets = join(r.p.jarvisHome, "secrets", "house-stack.accounts.env");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? walk(path) : e.isFile() && path !== secrets ? [path] : [];
  });
  for (const file of walk(r.p.root)) {
    const text = readFileSync(file).toString("latin1");
    expect(text.includes(r.tokens.preview) || text.includes(r.tokens.production), `a fake token reached ${file}`).toBe(false);
  }
}

describe("e2e: golden task 11's release path on a fake provider", { timeout: 600_000 }, () => {
  it("reaches preview-ready on the free-tier preview, keeps production gated, and un-readies on a later failed smoke", async () => {
    const r = await runRelease();
    const { p } = r;
    expect(r.output).toEqual(["Run complete: 2 done, 0 blocked"]);
    expectTaskDone(p, "T1"); expectTaskDone(p, "T2");
    expectRunSound(p);
    expect(sessionCalls(p).map((c) => c.session)).toEqual(["T1-good", "T2-good", "ship"]);
    const ship = sessionCalls(p).find((c) => c.session === "ship")!;
    expect(ship.envelope).toEqual([]);

    // The release state holds now, on the revision the runner last promoted, with the broker's preview URL.
    const entries = p.ledger.entries();
    const status = releaseStatus(entries);
    expect(status.current).toMatchObject({ state: "preview-ready", previewUrl: "https://deploy-1--habits.netlify.app", productionGranted: false });
    const manifest = status.current!.manifest;
    expect(manifest.revision).toBe(lastGreen(p));
    // Runner values replaced the session's destination and artifact claims; the claims a session may make were kept.
    expect(manifest).toMatchObject({ project: "habits", provider: "netlify", siteId: SITE, productionUrl: "https://habits.example.com", smokePaths: ["/", "/health"], data: { kind: "none" } });
    expect(manifest.artifactDir.startsWith(join(p.home, ".jarvis-work", "release", "habits", "artifacts") + "/")).toBe(true);
    expect(latestAccepted(entries)?.manifest).toEqual(manifest);
    // Every approved check ran on the release revision, bound to no task, and passed.
    const releaseGates = entries.filter((e) => e.kind === "gate_result" && e.task_id === null && (e.data as { revision: string }).revision === manifest.revision && !(e.data as { check: string }).check.startsWith("release."));
    expect(releaseGates.map((e) => [(e.data as { check: string }).check, (e.data as { status: string }).status]).sort()).toEqual([["ac1", "pass"], ["ac2", "pass"], ["ac3", "pass"], ["unit", "pass"]]);
    // The ship session's other edit was discarded: it is on no revision.
    expect(fileAt(p, lastGreen(p)!, "src/stray.mjs")).toBeNull();

    // The provider saw one preview deploy of the runner's private, stamped copy, with the preview token only.
    const deploys = r.calls().filter((c) => c.args[0] === "deploy");
    expect(deploys).toHaveLength(1);
    // The adapters' fixed tree: --dir is its public/ folder and --config the runner's own netlify.toml (decision 161).
    expect(deploys[0]!.args.filter((a) => !a.startsWith("/"))).toEqual(["deploy", "--no-build", "--dir", "--config", "--site", SITE, "--json"]);
    expect(deploys[0]!.args[deploys[0]!.args.indexOf("--dir") + 1]).toMatch(/\/public$/);
    expect(deploys[0]!.args[deploys[0]!.args.indexOf("--config") + 1]).toMatch(/\/netlify\.toml$/);
    expect(r.calls().filter((c) => c.args[0] === "--version").every((c) => c.token === null)).toBe(true);
    expect(deploys[0]!.token).toBe(sha(r.tokens.preview));
    expect(r.calls().some((c) => c.args.includes("--prod") || c.args.includes("getSite") || c.token === sha(r.tokens.production))).toBe(false);
    expect(readFileSync(join(r.served, "1", ".well-known", "jarvis-release"), "utf8").trim()).toBe(manifestHash(manifest));
    expect(readFileSync(join(r.served, "1", "health"), "utf8")).toBe("ok\n");

    // REPORT.md and the finished notification say preview-ready, the URL, and that production is gated.
    const report = readFileSync(join(p.repoPath, ".jarvis", "REPORT.md"), "utf8");
    expect(report).toContain("State: preview-ready");
    expect(report).toContain("Preview: https://deploy-1--habits.netlify.app");
    expect(report).toContain(`Production: gated; no grant is bound to manifest ${manifestHash(manifest)}`);
    const finished = r.sent.filter((m) => m.kind === "finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.text).toMatch(/preview-ready at https:\/\/deploy-1--habits\.netlify\.app; production gated/);

    // Production is refused without a grant bound to this manifest: the broker asks a person, and even an approved
    // exact payload doesn't satisfy the adapter, which never reaches the provider. Deployed is never reached.
    const release = (await prepareRelease({ projectId: p.projectId, projectDir: p.projectDir, workRoot: join(p.home, ".jarvis-work"), worktreeRoot: join(p.home, ".jarvis-work", "worktrees"),
      repoPath: p.repoPath, home: p.home, ledger: p.ledger }, r.seams))!;
    const broker = projectBroker({ jarvisHome: p.jarvisHome, projectDir: p.projectDir, project: p.projectId, ledger: p.ledger, deploy: release.adapters });
    const promote = { op: "deploy.promote" as const, payload: { ref: releaseRef(manifest, "promote") } };
    const asked = await broker.handle(promote);
    expect(asked.status).toBe("pending");
    broker.decide(asked.approvalId!, "approve", "e2e");
    const refused = await broker.handle(promote);
    expect(refused.status).toBe("failed");
    expect(r.calls().some((c) => c.args.includes("--prod") || c.args.includes("getSite"))).toBe(false);
    expect(missingEvidence({ ledger: p.ledger, manifest, state: "deployed", evidence: (status.current!.entry.data as { evidence: ReleaseEvidence }).evidence })).toEqual(expect.arrayContaining(["production", "smoke", "failureSignal"]));

    // A later failed smoke test of the same preview un-readies it in every rendering.
    const receipt = (status.current!.entry.data as { evidence: { previewDeploy: number } }).evidence.previewDeploy;
    const smoke = await runSmoke({ ledger: p.ledger, manifest, projectConfig: release.config, deploymentSeq: receipt, fetch: fakeFetch(r.served, "/health"), retries: 0 });
    expect((smoke.data as { status: string }).status).toBe("fail");
    const later = p.ledger.entries();
    expect(releaseStatus(later).current).toBeUndefined();
    expect(renderReport(rebuildState(later, { now: Date.now() }), later)).toMatch(/State: not-reached[\s\S]*Lapsed: preview-ready \(#\d+\) no longer holds; missing previewSmoke/);

    expectTokensContained(r);
  });

  it("stays not ready when the preview's smoke test fails, and says so in the report and on the phone", async () => {
    const r = await runRelease({ failSmoke: "/health" });
    const { p } = r;
    expect(r.output).toEqual(["Run complete: 2 done, 0 blocked"]);
    const entries = p.ledger.entries();
    expect(releaseStatus(entries).current).toBeUndefined();
    expect(entries.some((e) => e.kind === "state_reached" && (e.data as { state: string }).state === "preview-ready")).toBe(false);
    const report = readFileSync(join(p.repoPath, ".jarvis", "REPORT.md"), "utf8");
    expect(report).toContain("State: not-reached");
    expect(report).toContain("Release step: stopped: the preview smoke test failed at https://deploy-1--habits.netlify.app");
    expect(r.sent.some((m) => m.kind === "blocked" && /Preview smoke failed/.test(m.text))).toBe(true);
    expect(r.sent.find((m) => m.kind === "finished")!.text).toMatch(/not-reached/);
    expectTokensContained(r);
  });
});

