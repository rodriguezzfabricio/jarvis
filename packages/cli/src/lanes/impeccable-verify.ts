import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { evaluateImpeccable, type ImpeccableResult } from "./impeccable.ts";

const Result = z.object({status: z.enum(["pass", "fail", "error"]), findings: z.array(z.unknown()).max(1000), error: z.string().optional()}).strict();
const Observation = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("impeccable-source"), result: Result}).strict(),
  z.object({kind: z.literal("impeccable-url"), pages: z.array(z.object({width: z.number(), result: Result}).strict()).length(3)}).strict(),
]);

/** Isolated assertions; never accept a case's self-reported pass without checking its findings. */
export function verifyImpeccableObservation(raw: unknown, mode: "source" | "url"): ImpeccableResult {
  try {
    const observation = Observation.parse(raw);
    if (observation.kind !== `impeccable-${mode}`) throw new Error("wrong Impeccable mode");
    if (observation.kind === "impeccable-url" && JSON.stringify(observation.pages.map(p => p.width).sort((a,b) => a-b)) !== "[375,768,1440]") throw new Error("incomplete viewport coverage");
    const results = observation.kind === "impeccable-source" ? [observation.result] : observation.pages.map(p => p.result);
    const findings: ImpeccableResult["findings"] = [];
    for (const result of results) {
      if (result.status === "error") throw new Error(result.error ?? "scanner error");
      const parsed = evaluateImpeccable({code: result.status === "pass" ? 0 : 2, stdout: JSON.stringify(result.findings), stderr: "", timedOut: false, overflowed: false, durationMs: 0});
      if (parsed.status === "error") throw new Error(parsed.error);
      findings.push(...parsed.findings);
    }
    return {status: results.some(r => r.status === "fail") ? "fail" : "pass", findings};
  } catch (error) { return {status: "error", findings: [], error: error instanceof Error ? error.message : String(error)}; }
}

function main(): void {
  const mode = process.argv[2];
  if (mode !== "source" && mode !== "url") throw new Error("invalid Impeccable mode");
  const dir = join(process.env.JARVIS_OUT!, "scan");
  if (readFileSync(join(dir, "code"), "utf8").trim() !== "0") throw new Error("Impeccable driver failed");
  const raw = readFileSync(join(dir, "stdout"), "utf8");
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("oversized Impeccable observation");
  const result = verifyImpeccableObservation(JSON.parse(raw), mode);
  if (result.status !== "pass") throw new Error(`Impeccable ${result.status}`);
  console.log(`JARVIS-CHECK-COMPLETE ${readFileSync(process.env.JARVIS_COMPLETION_FILE!, "utf8").trim()}`);
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
