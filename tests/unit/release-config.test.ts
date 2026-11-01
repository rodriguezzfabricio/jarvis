import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { ARTIFACT_TYPE, loadReleaseSetup, parseReleaseSetup, registeredArtifacts, releaseProjectConfig, releaseSetupPath, saveReleaseSetup } from "../../packages/cli/src/release/config.ts";
import { shortTmp } from "../helpers.ts";
import { noAcl } from "./helpers/no-acl.ts";

// Decision 157: the protected release setup owns the destination, the build and the spend policy; nothing in it
// comes from a session. Only each provider's free plan is accepted.
const root = shortTmp("jrc-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const vercel = { version: 1, provider: "vercel", plan: "hobby", siteId: "prj_habits", orgId: "team_fab", productionUrl: "https://habits.example.com",
  build: { command: "npm run build", output: "out" } } as const;
const netlify = { version: 1, provider: "netlify", plan: "free", siteId: "habits-site", productionUrl: "https://habits.netlify.app", build: { command: "npm run build", output: "dist" } } as const;
const project = () => { const dir = join(root, `p${++n}`); mkdirSync(dir, { mode: 0o700 }); return dir; };

describe("release setup", () => {
  it("accepts each provider on its free plan, with a default build timeout", () => {
    expect(parseReleaseSetup(vercel).build.timeoutMs).toBe(600_000);
    expect(parseReleaseSetup(netlify).provider).toBe("netlify");
  });

  it.each([["vercel", "pro"], ["vercel", "enterprise"], ["netlify", "pro"], ["netlify", "business"]] as const)("refuses %s plan %s: it could spend (the spend policy)", (provider, plan) => {
    expect(() => parseReleaseSetup({ ...(provider === "vercel" ? vercel : netlify), plan })).toThrow(/free plan/);
  });

  it.each([
    ["a Vercel site without its account id", { ...vercel, orgId: undefined }],
    ["a Netlify site with an orgId", { ...netlify, orgId: "x" }],
    ["an http origin", { ...vercel, productionUrl: "http://habits.example.com" }],
    ["an origin with a path", { ...vercel, productionUrl: "https://habits.example.com/app" }],
    ["an origin with credentials", { ...vercel, productionUrl: "https://u:p@habits.example.com" }],
    ["an output outside the checkout", { ...vercel, build: { command: "x", output: "../out" } }],
    ["an absolute output", { ...vercel, build: { command: "x", output: "/tmp/out" } }],
    ["a .git output", { ...vercel, build: { command: "x", output: ".git" } }],
    ["a .jarvis output", { ...vercel, build: { command: "x", output: "a/.jarvis" } }],
    ["a relative data source", { ...vercel, data: { kind: "sqlite", source: "data.db" } }],
    ["an unknown field", { ...vercel, token: "nope" }],
  ])("refuses %s", (_name, value) => {
    expect(() => parseReleaseSetup(value)).toThrow();
  });

  it("loads only the runner's own owner-only file; absent means no release", () => {
    const dir = project();
    expect(loadReleaseSetup(dir, { acl: noAcl })).toBeUndefined();
    const path = saveReleaseSetup(dir, parseReleaseSetup(vercel), { acl: noAcl });
    expect(path).toBe(releaseSetupPath(dir));
    const loaded = loadReleaseSetup(dir, { acl: noAcl });
    expect(loaded?.kind === "desktop" ? undefined : loaded?.siteId).toBe("prj_habits");
    chmodSync(path, 0o644);
    expect(() => loadReleaseSetup(dir, { acl: noAcl })).toThrow(/readable only by you/);
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify({ ...vercel, plan: "pro" }), { mode: 0o600 });
    expect(() => loadReleaseSetup(dir, { acl: noAcl })).toThrow(/free plan/);
  });

  it("refuses a symlinked setup file", () => {
    const dir = project();
    const real = join(dir, "elsewhere.json");
    writeFileSync(real, JSON.stringify(vercel), { mode: 0o600 });
    symlinkSync(real, releaseSetupPath(dir));
    expect(() => loadReleaseSetup(dir, { acl: noAcl })).toThrow(/regular file/);
  });

  it("binds artifacts only from the runner's build records, live", () => {
    const dir = project();
    const ledger = Ledger.open(dir);
    const config = releaseProjectConfig(parseReleaseSetup(vercel), { projectDir: dir, workRoot: join(dir, "work"), project: "habits", ledger });
    const revision = "a".repeat(40);
    expect(config.artifacts).toEqual({});
    ledger.append({ kind: "decision", actor: "broker", data: { type: ARTIFACT_TYPE, project: "habits", revision, artifactHash: "b".repeat(64) } });
    ledger.append({ kind: "decision", actor: "runner", data: { type: ARTIFACT_TYPE, project: "other", revision, artifactHash: "c".repeat(64) } });
    expect(config.artifacts).toEqual({});
    ledger.append({ kind: "decision", actor: "runner", data: { type: ARTIFACT_TYPE, project: "habits", revision, artifactHash: "d".repeat(64) } });
    expect(config.artifacts).toEqual({ [revision]: "d".repeat(64) });
    expect(registeredArtifacts(ledger.entries(), "habits")).toEqual({ [revision]: "d".repeat(64) });
    expect(config.privateRoot.startsWith(dir)).toBe(true);
    expect(config.artifactRoot.startsWith(join(dir, "work"))).toBe(true);
  });
});
