import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCANNERS, runScanner, type Scanner, type ScannerPins } from "./scanners.ts";
import { scanTrifecta } from "./trifecta.ts";

// Executed only as the protected case's driver. Raw scanner logs never reach the case's pipes.
async function main(): Promise<void> {
  const tool = process.argv[2];
  if (tool === "trifecta") { console.log(JSON.stringify(scanTrifecta(process.cwd()))); return; }
  if (!SCANNERS.includes(tool as Scanner)) throw new Error("Unknown scanner");
  const fixture = join(process.env.JARVIS_FIXTURES!, "security");
  const pins = JSON.parse(readFileSync(join(fixture, "config.json"), "utf8")) as ScannerPins;
  const scanner = tool as Scanner; const pin = pins[scanner];
  const args = pin?.args.map((arg) => arg === "@rules" ? join(fixture, "rules", scanner) : arg);
  const result = await runScanner(scanner, pin && { ...pin, args: args! }, process.cwd(), {
    ...(process.env.HOME ? { homeDir: process.env.HOME } : {}),
    ...(process.env.TMPDIR ? { tmpDir: process.env.TMPDIR } : {}), fixturesDir: process.env.JARVIS_FIXTURES!,
  });
  console.log(JSON.stringify(result));
}

try { await main(); } catch { process.exitCode = 2; }
