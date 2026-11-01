import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { shortTmp } from "../helpers.ts";

const root = shortTmp("deps-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
function fixture(manager = "npm") {
  const dir = join(root, String(++serial)); mkdirSync(dir);
  const manifest = { name: "tiny", version: "1.0.0", packageManager: `${manager}@${manager === "npm" ? "11.19.0" : "11.7.0"}`, devDependencies: { vite: "1.0.0" } };
  const lock = { lockfileVersion: 3, packages: { "": { name: "tiny", version: "1.0.0", devDependencies: { vite: "1.0.0" } }, "node_modules/vite": { version: "1.0.0", resolved: "https://registry.npmjs.org/vite/-/vite-1.0.0.tgz", integrity } } };
  const yaml = `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      vite:\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  vite@1.0.0:\n    resolution: {integrity: ${integrity}}\nsnapshots:\n  vite@1.0.0: {}\n`;
  const write = () => { writeFileSync(join(dir, "package.json"), JSON.stringify(manifest)); writeFileSync(join(dir, manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml"), manager === "npm" ? JSON.stringify(lock) : yaml); };
  write(); return { dir, manifest, lock, yaml, write };
}
async function inspect(dir: string) { return (await import("../../packages/cli/src/release/deps-lock.ts")).readDependencyPlan(dir); }

describe("release dependency inputs", () => {
  it.each(["npm", "pnpm"])("accepts a registry-only %s lock", async manager => {
    const f = fixture(manager);
    expect(await inspect(f.dir)).toMatchObject({ manager, version: manager === "npm" ? "11.19.0" : "11.7.0" });
  });
  it("leaves a non-Node project alone", async () => {
    const dir = join(root, String(++serial)); mkdirSync(dir); expect(await inspect(dir)).toBeUndefined();
  });
  it.each([
    ["no lockfile", (f: ReturnType<typeof fixture>) => rmSync(join(f.dir, "package-lock.json")), /lockfile/],
    ["wrong manager", (f: ReturnType<typeof fixture>) => { f.manifest.packageManager = "pnpm@11.7.0"; f.write(); }, /lockfile/],
    ["no declaration", (f: ReturnType<typeof fixture>) => { f.manifest.packageManager = ""; f.write(); }, /packageManager/],
    ["git dependency", (f: ReturnType<typeof fixture>) => { f.manifest.devDependencies.vite = "git+https://github.com/a/b.git"; f.write(); }, /registry/],
    ["tarball dependency", (f: ReturnType<typeof fixture>) => { f.manifest.devDependencies.vite = "https://registry.npmjs.org/vite/-/vite-1.0.0.tgz"; f.write(); }, /registry/],
    ["file dependency", (f: ReturnType<typeof fixture>) => { f.manifest.devDependencies.vite = "file:../outside"; f.write(); }, /registry/],
    ["link dependency", (f: ReturnType<typeof fixture>) => { f.manifest.devDependencies.vite = "link:../outside"; f.write(); }, /registry/],
    ["other registry", (f: ReturnType<typeof fixture>) => { f.lock.packages["node_modules/vite"].resolved = "https://evil.example/vite/-/vite-1.0.0.tgz"; f.write(); }, /registry/],
    ["loopback registry", (f: ReturnType<typeof fixture>) => { f.lock.packages["node_modules/vite"].resolved = "http://127.0.0.1/vite.tgz"; f.write(); }, /registry/],
    ["arbitrary tarball", (f: ReturnType<typeof fixture>) => { f.lock.packages["node_modules/vite"].resolved = "https://registry.npmjs.org/other.tgz"; f.write(); }, /registry/],
    ["credential URL", (f: ReturnType<typeof fixture>) => { f.lock.packages["node_modules/vite"].resolved = "https://dummy@registry.npmjs.org/vite/-/vite-1.0.0.tgz"; f.write(); }, /registry/],
    ["missing integrity", (f: ReturnType<typeof fixture>) => { f.lock.packages["node_modules/vite"].integrity = ""; f.write(); }, /integrity/],
    ["scripts requested", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.dir, ".npmrc"), "ignore-scripts=false"), /configuration/],
    ["network outside allowlist requested", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.dir, ".npmrc"), "registry=https://evil.example"), /configuration/],
    ["pnpm hook", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.dir, ".pnpmfile.cjs"), "throw Error('must not run')"), /configuration/],
    ["workspace configuration", (f: ReturnType<typeof fixture>) => writeFileSync(join(f.dir, "pnpm-workspace.yaml"), "dangerouslyAllowAllBuilds: true"), /configuration/],
    ["automatic runtime download", (f: ReturnType<typeof fixture>) => { writeFileSync(join(f.dir, "package.json"), JSON.stringify({ ...f.manifest, engines: { runtime: { name: "node", version: "25.0.0", onFail: "download" } } })); }, /configuration/],
    ["package config", (f: ReturnType<typeof fixture>) => { writeFileSync(join(f.dir, "package.json"), JSON.stringify({ ...f.manifest, pnpm: { onlyBuiltDependencies: ["vite"] } })); }, /configuration/],
    ["preexisting modules", (f: ReturnType<typeof fixture>) => mkdirSync(join(f.dir, "node_modules")), /node_modules/],
    ["linked lockfile", (f: ReturnType<typeof fixture>) => { rmSync(join(f.dir, "package-lock.json")); symlinkSync("package.json", join(f.dir, "package-lock.json")); }, /regular/],
    ["inconsistent root", (f: ReturnType<typeof fixture>) => { f.lock.packages[""].devDependencies.vite = "2.0.0"; f.write(); }, /match/],
  ])("refuses %s before a process runs", async (_label, change, reason) => {
    const f = fixture(); (change as (f: ReturnType<typeof fixture>) => void)(f);
    await expect(inspect(f.dir)).rejects.toThrow(reason as RegExp);
  });
  it.each(["git+https://github.com/a/b.git", "file:../x", "link:../x", "https://evil.example/a.tgz", "https://registry.npmjs.org/vite/-/vite-1.0.0.tgz"])("refuses pnpm tarball resolution %s", async tarball => {
    const f = fixture("pnpm"); writeFileSync(join(f.dir, "pnpm-lock.yaml"), f.yaml.replace(`integrity: ${integrity}`, `integrity: ${integrity}, tarball: '${tarball}'`));
    await expect(inspect(f.dir)).rejects.toThrow(/registry|tarball/);
  });
  it.each(["&alias {integrity: xxx}", "!!js/function 'bad'", "{integrity: xxx, integrity: yyy}"])("refuses ambiguous pnpm YAML %s", async resolution => {
    const f = fixture("pnpm"); writeFileSync(join(f.dir, "pnpm-lock.yaml"), f.yaml.replace(`{integrity: ${integrity}}`, resolution));
    await expect(inspect(f.dir)).rejects.toThrow(/lockfile YAML/);
  });
  it("does not treat a dependency's hasInstallScript metadata as permission to run scripts", async () => {
    const f = fixture(); const p = f.lock.packages["node_modules/vite"];
    Object.assign(p, { hasInstallScript: true }); f.write(); expect(await inspect(f.dir)).toMatchObject({ manager: "npm" });
  });
  it("bounds a lockfile before parsing", async () => {
    const f = fixture(); writeFileSync(join(f.dir, "package-lock.json"), " ".repeat(8 * 1024 * 1024 + 1));
    await expect(inspect(f.dir)).rejects.toThrow(/size/);
  });
  it("refuses transitive non-registry specifications", async () => {
    const f = fixture(); Object.assign(f.lock.packages["node_modules/vite"], { dependencies: { hidden: "github:a/b" } }); f.write();
    await expect(inspect(f.dir)).rejects.toThrow(/registry/);
  });
  it("keeps the checked package and lock bytes intact", async () => {
    const f = fixture(); const before = readFileSync(join(f.dir, "package-lock.json")); await inspect(f.dir);
    expect(readFileSync(join(f.dir, "package-lock.json"))).toEqual(before);
  });
});

it("refuses pnpm's built-in non-npm registry scope before running", async () => {
  const f = fixture("pnpm");
  writeFileSync(join(f.dir, "pnpm-lock.yaml"), f.yaml.replace("packages:\n", `packages:\n  '@jsr/example@1.0.0':\n    resolution: {integrity: ${integrity}}\n`));
  await expect(inspect(f.dir)).rejects.toThrow(/registry/);
});
