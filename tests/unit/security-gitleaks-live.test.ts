import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runSession } from "../../packages/cli/src/proc/session.ts";
import { runScanner } from "../../packages/cli/src/security/scanners.ts";

const bin = "/opt/homebrew/bin/gitleaks";
it.skipIf(process.env.JARVIS_SECURITY_LIVE !== "1" || !existsSync(bin))("live gitleaks refuses a candidate ignore file that defeats the ignore-path flag", async () => {
  const root = mkdtempSync(join(tmpdir(), "security-gitleaks-live-"));
  try {
    const checkout = join(root, "checkout"); const home = join(root, "home"); mkdirSync(checkout); mkdirSync(home);
    const rules = join(root, "rules.toml");
    writeFileSync(rules, "[[rules]]\nid = 'jarvis-canary'\ndescription = 'Harmless Jarvis canary'\nregex = '''JARVIS_SECURITY_CANARY_[A-Z]+'''\n");
    writeFileSync(join(checkout, "canary.txt"), "JARVIS_SECURITY_CANARY_LIVE\n");
    const pin = { bin, version: "8.28.0", args: ["dir", "--config", rules, "--ignore-gitleaks-allow", "--gitleaks-ignore-path=/dev/null", "--redact=100", "--report-format=json", "--report-path=/dev/stdout", "--no-banner", "--no-color", "--log-level=fatal", "."] };
    const report = join(home, "raw-report.json");
    const rawArgs = pin.args.map((a) => a.replace("/dev/stdout", report));
    const raw = await runSession({ bin, args: rawArgs, cwd: checkout, env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin" }, timeoutMs: 5000 });
    expect(raw.code).toBe(1);
    expect(raw.stderr).toBe("");
    const fingerprint = (JSON.parse(readFileSync(report, "utf8")) as { Fingerprint: string }[])[0]!.Fingerprint;
    expect(fingerprint).toBeTruthy();
    expect(await runScanner("gitleaks", pin, checkout, { homeDir: home, tmpDir: home })).toMatchObject({ status: "fail", findings: [expect.objectContaining({ tool: "gitleaks", message: "Potential secret" })] });
    writeFileSync(join(checkout, ".gitleaksignore"), `${fingerprint}\n`);
    const suppressed = await runSession({ bin, args: rawArgs, cwd: checkout, env: { HOME: home, TMPDIR: home, PATH: "/usr/bin:/bin" }, timeoutMs: 5000 });
    expect(suppressed.code).toBe(0);
    expect(await runScanner("gitleaks", pin, checkout, { homeDir: home, tmpDir: home })).toMatchObject({ status: "error", detail: "suppression file present" });
    expect(existsSync(join(checkout, ".gitleaksignore"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
