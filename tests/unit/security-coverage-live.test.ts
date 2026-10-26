import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pinnedSecurityScanners } from "../../packages/cli/src/config/pins.ts";
import { runScanner } from "../../packages/cli/src/security/scanners.ts";

const enabled = process.env.JARVIS_SECURITY_LIVE === "1";
it.skipIf(!enabled || !existsSync("/opt/homebrew/bin/semgrep"))("live Semgrep cannot silently pass eval in mts and extensionless Node scripts", async () => {
  const root = mkdtempSync(join(tmpdir(), "security-coverage-live-"));
  try {
    for (const [name, prefix] of [["app.mts", ""], ["script", "#!/usr/bin/env -S node --no-warnings\n"]]) {
      const checkout = join(root, name! + "-checkout"); mkdirSync(checkout);
      writeFileSync(join(checkout, name!), `${prefix}eval(input);\n`, { mode: 0o600 });
      const result = await runScanner("semgrep", pinnedSecurityScanners().semgrep, checkout, { timeoutMs: 45_000 });
      if (result.status === "fail") expect(result.findings.some((finding) => finding.file.endsWith(name!) && finding.rule.endsWith("jarvis.js.eval"))).toBe(true);
      else expect(result).toMatchObject({ status: "error", detail: `semgrep coverage missing: ${JSON.stringify([name])}` });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 110_000);

it.skipIf(!enabled || !existsSync("/opt/homebrew/bin/gitleaks"))("live protected gitleaks config detects generated fake tokens in lockfiles and dependencies", async () => {
  const root = mkdtempSync(join(tmpdir(), "security-gitleaks-coverage-live-"));
  try {
    const checkout = join(root, "checkout"); mkdirSync(join(checkout, "node_modules/x"), { recursive: true });
    // Random canary with a recognizable format, never obtained from any service or credential store.
    const canary = ["gh", "p_"].join("") + randomBytes(18).toString("hex");
    writeFileSync(join(checkout, "package-lock.json"), JSON.stringify({ token: canary }));
    writeFileSync(join(checkout, "node_modules/x/index.js"), `const token = "${canary}";\n`);
    const result = await runScanner("gitleaks", pinnedSecurityScanners().gitleaks, checkout, { timeoutMs: 15_000 });
    expect(result.status).toBe("fail");
    for (const path of ["package-lock.json", "node_modules/x/index.js"]) expect(result.findings.some((finding) => finding.file.endsWith(path))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(canary);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 25_000);
