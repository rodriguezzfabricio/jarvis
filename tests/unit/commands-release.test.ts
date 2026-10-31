import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { register } from "../../packages/cli/src/commands/release.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { recordAcceptedManifest } from "../../packages/cli/src/release/accepted.ts";
import { hasReleaseGrant } from "../../packages/cli/src/release/grants.ts";
import { manifestHash } from "../../packages/cli/src/release/manifest.ts";
import { shortTmp } from "../helpers.ts";
import { noAcl } from "./helpers/no-acl.ts";
import { releaseManifest } from "./helpers/release-fixture.ts";

// `jarvis release` (decisions 157, 130): configure writes the protected setup; grant shows the exact accepted
// manifest and records a grant bound to it, with its rollback scope, only after a yes.
const { Command } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("commander") as { Command: new () => Parameters<typeof register>[0] };
const root = shortTmp("jcr-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function cli(answers: string[] = [], tty = true) {
  const jarvisHome = join(root, `h${++n}`); mkdirSync(jarvisHome, { mode: 0o700 });
  const out: string[] = []; const prompts: string[] = [];
  const program = new Command().exitOverride();
  register(program, { jarvisHome, cwd: root, env: { JARVIS_PROJECT: "p" }, output: (t) => out.push(t), isTTY: () => tty, by: "tester",
    confirm: async (prompt) => { prompts.push(prompt); return answers.shift() ?? ""; }, trust: { acl: noAcl } });
  const projectDir = join(jarvisHome, "projects", "p");
  return { jarvisHome, projectDir, out, prompts, run: (...args: string[]) => program.parseAsync(args, { from: "user" }) };
}
function accepted(c: ReturnType<typeof cli>) {
  mkdirSync(c.projectDir, { recursive: true, mode: 0o700 });
  const ledger = Ledger.open(c.projectDir);
  const manifest = releaseManifest();
  recordAcceptedManifest(ledger, manifest);
  return { ledger, manifest, hash: manifestHash(manifest) };
}

describe("jarvis release configure", () => {
  it("writes the owner-only setup on the free plan by default", async () => {
    const c = cli();
    await c.run("release", "configure", "--provider", "vercel", "--site", "prj_habits", "--org", "team_fab", "--url", "https://habits.example.com", "--output", "dist");
    const path = join(c.projectDir, "release.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ provider: "vercel", plan: "hobby", siteId: "prj_habits", orgId: "team_fab", build: { command: "npm run build", output: "dist" } });
    expect(c.out.join("\n")).toContain("VERCEL_PREVIEW_TOKEN and VERCEL_PRODUCTION_TOKEN");
  });

  it("refuses a paid plan", async () => {
    const c = cli();
    await expect(c.run("release", "configure", "--provider", "netlify", "--site", "s", "--url", "https://x.netlify.app", "--plan", "pro")).rejects.toThrow(/free plan/);
  });
});

describe("jarvis release grant", () => {
  it("shows the exact manifest and its rollback scope, then records a grant bound to it", async () => {
    const c = cli(["y"]);
    const a = accepted(c);
    await c.run("release", "grant", a.hash);
    const shown = c.out.join("\n");
    expect(shown).toContain(`Manifest hash: ${a.hash}`);
    expect(shown).toContain('"siteId": "site"');
    expect(shown).toContain("Rollback: manual");
    expect(c.prompts).toEqual(["Grant production for this manifest? [y/N] "]);
    expect(hasReleaseGrant(a.ledger, a.manifest)).toBe(true);
    expect(hasReleaseGrant(a.ledger, a.manifest, true)).toBe(false);
    expect(a.ledger.entries().filter((e) => e.kind === "grant").map((e) => e.data)).toEqual([{ op: "deploy.promote", scope: { project: "p", manifestHash: a.hash, allowRollback: false }, by: "tester" }]);
  });

  it("records the automatic rollback scope only when asked", async () => {
    const c = cli(["yes"]);
    const a = accepted(c);
    await c.run("release", "grant", a.hash, "--allow-rollback");
    expect(c.out.join("\n")).toContain("Rollback: automatic");
    expect(hasReleaseGrant(a.ledger, a.manifest, true)).toBe(true);
  });

  it("records nothing without a yes, without a TTY unless --yes, or for a manifest the runner never accepted", async () => {
    const c = cli(["n"]);
    const a = accepted(c);
    await c.run("release", "grant", a.hash);
    expect(c.out.at(-1)).toBe("No grant recorded.");
    const quiet = cli([], false);
    const b = accepted(quiet);
    await expect(quiet.run("release", "grant", b.hash)).rejects.toThrow(/requires --yes/);
    await expect(quiet.run("release", "grant", "e".repeat(64), "--yes")).rejects.toThrow(/No manifest/);
    expect([...a.ledger.entries(), ...b.ledger.entries()].filter((e) => e.kind === "grant")).toEqual([]);
    await quiet.run("release", "grant", b.hash, "--yes");
    expect(hasReleaseGrant(b.ledger, b.manifest)).toBe(true);
  });

  it("show names the state and the grant command", async () => {
    const c = cli();
    const a = accepted(c);
    await c.run("release", "show");
    expect(c.out.join("\n")).toContain(`Latest accepted manifest: ${a.hash}`);
    expect(c.out.join("\n")).toContain("State: not-reached");
  });
});
