import { linkSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { parseReleaseSetup, releaseProjectConfig } from "../../packages/cli/src/release/config.ts";
import { acceptManifest, readShipClaims, shipPrompt } from "../../packages/cli/src/release/ship.ts";
import { shortTmp } from "../helpers.ts";

// Decision 157: the ship session's manifest is a claim. The runner reads one bounded, unlinked file and keeps only
// the fields a session may claim; destinations, the revision, the artifact and any data source come from the runner.
const root = shortTmp("jrs-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const CLAIMS = { smokePaths: ["/", "/health"], rollback: { steps: ["Restore."] }, data: { kind: "none" } };
function workspace(content: string | null = JSON.stringify(CLAIMS)) {
  const ws = join(root, `w${++n}`);
  mkdirSync(join(ws, ".jarvis", "release"), { recursive: true });
  if (content !== null) writeFileSync(join(ws, ".jarvis", "release", "manifest.json"), content);
  return ws;
}
function runner(data?: { kind: "sqlite" | "postgres"; source: string }) {
  const dir = join(root, `r${++n}`); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const setup = parseReleaseSetup({ version: 1, provider: "netlify", plan: "free", siteId: "habits-site", productionUrl: "https://habits.example.com",
    build: { command: "npm run build", output: "out" }, ...(data ? { data } : {}) });
  const config = releaseProjectConfig(setup, { projectDir: dir, workRoot: join(dir, "work"), project: "habits", ledger: Ledger.open(dir) });
  return { dir, setup, config, values: { project: "habits", revision: "a".repeat(40), setup, config, artifactDir: join(dir, "work", "a"), artifactHash: "c".repeat(64) } };
}

describe("the ship session's manifest", () => {
  it("keeps only the claims a session may make; the runner fills the rest", () => {
    const r = runner();
    const claims = readShipClaims(workspace(JSON.stringify({ ...CLAIMS, siteId: "someone-else", productionUrl: "https://elsewhere.example.com", revision: "b".repeat(40), artifactHash: "e".repeat(64) })));
    const manifest = acceptManifest(claims, r.values);
    expect(manifest).toMatchObject({ project: "habits", revision: "a".repeat(40), provider: "netlify", siteId: "habits-site", productionUrl: "https://habits.example.com",
      artifactHash: "c".repeat(64), smokePaths: ["/", "/health"], rollback: { steps: ["Restore."] }, data: { kind: "none" } });
  });

  it.each([
    ["no manifest", null, /wrote no/],
    ["a manifest that isn't JSON", "{", /not JSON/],
    ["a JSON array", "[]", /not a JSON object/],
    ["an oversized manifest", JSON.stringify({ ...CLAIMS, pad: "x".repeat(70_000) }), /over 65536 bytes/],
  ])("refuses %s", (_name, content, reason) => {
    expect(() => readShipClaims(workspace(content))).toThrow(reason);
  });

  it("refuses a manifest that is a symlink or a hard link, which could name a runner file", () => {
    const outside = join(root, `secret${++n}.json`); writeFileSync(outside, JSON.stringify(CLAIMS));
    const linked = workspace(null); symlinkSync(outside, join(linked, ".jarvis", "release", "manifest.json"));
    expect(() => readShipClaims(linked)).toThrow(/regular, unlinked file/);
    const hard = workspace(null); linkSync(outside, join(hard, ".jarvis", "release", "manifest.json"));
    expect(() => readShipClaims(hard)).toThrow(/regular, unlinked file/);
  });

  it("refuses invalid claims, such as an absolute smoke URL", () => {
    const r = runner();
    expect(() => acceptManifest(readShipClaims(workspace(JSON.stringify({ ...CLAIMS, smokePaths: ["https://evil.example.com/"] }))), r.values)).toThrow();
  });

  it("uses a fresh private copy of the runner's configured data source, never a path the session names", () => {
    const source = join(root, `db${++n}.sqlite`); writeFileSync(source, "configured data");
    const r = runner({ kind: "sqlite", source });
    const claims = readShipClaims(workspace(JSON.stringify({ ...CLAIMS, data: { kind: "sqlite", source: "/etc/passwd", commands: { migrate: "m", backup: "b", restore: "r", verify: "v" } } })));
    const manifest = acceptManifest(claims, r.values);
    expect(manifest.data.kind).toBe("sqlite");
    const chosen = (manifest.data as { source: string }).source;
    expect(chosen).not.toBe("/etc/passwd");
    expect(chosen.startsWith(realpathSync(r.config.snapshotRoot) + "/")).toBe(true);
  });

  it("refuses data the setup has no source for, or of another kind", () => {
    const withData = { ...CLAIMS, data: { kind: "postgres", commands: { migrate: "m", backup: "b", restore: "r", verify: "v" } } };
    expect(() => acceptManifest(readShipClaims(workspace(JSON.stringify(withData))), runner().values)).toThrow(/no data snapshot source/);
    const source = join(root, `db${++n}.sqlite`); writeFileSync(source, "x");
    expect(() => acceptManifest(readShipClaims(workspace(JSON.stringify(withData))), runner({ kind: "sqlite", source }).values)).toThrow(/sqlite data/);
  });

  it("tells the session what the runner fills and that it may not deploy", () => {
    const prompt = shipPrompt({ project: "habits", revision: "a".repeat(40), setup: runner().setup, maxTurns: 20 });
    expect(prompt.split("\n")[0]).toBe("Task: ship");
    expect(prompt).toMatch(/Do not deploy, run a provider CLI, call jarvis act/);
    expect(prompt).toContain(".jarvis/notes/ship.md");
  });
});
