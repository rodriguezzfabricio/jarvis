import { chmodSync, constants, fstatSync, mkdirSync, openSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { envFileSecrets } from "../../packages/cli/src/broker/secrets.ts";
import { shortTmp } from "../helpers.ts";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })); });
function setup() {
  const root = shortTmp("j-secrets-"); roots.push(root);
  chmodSync(root, 0o700);
  const path = join(root, "test.env");
  writeFileSync(path, "FAKE_VALUE='test-only-value'\n", { mode: 0o600 });
  return { root, path };
}
const acl = () => "-rw------- 1 owner staff 1 Oct 25 00:00 file\n";

it("reads private files and refuses symlinks", () => {
  const s = setup();
  expect(envFileSecrets(s.path).get("FAKE_VALUE")).toBe("test-only-value");
  const link = join(s.root, "link.env"); symlinkSync(s.path, link);
  expect(() => envFileSecrets(link)).toThrow(/ELOOP|symbolic link/);
});
it.each([0o640, 0o601, 0o700])("refuses file mode %s, including owner execute", (mode) => {
  const s = setup(); chmodSync(s.path, mode);
  expect(() => envFileSecrets(s.path)).toThrow(/readable by its owner only \(chmod 600\); it is [0-7]+/);
});
it.each([0o400, 0o600])("accepts private mode %s", (mode) => {
  const s = setup(); chmodSync(s.path, mode);
  expect(envFileSecrets(s.path).get("FAKE_VALUE")).toBe("test-only-value");
});
it("refuses a writable parent and a symlinked parent", () => {
  const s = setup(); chmodSync(s.root, 0o770);
  expect(() => envFileSecrets(s.path)).toThrow(/writable by others/);
  chmodSync(s.root, 0o700);
  const link = join(s.root, "alias"); symlinkSync(s.root, link);
  expect(() => envFileSecrets(join(link, "test.env"))).toThrow(/refuse symlinks/);
});
it("checks the descriptor owner, mode and regular-file type before reading", () => {
  const s = setup();
  for (const [override, message] of [[{ uid: process.getuid!() + 1 }, /belong to the current user/], [{ mode: 0o100644 }, /chmod 600/], [{ isFile: () => false }, /regular file/]] as const) {
    expect(() => envFileSecrets(s.path, { acl, fstat: (fd) => { const st = fstatSync(fd); return st.isDirectory() ? st : Object.assign(st, override); } })).toThrow(message);
  }
  const dir = join(s.root, "dir"); mkdirSync(dir, { mode: 0o700 });
  expect(() => envFileSecrets(dir)).toThrow(/regular file/);
});
it("refuses the wrong parent owner", () => {
  const s = setup();
  expect(() => envFileSecrets(s.path, { uid: process.getuid!() + 1, acl })).toThrow(/must be owned by you/);
});
it.each(["file", "parent", "unreadable"])("fails closed on %s ACLs", (where) => {
  const s = setup();
  expect(() => envFileSecrets(s.path, { acl: (p) => {
    if (where === "unreadable") throw new Error("ACL failure");
    return acl() + (p === (where === "file" ? s.path : s.root) ? " 0: group:everyone allow read\n" : "");
  } })).toThrow(where === "unreadable" ? /could not read its ACL/ : /has an ACL that allows group:everyone/);
});
it("opens no-follow and checks the actual file swapped in at open", () => {
  const s = setup();
  const open = vi.fn((path: string, flags: number) => {
    if (path === s.path) {
      renameSync(s.path, `${s.path}.old`);
      writeFileSync(s.path, "FAKE_VALUE=replacement\n", { mode: 0o644 });
    }
    return openSync(path, flags);
  });
  expect(() => envFileSecrets(s.path, { acl, open })).toThrow(/chmod 600/);
  expect(open).toHaveBeenCalled();
  expect(open.mock.calls.every(([, flags]) => (flags & constants.O_NOFOLLOW) !== 0)).toBe(true);
});

it("checks the ACL of a parent swapped in at open", () => {
  const s = setup(); let replaced = false;
  expect(() => envFileSecrets(s.path, {
    acl: (path) => acl() + (path === s.root && replaced ? " 0: group:everyone allow read,write\n" : ""),
    open: (path, flags) => {
      if (path === s.root) {
        renameSync(s.root, `${s.root}.old`); roots.push(`${s.root}.old`);
        mkdirSync(s.root, { mode: 0o700 });
        writeFileSync(s.path, "FAKE_VALUE=fake-replacement\n", { mode: 0o600 });
        replaced = true;
      }
      return openSync(path, flags);
    },
  })).toThrow();
});

it.each(["owner", "mode", "type"])("checks the opened parent descriptor's %s", (fault) => {
  const s = setup();
  expect(() => envFileSecrets(s.path, { acl, fstat: (fd) => {
    const st = fstatSync(fd);
    if (!st.isDirectory()) return st;
    if (fault === "owner") st.uid++;
    if (fault === "mode") st.mode |= 0o020;
    if (fault === "type") st.isDirectory = () => false;
    return st;
  } })).toThrow(/the secrets folder must be yours, a real folder, and writable only by you/);
});

it("refuses replacement of the file during the ACL check", () => {
  const s = setup();
  expect(() => envFileSecrets(s.path, { acl: (path) => {
    if (path === s.path) {
      renameSync(s.path, `${s.path}.old`);
      writeFileSync(s.path, "FAKE_VALUE=replacement\n", { mode: 0o600 });
    }
    return acl();
  } })).toThrow(/changed while being checked/);
});
