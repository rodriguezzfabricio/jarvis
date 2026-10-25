import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { HOMEBREW, homebrewKegs, openCodexJail, type CodexJail } from "../../packages/cli/src/review/confine.ts";

// Decision 110: the confined reviewer gets only the Homebrew kegs its launcher loads, never the prefix:
// /opt/homebrew/var and /opt/homebrew/etc hold real secrets on this Mac (a Tor hidden-service key,
// PostgreSQL data). Every secret here is a dummy planted in this test's own temp tree, which the
// profile builder treats as the Homebrew root. Nothing reads the real prefix's var or etc.
const roots: string[] = [];
const jails: CodexJail[] = [];
afterEach(async () => {
  for (const j of jails.splice(0)) await j.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const darwin = process.platform === "darwin";

// Minimal Mach-O images: a header and the load commands the closure walk reads, nothing else.
const LC = { LOAD: 0xc, ID: 0xd, WEAK: 0x80000018, REEXPORT: 0x8000001f, RPATH: 0x8000001c };
function command(cmd: number, str: string, offset: number): Buffer {
  const size = Math.ceil((offset + Buffer.byteLength(str) + 1) / 8) * 8;
  const b = Buffer.alloc(size); b.writeUInt32LE(cmd, 0); b.writeUInt32LE(size, 4); b.writeUInt32LE(offset, 8); b.write(str, offset);
  return b;
}
function macho(o: { load?: string[]; weak?: string[]; reexport?: string[]; id?: string; rpaths?: string[]; fat?: boolean } = {}): Buffer {
  const cmds = [
    ...(o.id ? [command(LC.ID, o.id, 24)] : []),
    ...(o.load ?? []).map((p) => command(LC.LOAD, p, 24)),
    ...(o.weak ?? []).map((p) => command(LC.WEAK, p, 24)),
    ...(o.reexport ?? []).map((p) => command(LC.REEXPORT, p, 24)),
    ...(o.rpaths ?? []).map((p) => command(LC.RPATH, p, 12)),
  ];
  const body = Buffer.concat(cmds);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(0x0100000c, 4); header.writeUInt32LE(o.id ? 6 : 2, 12);
  header.writeUInt32LE(cmds.length, 16); header.writeUInt32LE(body.length, 20);
  const thin = Buffer.concat([header, body, Buffer.alloc(64)]);
  if (!o.fat) return thin;
  const fat = Buffer.alloc(4096);
  fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(0x0100000c, 8); fat.writeUInt32BE(0, 12); fat.writeUInt32BE(4096, 16); fat.writeUInt32BE(thin.length, 20); fat.writeUInt32BE(12, 24);
  return Buffer.concat([fat, thin]);
}

/** A fake Homebrew prefix: a tool keg whose binary loads two library kegs, an unrelated keg, and planted secrets. */
function fakeBrew() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-brew-"))); roots.push(root);
  const brew = join(root, "brew"), token = randomBytes(8).toString("hex");
  const file = (path: string, data: string | Buffer, mode = 0o644) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data, { mode }); return path; };
  const keg = (name: string, version: string) => { const k = join(brew, "Cellar", name, version); mkdirSync(k, { recursive: true }); mkdirSync(join(brew, "opt"), { recursive: true }); symlinkSync(`../Cellar/${name}/${version}`, join(brew, "opt", name)); return k; };
  const tool = keg("tool", "1.0"), liba = keg("liba", "2.0"), libc = keg("libc", "3.0"), libd = keg("libd", "4.0"), unrelated = keg("unrelated", "9.9");
  file(join(tool, "bin/tool"), macho({ load: ["@rpath/libtool.dylib", `${brew}/opt/liba/lib/liba.dylib`, "/usr/lib/libSystem.B.dylib"], rpaths: ["@loader_path/../lib"] }), 0o755);
  file(join(tool, "lib/libtool.dylib"), macho({ id: `${brew}/opt/unrelated/lib/libx.dylib`, load: [`${brew}/opt/libc/lib/libc.dylib`], weak: [`${brew}/opt/gone/lib/libgone.dylib`] }));
  // Each way of naming a library reaches a keg nothing else reaches: libc only through @rpath, libd only through @executable_path.
  file(join(liba, "lib/liba.dylib"), macho({ fat: true, load: ["@executable_path/../lib/libexe.dylib"] }));
  file(join(tool, "lib/libexe.dylib"), macho({ load: [`${brew}/opt/libd/lib/libd.dylib`] }));
  file(join(libc, "lib/libc.dylib"), macho());
  file(join(libd, "lib/libd.dylib"), macho());
  file(join(unrelated, "lib/libx.dylib"), macho());
  mkdirSync(join(brew, "bin")); symlinkSync("../Cellar/tool/1.0/bin/tool", join(brew, "bin", "tool"));
  const secrets = {
    tor: file(join(brew, "var/lib/tor/hidden_service/hs_ed25519_secret_key"), `DUMMY-TOR-KEY-${token}`, 0o600),
    postgres: file(join(brew, "var/postgresql@17/pg_hba.conf"), `DUMMY-PG-${token}`, 0o600),
    etc: file(join(brew, "etc/dummy-service/credentials.conf"), `DUMMY-ETC-${token}`),
    tap: file(join(brew, "Library/Taps/someone/homebrew-private/.git/config"), `DUMMY-TAP-${token}`),
    unrelatedKeg: file(join(unrelated, "share/secret.txt"), `DUMMY-KEG-${token}`),
  };
  const tools = join(root, "tools"); mkdirSync(tools);
  const envScript = file(join(tools, "codex-env.js"), "#!/usr/bin/env tool\n", 0o755);
  const absScript = file(join(tools, "codex-abs.js"), `#!${brew}/bin/tool --flag\n`, 0o755);
  return { root, brew, token, tool, liba, libc, libd, unrelated, secrets, envScript, absScript, file };
}

describe("Homebrew kegs a confined launcher needs", () => {
  it("is the interpreter's keg and every keg its libraries load, through @rpath, @loader_path, @executable_path and fat images", () => {
    const f = fakeBrew();
    const expected = [f.liba, f.libc, f.libd, f.tool].sort();
    expect(homebrewKegs(f.absScript, { homebrew: f.brew })).toEqual(expected);
    expect(homebrewKegs(f.envScript, { homebrew: f.brew, searchPath: `${f.brew}/bin:/usr/bin:/bin` })).toEqual(expected);
    expect(homebrewKegs(join(f.brew, "bin/tool"), { homebrew: f.brew })).toEqual(expected);
  });
  it("never includes a keg named only by a library's own ID, or a keg nothing loads", () => {
    const f = fakeBrew();
    expect(homebrewKegs(f.absScript, { homebrew: f.brew })).not.toContain(f.unrelated);
  });
  it("is empty for a launcher that loads nothing from Homebrew", () => {
    const f = fakeBrew();
    const sys = f.file(join(f.root, "tools/sys.sh"), "#!/bin/sh\n", 0o755);
    expect(homebrewKegs(sys, { homebrew: f.brew })).toEqual([]);
  });
  it.each([
    ["a library outside any keg", (brew: string) => `${brew}/lib/libstray.dylib`],
    ["a library under var", (brew: string) => `${brew}/var/lib/libstray.dylib`],
    ["a library under etc", (brew: string) => `${brew}/etc/libstray.dylib`],
  ])("refuses %s", (_name, where) => {
    const f = fakeBrew();
    f.file(where(f.brew), macho());
    const bin = f.file(join(f.tool, "bin/tool2"), macho({ load: [where(f.brew)] }), 0o755);
    expect(() => homebrewKegs(bin, { homebrew: f.brew })).toThrow(/outside a Homebrew keg/);
  });
  it("defaults to the real prefix and finds the node keg the reviewer's launcher runs on", () => {
    expect(HOMEBREW).toBe("/opt/homebrew");
    const node = realpathSync(process.execPath);
    if (!node.startsWith("/opt/homebrew/Cellar/")) return;
    const kegs = homebrewKegs(process.execPath);
    expect(kegs).toContain(node.split("/").slice(0, 6).join("/"));
    for (const k of kegs) expect(k).toMatch(/^\/opt\/homebrew\/Cellar\/[^/]+\/[^/]+$/);
  });
});

describe.skipIf(!darwin)("the confined reviewer can't read Homebrew's secrets", () => {
  async function jail(f: ReturnType<typeof fakeBrew>, workspace?: string): Promise<CodexJail> {
    const home = join(f.root, "home"), checkout = join(f.root, "checkout");
    mkdirSync(home, { recursive: true }); mkdirSync(checkout, { recursive: true });
    const j = await openCodexJail({ home, bin: f.absScript, workspace: workspace ?? checkout, homebrew: f.brew }); jails.push(j);
    return j;
  }
  const cat = (j: CodexJail, path: string) => runSession({ ...j.wrap("/bin/cat", [path]), cwd: j.tmp, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });

  it("reads the kegs the launcher loads, and nothing else of the prefix", async () => {
    const f = fakeBrew(), j = await jail(f);
    const loaded = await cat(j, join(f.libc, "lib/libc.dylib"));
    expect(loaded.code).toBe(0);
    for (const [name, path] of Object.entries(f.secrets)) {
      const r = await cat(j, path);
      expect(r.code, name).not.toBe(0);
      expect(r.stderr, name).toMatch(/Operation not permitted/);
      expect(r.stdout, name).not.toContain(f.token);
    }
    const profile = readFileSync(j.profile, "utf8");
    expect(profile).not.toContain(`(subpath ${JSON.stringify(f.brew)})`);
    expect(profile).toContain(`(deny file-read* file-write* file-map-executable (subpath ${JSON.stringify(join(f.brew, "var"))}) (subpath ${JSON.stringify(join(f.brew, "etc"))}))`);
  });
  it("keeps var and etc denied even when an allowed folder contains them", async () => {
    const f = fakeBrew(), j = await jail(f, f.brew);
    expect((await cat(j, f.secrets.tap)).code).toBe(0);
    for (const path of [f.secrets.tor, f.secrets.postgres, f.secrets.etc]) {
      const r = await cat(j, path);
      expect(r.stderr).toMatch(/Operation not permitted/);
      expect(r.stdout).not.toContain(f.token);
    }
  });
  it("can't reach a denied file through the data volume's firmlinked path", async () => {
    const f = fakeBrew(), j = await jail(f);
    for (const path of [f.secrets.unrelatedKeg, f.secrets.tor]) {
      const r = await cat(j, `/System/Volumes/Data${path}`);
      expect(r.stderr).toMatch(/Operation not permitted/);
      expect(r.stdout).not.toContain(f.token);
    }
  });
  it("denies the real prefix's var and etc in the default profile, without reading either", async () => {
    const f = fakeBrew();
    const home = join(f.root, "home2"), checkout = join(f.root, "checkout2");
    mkdirSync(home); mkdirSync(checkout);
    const j = await openCodexJail({ home, bin: f.absScript, workspace: checkout }); jails.push(j);
    const profile = readFileSync(j.profile, "utf8");
    expect(profile).toContain('(deny file-read* file-write* file-map-executable (subpath "/opt/homebrew/var") (subpath "/opt/homebrew/etc"))');
    expect(profile).not.toContain('(subpath "/opt/homebrew")');
  });
});
