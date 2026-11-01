import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** No candidate code or checkout is available in this phase (decision 76). */
export function verifyDesignLint(raw: unknown, check: string): void {
  const value = raw as {check?:unknown; complete?:unknown; findings?:unknown};
  if (!value || !["ai-tells", "token-lint", "design-md-lint"].includes(check) || value.check !== check || value.complete !== true || !Array.isArray(value.findings)) throw new Error("incomplete design lint observation");
  if (value.findings.length !== 0) throw new Error("design lint findings");
}

function main(): void {
  const check = process.argv[2] ?? "", dir = join(process.env.JARVIS_OUT!, "lint");
  if (readFileSync(join(dir, "code"), "utf8").trim() !== "0") throw new Error("design lint case did not complete");
  const raw = readFileSync(join(dir, "stdout"), "utf8");
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("oversized design lint observation");
  verifyDesignLint(JSON.parse(raw), check);
  console.log(`JARVIS-CHECK-COMPLETE ${readFileSync(process.env.JARVIS_COMPLETION_FILE!, "utf8").trim()}`);
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
