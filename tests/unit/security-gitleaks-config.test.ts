import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { ChecksStore } from "../../packages/cli/src/checks/store.ts";
import { Ledger } from "../../packages/cli/src/ledger/ledger.ts";
import { pinnedSecurityScanners } from "../../packages/cli/src/config/pins.ts";
import { runSession, type SessionSpec } from "../../packages/cli/src/proc/session.ts";
import { installSecurityChecks } from "../../packages/cli/src/security/protected.ts";
import { runScanner } from "../../packages/cli/src/security/scanners.ts";

const config = fileURLToPath(new URL("../../packages/cli/src/security/gitleaks.toml", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "security-gitleaks-config-")); roots.push(root);
  const checkout = join(root, "checkout"); mkdirSync(checkout); return { root, checkout };
}
const ok = (stdout: string) => ({ code: 0, timedOut: false, overflowed: false, durationMs: 0, stdout, stderr: "" });

it("ships all 217 pinned default rules without path allowlists or default inheritance", () => {
  const text = readFileSync(config, "utf8");
  expect(text.match(/^\[\[rules\]\]$/gm)).toHaveLength(217);
  expect(text).not.toMatch(/^\s*(paths|useDefault)\s*=/m);
  expect(text).toContain('id = "github-pat"');
  expect(text).toContain("[[rules.allowlists]]");
  expect(text).toContain("stopwords = [");
  // The exact vendored policy is checked, including value-based exceptions and every rule.
  expect(createHash("sha256").update(text).digest("hex")).toBe("77342d97f53ef7c2f5bb23c1a3139b63b0dc358272d8c720bbe9d953f258e145");
});
// The full notice ships beside the copy; CREDITS names it without repeating the text (whose sentence the
// superpowers notice check relies on finding once).
it("keeps the upstream MIT notice beside the vendored config and credits it", () => {
  const license = readFileSync(new URL("../../packages/cli/src/security/gitleaks-LICENSE", import.meta.url), "utf8").replace(/\s+/g, " ");
  expect(license).toContain("Copyright (c) 2019 Zachary Rice");
  expect(license).toContain("The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.");
  expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  const credits = readFileSync(new URL("../../skills/CREDITS.md", import.meta.url), "utf8");
  for (const text of ["https://github.com/gitleaks/gitleaks/blob/v8.28.0/config/gitleaks.toml", "Copyright (c) 2019 Zachary Rice", "packages/cli/src/security/gitleaks-LICENSE"]) expect(credits).toContain(text);
});
it("passes the runner-owned config with the existing pinned invocation", async () => {
  const { checkout } = setup(); const pin = pinnedSecurityScanners().gitleaks!; const calls: SessionSpec[] = [];
  expect(await runScanner("gitleaks", pin, checkout, { spawn: async (spec) => { calls.push(spec); return ok(spec.args.includes("version") ? pin.version : "[]"); } })).toMatchObject({ status: "pass" });
  expect(calls[1]!.args.filter((arg) => arg === "--config")).toHaveLength(1);
  expect(calls[1]!.args[calls[1]!.args.indexOf("--config") + 1]).toBe(config);
});
it.each(["file", "symlink", "parent symlink"])("refuses an explicit candidate config reached by %s", async (kind) => {
  const { root, checkout } = setup(); writeFileSync(join(checkout, "rules.toml"), "rules = []");
  let rules = join(checkout, "rules.toml");
  if (kind === "symlink") { const path = join(root, "rules.toml"); symlinkSync(rules, path); rules = path; }
  if (kind === "parent symlink") { symlinkSync(checkout, join(root, "alias")); rules = join(root, "alias/rules.toml"); }
  const pin = pinnedSecurityScanners().gitleaks!; let calls = 0;
  expect(await runScanner("gitleaks", { ...pin, args: [...pin.args, "--config", rules], rulesFile: rules }, checkout, { spawn: async () => { calls++; return ok("[]"); } })).toMatchObject({ status: "error" });
  expect(calls).toBe(0);
});
it("copies and approves the default config, then uses it through the installed worker", async () => {
  const { root, checkout } = setup(); const project = join(root, "project"); const store = new ChecksStore(project); const ledger = Ledger.open(project);
  const pin = pinnedSecurityScanners().gitleaks!; const bin = join(root, "fake-gitleaks");
  writeFileSync(bin, `#!${process.execPath}\nif(process.argv.includes('version')) console.log('${pin.version}'); else { const fs=require('node:fs'); const config=process.argv[process.argv.indexOf('--config')+1]; if(!config?.includes('/checks/fixtures/') || !fs.readFileSync(config,'utf8').includes('id = "github-pat"')) process.exit(2); console.log('[]'); }`, { mode: 0o700 });
  installSecurityChecks(store, { nodeBin: process.execPath, scanners: { gitleaks: { ...pin, bin } } });
  const copied = join(store.checksDir, "fixtures/security/rules/gitleaks");
  expect(existsSync(copied)).toBe(true); expect(readFileSync(copied, "utf8")).toBe(readFileSync(config, "utf8"));
  store.approve(ledger, "reviewed gitleaks policy");
  const result = await runSession({ bin: process.execPath, args: [join(store.checksDir, "fixtures/security/security/worker.ts"), "gitleaks"], cwd: checkout, env: { JARVIS_FIXTURES: join(store.checksDir, "fixtures") }, timeoutMs: 5000 });
  expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ status: "pass" });
  writeFileSync(copied, "rules = []"); expect(store.verify(ledger).ok).toBe(false);
});
