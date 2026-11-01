import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runGate, type GateInput, type GateResult } from "../checks/gate.ts";
import type { ChecksStore } from "../checks/store.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readPlanningFile } from "../runner/checks-author.ts";
import { DesignBrowserPlanSchema, type DesignBrowserPlan } from "../review/design-browser.ts";
import { baselineFromObservation } from "./design-gate.ts";
import { installDesignChecks } from "./impeccable-install.ts";
import { installQaToolchain, type QaInstallInput } from "./qa-install.ts";
import { DESIGN_ORIGIN } from "./served-design.ts";
import { ServedAppSchema } from "./served-app.ts";
import { designLintPath } from "./design-lint-driver.ts";

const path = z.string().refine(designLintPath,"invalid eval design path"), hash=z.string().regex(/^[a-f0-9]{64}$/);
const page = z.string().refine(value=>value.startsWith("/")&&!value.startsWith("//")&&!/[\\\x00-\x20]/.test(value),"expected app-relative page path");
const Plan = z.object({
  version:z.literal(1), qa:z.object({source:path,manifestSha256:hash}).strict(),
  engine:z.object({file:path,version:z.string().regex(/^\d+\.\d+\.\d+$/),sha256:hash}).strict(),
  scanner:z.object({files:z.array(path).min(1).max(256),path:page}).strict(),
  plan:DesignBrowserPlanSchema, app:ServedAppSchema,
}).strict();
export interface EvalDesignPlan { declaration:z.infer<typeof Plan>; qa:QaInstallInput; engine:string; plan:DesignBrowserPlan }
const sha=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");

/** tasks/<id>/design-checks.json contains only runner-owned plans and relative, hash-pinned inputs. */
export function readEvalDesignPlan(evalsRepo:string,taskId:string):EvalDesignPlan|undefined {
  const root=realpathSync(evalsRepo), file=`tasks/${taskId}/design-checks.json`;
  if(!existsSync(join(root,file)))return undefined;
  const declaration=Plan.parse(JSON.parse(readPlanningFile(root,file)));
  const manifestText=readPlanningFile(root,`${declaration.qa.source}/manifest.json`);
  if(sha(manifestText)!==declaration.qa.manifestSha256)throw new Error("eval QA manifest differs from its pin");
  const plan={...declaration.plan,flows:declaration.plan.flows.map(flow=>({...flow,url:`${DESIGN_ORIGIN}${page.parse(flow.url)}`,...(flow.finalUrl?{finalUrl:`${DESIGN_ORIGIN}${page.parse(flow.finalUrl)}`}:{})}))};
  const engine=join(root,declaration.engine.file);
  // The engine may be binary, so do not pass it through the authored UTF-8 reader.
  const stat=lstatSync(engine);
  if(!stat.isFile()||stat.nlink!==1||stat.size>256*1024*1024||realpathSync(engine)!==engine)throw new Error("invalid eval Impeccable engine");
  if(sha(readFileSync(engine))!==declaration.engine.sha256)throw new Error("eval Impeccable engine differs from its pin");
  return {declaration,plan,engine,qa:{source:join(root,declaration.qa.source),manifest:JSON.parse(manifestText) as QaInstallInput["manifest"]}};
}

/** Install after the hidden project suite and lint checks; approval is a separate runner step. */
export function installEvalDesignChecks(store:ChecksStore,input:EvalDesignPlan,axeVersion:string):ReturnType<typeof installDesignChecks> {
  if(input.qa.manifest.axe.version!==axeVersion)throw new Error("eval lint and browser axe pins differ");
  const tools=installQaToolchain(store,input.qa);
  return installDesignChecks(store,{nodeBin:process.execPath,axeVersion,app:input.declaration.app,plan:input.plan,scanner:{
    pin:{bin:input.engine,version:input.declaration.engine.version,sha256:input.declaration.engine.sha256},files:input.declaration.scanner.files,
    browser:{manifest:tools.manifestPath,manifestHash:tools.manifestHash,url:`${DESIGN_ORIGIN}${input.declaration.scanner.path}`,port:1},
  }});
}

/** runGate owns the fresh base checkout, case sandbox, stdout capture and evidence hashes. */
export async function captureDesignBaseline(input:GateInput,axeVersion:string,gate:(input:GateInput)=>Promise<GateResult>=runGate):Promise<boolean> {
  if(!/^[a-f0-9]{40}$/.test(input.revision))throw new Error("base capture requires a full revision");
  const baselineFile=join(input.store.checksDir,"expected/axe-base.json");
  if(existsSync(baselineFile))throw new Error("axe baseline already installed");
  if(!input.store.verify(input.ledger).ok)throw new Error("base capture needs approved checks");
  const check={...input.check,name:"design-base",verify:`${input.check.verify} '${input.revision}'`};
  // Base evidence is not a build-task event: the loop reducer requires task_created before gate_result.
  const projectDir=join(input.projectDir,"design-base"), ledger=Ledger.open(projectDir);
  const approval=input.ledger.entries().filter(entry=>entry.kind==="checks_approved").at(-1)!;
  ledger.append({kind:"checks_approved",actor:"runner",data:approval.data});
  const result=await gate({...input,check,ledger,projectDir});
  if(result.status!=="pass")return false;
  const data=result.entry.data as {revision?:string;evidence?:{dir:string;files:Record<string,string>}};
  const file="cases/capture/stdout", digest=data.evidence?.files[file];
  if(data.revision!==input.revision||!digest||data.evidence?.dir!==result.evidenceDir)throw new Error("base capture lacks bound runner evidence");
  const stdoutPath=join(result.evidenceDir,file), stat=lstatSync(stdoutPath);
  if(!stat.isFile()||stat.nlink!==1||stat.size>16*1024*1024)throw new Error("invalid base capture stdout");
  const stdout=readFileSync(stdoutPath);
  if(sha(stdout)!==digest)throw new Error("base capture changed after the gate");
  const plan=JSON.parse(readPlanningFile(input.store.checksDir,"design-plan.json")) as DesignBrowserPlan;
  let baseline;
  try {baseline=baselineFromObservation(JSON.parse(stdout.toString()),plan,axeVersion,input.revision);} catch {return false;}
  if(!input.store.verify(input.ledger).ok)throw new Error("checks changed during base capture");
  mkdirSync(join(input.store.checksDir,"expected"),{recursive:true,mode:0o700});
  writeFileSync(baselineFile,JSON.stringify({...baseline,stdout:stdout.toString()}),{flag:"wx",mode:0o600});
  input.store.approve(input.ledger,"runner axe observation of the fresh base revision");
  return true;
}
