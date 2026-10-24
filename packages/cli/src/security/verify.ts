import { readFileSync } from "node:fs";
import { join } from "node:path";

// No candidate imports, source files or app assertions. Observations come only from the runner.
try {
  const tool = process.argv[2];
  const observation = join(process.env.JARVIS_OUT!, "scan");
  if (readFileSync(join(observation, "code"), "utf8").trim() !== "0") throw Error("Driver failed");
  const result = JSON.parse(readFileSync(join(observation, "stdout"), "utf8")) as Record<string, unknown>;
  if (tool === "trifecta") {
    if (result.complete !== true || typeof result.required !== "boolean" || !Array.isArray(result.signals)) throw Error("Incomplete detector");
  } else if (result.tool !== tool || result.status !== "pass" || !Array.isArray(result.findings) || result.findings.length !== 0) throw Error("Scanner not passed");
  const nonce = readFileSync(process.env.JARVIS_COMPLETION_FILE!, "utf8").trim();
  console.log(`JARVIS-CHECK-COMPLETE ${nonce}`);
} catch { process.exitCode = 1; }
