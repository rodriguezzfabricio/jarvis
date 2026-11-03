import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyDesignObservation, type DesignBrowserObservation, type DesignBrowserPlan } from "../review/design-browser.ts";
import type { DesignCapture } from "../review/design-evidence.ts";
import { recordWebBaseline, verifyWebObservation } from "./verify.ts";

export interface StoredAxeBaseline { baseRevision: string; axeVersion: string; observation: DesignBrowserObservation }

/** Call only after verifying the checks lock (or inside the gate's isolated verifier). */
export function readDesignBaseline(checksDir: string): StoredAxeBaseline | undefined {
  const file=join(checksDir,"expected/axe-base.json"), stat=lstatSync(file,{throwIfNoEntry:false});
  if(!stat)return undefined;
  if(!stat.isFile()||stat.nlink!==1||stat.size>32*1024*1024)throw new Error("axe baseline is not bounded regular data");
  return JSON.parse(readFileSync(file,"utf8")) as StoredAxeBaseline;
}

/** Only runner stdout from the fresh base checkout belongs here; this never reads a candidate file. */
export function baselineFromObservation(raw: unknown, plan: DesignBrowserPlan, axeVersion: string, baseRevision: string): StoredAxeBaseline {
  verifyDesignObservation(raw,plan,axeVersion,{calibration:true});
  const observation = raw as DesignBrowserObservation;
  for (const [i,flow] of plan.flows.entries()) recordWebBaseline(observation.web[i],{url:flow.finalUrl??flow.url,axeVersion},baseRevision);
  return {baseRevision,axeVersion,observation};
}

/** Structural design evidence remains unchanged; only the axe comparison receives a runner baseline. */
export function verifyServedDesign(raw: unknown, plan: DesignBrowserPlan, axeVersion: string, base?: StoredAxeBaseline): DesignCapture {
  if (!base) return verifyDesignObservation(raw,plan,axeVersion);
  if (base.axeVersion !== axeVersion) throw new Error("wrong-version axe baseline");
  baselineFromObservation(base.observation,plan,axeVersion,base.baseRevision);
  const capture = verifyDesignObservation(raw,plan,axeVersion,{calibration:true});
  for (const [i,flow] of plan.flows.entries()) {
    const expected = {url:flow.finalUrl??flow.url,axeVersion};
    const baseline = recordWebBaseline(base.observation.web[i],expected,base.baseRevision);
    const verified = verifyWebObservation((raw as DesignBrowserObservation).web[i],{...expected,baseline});
    if (!verified.ok) throw new Error(`design browser checks failed: ${verified.problems.join("; ")}`);
  }
  return capture;
}

function main(): void {
  const [planFile,axeVersion,baseRevision] = process.argv.slice(2);
  if (!planFile || !axeVersion) throw new Error("missing protected design verifier inputs");
  const dir=join(process.env.JARVIS_OUT!,"capture");
  if (readFileSync(join(dir,"code"),"utf8").trim()!=="0") throw new Error("design capture did not complete");
  const text=readFileSync(join(dir,"stdout"),"utf8");
  if(Buffer.byteLength(text)>16*1024*1024) throw new Error("oversized design observation");
  const raw: unknown=JSON.parse(text), plan=JSON.parse(readFileSync(planFile,"utf8")) as DesignBrowserPlan;
  if (baseRevision) baselineFromObservation(raw,plan,axeVersion,baseRevision);
  else verifyServedDesign(raw,plan,axeVersion,readDesignBaseline(process.env.JARVIS_CHECKS!));
  console.log(`JARVIS-CHECK-COMPLETE ${readFileSync(process.env.JARVIS_COMPLETION_FILE!,"utf8").trim()}`);
}
if(process.argv[1]&&pathToFileURL(realpathSync(process.argv[1])).href===import.meta.url) {
  try {main();} catch(error) {console.error(String(error));process.exitCode=1;}
}
