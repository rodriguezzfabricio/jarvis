import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GateCheck } from "../checks/gate.ts";
import { verifyDesignObservation, type DesignBrowserPlan } from "./design-browser.ts";

export interface DesignCheckInput { nodeBin: string; manifest: string; manifestHash: string; axeVersion: string }
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function designBrowserDefinition(input: DesignCheckInput): GateCheck {
  if (!isAbsolute(input.nodeBin) || !isAbsolute(input.manifest) || !/^[a-f0-9]{64}$/.test(input.manifestHash) || !/^\d+\.\d+\.\d+$/.test(input.axeVersion)) throw new Error("invalid design browser pins");
  return {
    name:"design-browser",timeoutMs:600_000,allowLocalBinding:true,
    cases:[{id:"capture",command:`${quote(input.nodeBin)} "$JARVIS_FIXTURES/design-runtime/review/design-browser.ts" ${quote(input.manifest)} ${quote(input.manifestHash)} "$JARVIS_FIXTURES/design-plan.json" "$PWD"`}],
    verify:`${quote(input.nodeBin)} "$JARVIS_CHECKS/design-runtime/review/design-check.ts" "$JARVIS_CHECKS/design-plan.json" ${quote(input.axeVersion)}`,
  };
}

function main(): void {
  const [planPath,axeVersion]=process.argv.slice(2);
  if (!planPath || !axeVersion) throw new Error("missing design verifier inputs");
  const dir=join(process.env.JARVIS_OUT!,"capture");
  if(readFileSync(join(dir,"code"),"utf8").trim()!=="0") throw new Error("design capture did not complete");
  const raw=readFileSync(join(dir,"stdout"),"utf8");
  if(Buffer.byteLength(raw)>16*1024*1024) throw new Error("design observation exceeds gate bounds");
  verifyDesignObservation(JSON.parse(raw),JSON.parse(readFileSync(planPath,"utf8")) as DesignBrowserPlan,axeVersion);
  console.log(`JARVIS-CHECK-COMPLETE ${readFileSync(process.env.JARVIS_COMPLETION_FILE!,"utf8").trim()}`);
}
if(process.argv[1]&&pathToFileURL(realpathSync(process.argv[1])).href===import.meta.url) {
  try { main(); } catch(error) {console.error(String(error));process.exitCode=1;}
}
