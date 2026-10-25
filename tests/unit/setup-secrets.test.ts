import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { envFileSecrets, envFileSecretsWriter, isStorableSecret } from "../../packages/cli/src/broker/secrets.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function home() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-setup-secrets-")); dirs.push(root);
  mkdirSync(join(root, ".jarvis"), { mode: 0o700 });
  return { root, dir: join(root, ".jarvis", "secrets"), file: join(root, ".jarvis", "secrets", "house-stack.accounts.env") };
}
const TOKEN = "ghp_SENTINELsetupSecret0123456789";

it("stores through the env-file backend so the broker's reader returns the exact value, owner-only", () => {
  const h = home(); const w = envFileSecretsWriter(h.file);
  w.prepare();
  expect(lstatSync(h.dir).mode & 0o777).toBe(0o700);
  w.set("GITHUB_TOKEN", TOKEN, { brokerOnly: true });
  w.set("OAUTH_DEV_CLIENT_ID", "client-id-123", { brokerOnly: false });
  expect(lstatSync(h.file).mode & 0o777).toBe(0o600);
  const read = envFileSecrets(h.file);
  expect(read.get("GITHUB_TOKEN")).toBe(TOKEN);
  expect(read.get("OAUTH_DEV_CLIENT_ID")).toBe("client-id-123");
  expect(w.location).toBe(h.file);
});

it("replaces one key without touching others and marks production keys broker-only", () => {
  const h = home(); const w = envFileSecretsWriter(h.file); w.prepare();
  w.set("A_TOKEN", "first-value-1", { brokerOnly: true });
  w.set("B_TOKEN", "second-value-2", { brokerOnly: false });
  expect(readFileSync(h.file, "utf8")).toMatch(/^# broker-only: A_TOKEN\nA_TOKEN=first-value-1$/m);
  expect(readFileSync(h.file, "utf8")).not.toMatch(/broker-only: B_TOKEN/);
  w.set("A_TOKEN", "replaced-value-3", { brokerOnly: false });
  const text = readFileSync(h.file, "utf8");
  expect(text.match(/^A_TOKEN=/gm)).toHaveLength(1);
  expect(text).not.toMatch(/broker-only: A_TOKEN/);
  expect(envFileSecrets(h.file).get("A_TOKEN")).toBe("replaced-value-3");
  expect(envFileSecrets(h.file).get("B_TOKEN")).toBe("second-value-2");
});

it.each([["a newline", "abc12345\nEVIL=1"], ["a space", "abc 12345678"], ["a quote", "\"abc12345678\""], ["a control character", "abc12345\u0007"], ["too short", "abc"], ["non-ASCII", "abcdéfgh123"]])("refuses %s without echoing the value", (_label, value) => {
  const h = home(); const w = envFileSecretsWriter(h.file); w.prepare();
  expect(isStorableSecret(value)).toBe(false);
  let message = "";
  try { w.set("X_TOKEN", value, { brokerOnly: true }); } catch (error) { message = String(error); }
  expect(message).toMatch(/X_TOKEN/);
  expect(message).not.toContain(value);
  expect(existsSync(h.file)).toBe(false);
});

it("refuses an invalid key name", () => {
  const h = home(); const w = envFileSecretsWriter(h.file); w.prepare();
  expect(() => w.set("lower case", "abcdefgh1234", { brokerOnly: true })).toThrow(/key/i);
});

it("refuses a symlinked secrets file or folder, including dangling links", () => {
  const h = home(); mkdirSync(h.dir, { mode: 0o700 });
  const outside = join(h.root, "outside.env"); writeFileSync(outside, "KEEP=1\n", { mode: 0o600 });
  symlinkSync(outside, h.file);
  expect(() => envFileSecretsWriter(h.file).prepare()).toThrow(/symlink/i);
  expect(() => envFileSecretsWriter(h.file).set("A_TOKEN", "abcdefgh1234", { brokerOnly: true })).toThrow(/symlink/i);
  expect(readFileSync(outside, "utf8")).toBe("KEEP=1\n");
  rmSync(h.file); symlinkSync(join(h.root, "missing.env"), h.file);
  expect(() => envFileSecretsWriter(h.file).set("A_TOKEN", "abcdefgh1234", { brokerOnly: true })).toThrow(/symlink/i);
  rmSync(h.file); rmSync(h.dir, { recursive: true });
  mkdirSync(join(h.root, "elsewhere"), { mode: 0o700 }); symlinkSync(join(h.root, "elsewhere"), h.dir);
  expect(() => envFileSecretsWriter(h.file).prepare()).toThrow(/symlink/i);
  expect(readdirSync(join(h.root, "elsewhere"))).toEqual([]);
});

it("refuses an existing secrets file or folder that others can read", () => {
  const h = home(); const w = envFileSecretsWriter(h.file); w.prepare();
  w.set("A_TOKEN", "abcdefgh1234", { brokerOnly: true });
  chmodSync(h.file, 0o640);
  expect(() => w.set("B_TOKEN", "abcdefgh5678", { brokerOnly: true })).toThrow(/owner only/i);
  expect(() => w.prepare()).toThrow(/owner only/i);
  chmodSync(h.file, 0o600); chmodSync(h.dir, 0o755);
  expect(() => w.prepare()).toThrow(/owner only/i);
  expect(() => w.set("B_TOKEN", "abcdefgh5678", { brokerOnly: true })).toThrow(/owner only/i);
});

it("replaces the file atomically: a failed rename leaves the old file and no temp file", () => {
  const h = home(); envFileSecretsWriter(h.file).prepare();
  envFileSecretsWriter(h.file).set("A_TOKEN", "abcdefgh1234", { brokerOnly: true });
  const before = readFileSync(h.file, "utf8");
  const rename = vi.fn(() => { throw new Error("rename fault"); });
  expect(() => envFileSecretsWriter(h.file, { rename }).set("B_TOKEN", "abcdefgh5678", { brokerOnly: true })).toThrow("rename fault");
  expect(rename).toHaveBeenCalled();
  expect(readFileSync(h.file, "utf8")).toBe(before);
  expect(readdirSync(h.dir)).toEqual(["house-stack.accounts.env"]);
});
