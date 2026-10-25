import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { pinnedSecurityScanners } from "../../packages/cli/src/config/pins.ts";
import { runScanner } from "../../packages/cli/src/security/scanners.ts";

const enabled = process.env.JARVIS_SECURITY_LIVE === "1";
it.skipIf(!enabled || !existsSync("/opt/homebrew/bin/semgrep"))("live Semgrep detects all six rule categories in JS, TS, Python and Go without registry rules", async () => {
  const root = mkdtempSync(join(tmpdir(), "security-semgrep-live-"));
  try {
    const checkout = join(root, "checkout"); mkdirSync(checkout);
    const js = `const password = "jarvis-public-test-canary";
eval(input); // nosemgrep
serializer.unserialize(input);
child_process.exec(input);
db.query("SELECT * FROM users WHERE id=" + input);
fetch(req.query.url);
`;
    writeFileSync(join(checkout, "app.js"), js); writeFileSync(join(checkout, "app.ts"), js);
    writeFileSync(join(checkout, "app.py"), `import pickle, os, requests
password = "jarvis-public-test-canary"
eval(data) # nosemgrep
pickle.loads(data)
os.system(data)
db.execute("SELECT * FROM users WHERE id=" + data)
requests.get(request.args.get("url"))
`);
    writeFileSync(join(checkout, "app.go"), `package main
import ("encoding/gob"; "net/http"; "os/exec")
func handler(w http.ResponseWriter, r *http.Request) {
password := "jarvis-public-test-canary"
t.Parse(code)
gob.NewDecoder(r.Body).Decode(&value)
exec.Command("sh", "-c", input)
db.Query("SELECT * FROM users WHERE id=" + input)
http.Get(r.URL.Query().Get("url"))
_ = password
}
`);
    mkdirSync(join(checkout, "nested"));
    writeFileSync(join(checkout, "nested/.semgrepignore"), "*.py\n");
    writeFileSync(join(checkout, "nested/hidden.py"), "eval(data) # nosemgrep\n");
    // The CLI worker's outer sandbox denies network. A second sandbox-exec is unavailable here.
    const result = await runScanner("semgrep", pinnedSecurityScanners().semgrep, checkout, { timeoutMs: 45_000 });
    expect(result.status).toBe("fail");
    for (const language of ["js", "py", "go"]) for (const category of ["sql-injection", language === "go" ? "template-eval" : "eval", "unsafe-deserialization", "command-execution", "ssrf", "hardcoded-secret"]) {
      expect(result.findings.some((finding) => finding.rule.endsWith(`jarvis.${language}.${category}`))).toBe(true);
    }
    expect(result.findings.some((finding) => finding.file.endsWith("app.ts"))).toBe(true);
    expect(result.findings.some((finding) => finding.file.endsWith("nested/hidden.py"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("jarvis-public-test-canary");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);

const db = process.env.JARVIS_OSV_DB_DIRECTORY;
it.skipIf(!enabled || !existsSync("/opt/homebrew/bin/osv-scanner") || !db || !existsSync(join(db, "manifest.json")))("live OSV detects vulnerable lodash with the explicitly fetched npm database", async () => {
  const root = mkdtempSync(join(tmpdir(), "security-osv-live-"));
  try {
    const checkout = join(root, "checkout"); mkdirSync(checkout);
    writeFileSync(join(checkout, "package-lock.json"), JSON.stringify({ name: "jarvis-canary", lockfileVersion: 3, packages: { "": { name: "jarvis-canary", version: "1.0.0" }, "node_modules/lodash": { version: "4.17.20", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz" } } }));
    const pin = pinnedSecurityScanners()["osv-scanner"]!;
    const path = resolve(db!);
    const result = await runScanner("osv-scanner", { ...pin, env: { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: path } }, checkout, { fixturesDir: dirname(path), timeoutMs: 90_000 });
    expect(result.status).toBe("fail"); expect(result.findings.length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
